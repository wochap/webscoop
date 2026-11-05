import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  buildOutline,
  estimateTokens,
  outerHtml,
  refForNode,
  type AnnotatedNode,
  type ElementRef,
  type SelectorCandidate,
} from '@webscoop/core';
import { clickRipple, flashElement, injectVisualFeedback } from '@webscoop/browser';
import type { TabActionRequest, TabActionResponse, TabSummary } from './protocol';
import { type InteractiveTab, type LaunchedBrowser, type Scheduler, runWithTabLock } from './scheduler';
import type { CliIo, TabOptions } from '../context';
import { loadConfig } from '../config';
import { resolvePaths } from '../paths';
import { prepareProfile, writeMarker } from '../profiles';
import { acquireProfileLock } from '../lock';
import { BROWSER_PID_DEADLINE_MS } from '../commands/run';

export async function resolveTarget(
  tab: InteractiveTab,
  targetStr: string,
): Promise<{ ref: ElementRef; node?: AnnotatedNode }> {
  const trimmed = targetStr.trim();
  const refMatch = trimmed.match(/^\[?(e\d+)\]?$/);
  if (refMatch) {
    const refKey = refMatch[1]!;
    if (!tab.lastOutline) {
      throw new Error(`stale reference ${refKey}: no outline cached; run \`webscoop tab outline ${tab.tabId}\` first`);
    }
    const node = tab.lastOutline.node(refKey);
    if (!node) {
      throw new Error(`stale reference ${refKey}: element not in cached outline; run \`webscoop tab outline ${tab.tabId}\``);
    }
    const elementRef = await refForNode(tab.session, node).catch(() => null);
    if (!elementRef) {
      throw new Error(`stale reference ${refKey}: DOM has changed or navigated; run \`webscoop tab outline ${tab.tabId}\``);
    }
    return { ref: elementRef, node };
  }

  let candidate: SelectorCandidate;
  const prefixMatch = trimmed.match(/^(css|xpath|text|role|id|testid)=(.*)$/);
  if (prefixMatch) {
    candidate = {
      strategy: prefixMatch[1] as SelectorCandidate['strategy'],
      value: prefixMatch[2]!,
      stability: 'stable',
    };
  } else if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('(/')) {
    candidate = {
      strategy: 'xpath',
      value: trimmed,
      stability: 'stable',
    };
  } else {
    candidate = {
      strategy: 'css',
      value: trimmed,
      stability: 'stable',
    };
  }

  const refs = await tab.session.resolve(candidate);
  if (refs.length === 0) {
    throw new Error(`target not found: "${trimmed}"`);
  }
  return { ref: refs[0]! };
}

export async function handleTabAction(
  scheduler: Scheduler,
  baseIo: CliIo,
  req: TabActionRequest,
): Promise<TabActionResponse> {
  try {
    switch (req.type) {
      case 'tab.open': {
        const profile = req.profile ?? 'default';
        const clientIo: CliIo = {
          ...baseIo,
          cwd: req.cwd,
          env: req.env,
        };
        const paths = resolvePaths(clientIo.env, clientIo.homedir);
        const config = await loadConfig(paths);
        const { profileDir, browser } = await prepareProfile(clientIo, config, paths, profile);

        const launcher = async (_signal: AbortSignal): Promise<LaunchedBrowser> => {
          const lock = await acquireProfileLock(profileDir, { timeoutMs: 0, profileName: profile });
          try {
            let handle;
            if (clientIo.launchBrowser) {
              handle = await clientIo.launchBrowser(config, clientIo.env, browser, profileDir, { bypassCSP: true });
            } else {
              const port = await clientIo.createBrowser(config, clientIo.env, browser);
              const listeners = new Set<() => void>();
              handle = {
                newSession: (tabOpts: TabOptions) => port.open(profileDir, { bypassCSP: true, ...tabOpts }),
                close: async () => listeners.forEach((cb) => cb()),
                onClosed: (cb: () => void) => {
                  listeners.add(cb);
                  return () => listeners.delete(cb);
                },
              };
            }
            await writeMarker(profileDir, browser, browser.version).catch(() => {});
            const pid = await clientIo.findBrowserPid(resolve(profileDir), BROWSER_PID_DEADLINE_MS).catch(() => null);
            return {
              handle,
              pid,
              release: () => lock.release(),
            };
          } catch (err) {
            lock.release();
            throw err;
          }
        };

        const tab = await scheduler.openInteractiveTab(profileDir, profile, launcher, {
          url: req.url,
          visual: req.visual ?? true,
          humanize: req.humanize,
          timeoutMs: req.timeoutMs,
        });

        if (req.visual !== false) {
          await injectVisualFeedback(tab.session).catch(() => {});
        }

        const summary: TabSummary = {
          tabId: tab.tabId,
          profile: tab.profile,
          url: tab.outlineUrl ?? '',
          title: tab.title ?? '',
          isPopup: tab.isPopup,
          openerTabId: tab.openerTabId,
        };
        return { type: 'tab.opened', tab: summary };
      }

      case 'tab.list': {
        const tabs = scheduler.allTabs(req.profile);
        return { type: 'tab.list', tabs };
      }

      case 'tab.goto': {
        const found = scheduler.getTab(req.tabId);
        if (!found) return { type: 'tab.error', message: `tab not found: ${req.tabId}`, exitCode: 1 };
        const { tab } = found;
        return await runWithTabLock(tab, async () => {
          tab.lastOutline = null;
          const info = await tab.session.goto(req.url, { timeoutMs: req.timeoutMs ?? 30_000 });
          tab.title = info.title;
          tab.outlineUrl = info.url;
          tab.history.push(info.url);
          return {
            type: 'tab.page',
            tabId: tab.tabId,
            url: tab.outlineUrl,
            title: tab.title,
            message: `navigated to ${info.url}`,
          };
        });
      }

      case 'tab.back': {
        const found = scheduler.getTab(req.tabId);
        if (!found) return { type: 'tab.error', message: `tab not found: ${req.tabId}`, exitCode: 1 };
        const { tab } = found;
        return await runWithTabLock(tab, async () => {
          tab.lastOutline = null;
          if (tab.history.length > 1) {
            tab.history.pop();
            const prev = tab.history[tab.history.length - 1]!;
            await tab.session.evaluate('window.history.back()').catch(() => {});
            const info = await tab.session.settle({ timeoutMs: req.timeoutMs ?? 30_000 }).catch(async () => {
              return await tab.session.goto(prev, { timeoutMs: req.timeoutMs ?? 30_000 });
            });
            tab.title = info.title;
            tab.outlineUrl = info.url;
          } else {
            await tab.session.evaluate('window.history.back()').catch(() => {});
            const info = await tab.session.settle({ timeoutMs: req.timeoutMs ?? 30_000 });
            tab.title = info.title;
            tab.outlineUrl = info.url;
          }
          return {
            type: 'tab.page',
            tabId: tab.tabId,
            url: tab.outlineUrl,
            title: tab.title,
            message: `went back to ${tab.outlineUrl}`,
          };
        });
      }

      case 'tab.outline': {
        const found = scheduler.getTab(req.tabId);
        if (!found) return { type: 'tab.error', message: `tab not found: ${req.tabId}`, exitCode: 1 };
        const { tab } = found;
        return await runWithTabLock(tab, async () => {
          const tree = await tab.session.snapshot();
          const budget = req.budgetTokens ?? 12_000;
          const outline = buildOutline(tree, budget, estimateTokens);
          tab.lastOutline = outline;
          tab.title = await tab.session.title().catch(() => tab.title ?? '');
          tab.outlineUrl = await tab.session.url().catch(() => tab.outlineUrl ?? '');
          return {
            type: 'tab.outline',
            tabId: tab.tabId,
            url: tab.outlineUrl,
            title: tab.title,
            outline: outline.text,
            cut: outline.cut,
          };
        });
      }

      case 'tab.find': {
        const found = scheduler.getTab(req.tabId);
        if (!found) return { type: 'tab.error', message: `tab not found: ${req.tabId}`, exitCode: 1 };
        const { tab } = found;
        return await runWithTabLock(tab, async () => {
          if (!tab.lastOutline) {
            const tree = await tab.session.snapshot();
            tab.lastOutline = buildOutline(tree, 12_000, estimateTokens);
          }
          const matches = tab.lastOutline.find(req.text);
          return { type: 'tab.find', tabId: tab.tabId, matches };
        });
      }

      case 'tab.html': {
        const found = scheduler.getTab(req.tabId);
        if (!found) return { type: 'tab.error', message: `tab not found: ${req.tabId}`, exitCode: 1 };
        const { tab } = found;
        return await runWithTabLock(tab, async () => {
          const { ref, node } = await resolveTarget(tab, req.target);
          let html: string;
          if (node) {
            html = outerHtml(node as AnnotatedNode).slice(0, 2000);
          } else {
            html = (await tab.session.read(ref, { mode: 'html' })).slice(0, 2000);
          }
          return { type: 'tab.html', tabId: tab.tabId, html };
        });
      }

      case 'tab.click': {
        const found = scheduler.getTab(req.tabId);
        if (!found) return { type: 'tab.error', message: `tab not found: ${req.tabId}`, exitCode: 1 };
        const { tab } = found;
        return await runWithTabLock(tab, async () => {
          const { ref } = await resolveTarget(tab, req.target);
          if (req.visual ?? tab.visual) {
            await flashElement(tab.session, ref, req.target);
            const geom = await tab.session.geometry(ref);
            if (geom.w > 0 && geom.h > 0) {
              await clickRipple(tab.session, geom.x + geom.w / 2, geom.y + geom.h / 2);
            }
          }
          await tab.session.click(ref);
          const info = await tab.session.settle({ timeoutMs: req.timeoutMs ?? 30_000 });
          tab.title = info.title;
          tab.outlineUrl = info.url;
          if (info.url !== tab.history[tab.history.length - 1]) {
            tab.history.push(info.url);
            tab.lastOutline = null;
          }
          return {
            type: 'tab.page',
            tabId: tab.tabId,
            url: tab.outlineUrl,
            title: tab.title,
            message: `clicked ${req.target}`,
          };
        });
      }

      case 'tab.fill': {
        const found = scheduler.getTab(req.tabId);
        if (!found) return { type: 'tab.error', message: `tab not found: ${req.tabId}`, exitCode: 1 };
        const { tab } = found;
        return await runWithTabLock(tab, async () => {
          const { ref } = await resolveTarget(tab, req.target);
          if (req.visual ?? tab.visual) {
            await flashElement(tab.session, ref, `fill ${req.target}`);
          }
          await tab.session.fill(ref, req.value);
          const info = await tab.session.settle({ timeoutMs: req.timeoutMs ?? 30_000 });
          tab.title = info.title;
          tab.outlineUrl = info.url;
          return {
            type: 'tab.page',
            tabId: tab.tabId,
            url: tab.outlineUrl,
            title: tab.title,
            message: `filled ${req.target}`,
          };
        });
      }

      case 'tab.press': {
        const found = scheduler.getTab(req.tabId);
        if (!found) return { type: 'tab.error', message: `tab not found: ${req.tabId}`, exitCode: 1 };
        const { tab } = found;
        return await runWithTabLock(tab, async () => {
          let ref: ElementRef | undefined;
          if (req.target) {
            const resolved = await resolveTarget(tab, req.target);
            ref = resolved.ref;
            if (req.visual ?? tab.visual) {
              await flashElement(tab.session, ref, `press ${req.key}`);
            }
          }
          await tab.session.press(req.key, ref);
          const info = await tab.session.settle({ timeoutMs: req.timeoutMs ?? 30_000 });
          tab.title = info.title;
          tab.outlineUrl = info.url;
          return {
            type: 'tab.page',
            tabId: tab.tabId,
            url: tab.outlineUrl,
            title: tab.title,
            message: `pressed ${req.key}`,
          };
        });
      }

      case 'tab.scroll': {
        const found = scheduler.getTab(req.tabId);
        if (!found) return { type: 'tab.error', message: `tab not found: ${req.tabId}`, exitCode: 1 };
        const { tab } = found;
        return await runWithTabLock(tab, async () => {
          if (req.direction === 'bottom') {
            await tab.session.scrollToBottom();
          } else {
            await tab.session.scrollBy(req.direction);
          }
          const info = await tab.session.settle({ timeoutMs: req.timeoutMs ?? 30_000 });
          tab.title = info.title;
          tab.outlineUrl = info.url;
          return {
            type: 'tab.page',
            tabId: tab.tabId,
            url: tab.outlineUrl,
            title: tab.title,
            message: `scrolled ${req.direction}`,
          };
        });
      }

      case 'tab.eval': {
        const found = scheduler.getTab(req.tabId);
        if (!found) return { type: 'tab.error', message: `tab not found: ${req.tabId}`, exitCode: 1 };
        const { tab } = found;
        return await runWithTabLock(tab, async () => {
          const result = await tab.session.evaluate(req.expression);
          return { type: 'tab.eval', tabId: tab.tabId, result };
        });
      }

      case 'tab.download': {
        const found = scheduler.getTab(req.tabId);
        if (!found) return { type: 'tab.error', message: `tab not found: ${req.tabId}`, exitCode: 1 };
        const { tab } = found;
        return await runWithTabLock(tab, async () => {
          const since = tab.session.downloadMark();
          if (req.target) {
            const { ref } = await resolveTarget(tab, req.target);
            if (req.visual ?? tab.visual) {
              await flashElement(tab.session, ref, `download ${req.target}`);
              const geom = await tab.session.geometry(ref);
              if (geom.w > 0 && geom.h > 0) {
                await clickRipple(tab.session, geom.x + geom.w / 2, geom.y + geom.h / 2);
              }
            }
            await tab.session.click(ref);
          } else if (req.url) {
            await tab.session.goto(req.url, { timeoutMs: req.timeoutMs ?? 30_000 }).catch(() => {});
          } else {
            throw new Error('either target or url must be provided for tab.download');
          }

          const saved = await tab.session.nextDownload({ since, timeoutMs: req.timeoutMs ?? 30_000 });
          const outPath = req.outPath;
          await mkdir(dirname(outPath), { recursive: true });
          if (existsSync(saved.file)) {
            try {
              await rename(saved.file, outPath);
            } catch (err: unknown) {
              if ((err as { code?: string })?.code === 'EXDEV') {
                await copyFile(saved.file, outPath);
                await unlink(saved.file).catch(() => {});
              } else {
                throw err;
              }
            }
          } else {
            await writeFile(outPath, Buffer.alloc(saved.bytes));
          }
          const fileStats = await stat(outPath).catch(() => ({ size: saved.bytes }));
          return {
            type: 'tab.download',
            tabId: tab.tabId,
            file: outPath,
            bytes: fileStats.size,
            url: saved.url,
          };
        });
      }

      case 'tab.attend': {
        const found = scheduler.getTab(req.tabId);
        if (!found) return { type: 'tab.error', message: `tab not found: ${req.tabId}`, exitCode: 1 };
        const { slot, tab } = found;
        const lease = await slot.attention.acquire(tab.tabId);
        try {
          await tab.session.focus();
          await tab.session.setTitle(`[ATTENTION] ${tab.title ?? 'tab'}`);
          return {
            type: 'tab.page',
            tabId: tab.tabId,
            url: tab.outlineUrl ?? '',
            title: tab.title ?? '',
            message: 'attention granted',
          };
        } finally {
          lease.release();
        }
      }

      case 'tab.close': {
        if (req.all) {
          const closed = await scheduler.closeAllTabs(req.profile);
          return { type: 'tab.closed', closed };
        }
        if (req.tabId) {
          const ok = await scheduler.closeTab(req.tabId);
          return { type: 'tab.closed', closed: ok ? [req.tabId] : [] };
        }
        return { type: 'tab.closed', closed: [] };
      }
    }
  } catch (error: unknown) {
    return {
      type: 'tab.error',
      message: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }
}
