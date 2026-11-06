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

export function parseActionTokens(actionStr: string): string[] {
  const args: string[] = [];
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match;
  while ((match = regex.exec(actionStr)) !== null) {
    if (match[1] !== undefined) args.push(match[1]);
    else if (match[2] !== undefined) args.push(match[2]);
    else args.push(match[0]);
  }
  return args;
}

export function parseBatchAction(tabId: string, actionStr: string): TabActionRequest {
  const tokens = parseActionTokens(actionStr);
  if (tokens.length === 0) throw new Error('empty action string in batch');
  const sub = tokens[0]!.toLowerCase();
  switch (sub) {
    case 'click':
      if (tokens.length < 2) throw new Error('missing target for click');
      return { type: 'tab.click', tabId, target: tokens[1]! };
    case 'fill':
      if (tokens.length < 3) throw new Error('fill requires <target> <value>');
      return { type: 'tab.fill', tabId, target: tokens[1]!, value: tokens.slice(2).join(' ') };
    case 'press':
      if (tokens.length < 2) throw new Error('missing key for press');
      return { type: 'tab.press', tabId, key: tokens[1]!, ...(tokens[2] ? { target: tokens[2] } : {}) };
    case 'goto':
      if (tokens.length < 2) throw new Error('missing url for goto');
      return { type: 'tab.goto', tabId, url: tokens[1]! };
    case 'back':
      return { type: 'tab.back', tabId };
    case 'scroll':
      return { type: 'tab.scroll', tabId, direction: (tokens[1] as 'down' | 'up' | 'bottom') ?? 'down' };
    case 'outline': {
      let interactive = false;
      let scope: string | undefined;
      let depth: number | undefined;
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i] === '-i' || tokens[i] === '--interactive') interactive = true;
        else if (tokens[i] === '-s' || tokens[i] === '--scope') scope = tokens[++i];
        else if (tokens[i] === '-d' || tokens[i] === '--depth') depth = Number(tokens[++i]);
      }
      return { type: 'tab.outline', tabId, interactive, scope, depth };
    }
    case 'find':
      if (tokens.length < 2) throw new Error('missing text for find');
      return { type: 'tab.find', tabId, text: tokens.slice(1).join(' ') };
    case 'html':
      if (tokens.length < 2) throw new Error('missing target for html');
      return { type: 'tab.html', tabId, target: tokens[1]! };
    case 'eval':
      if (tokens.length < 2) throw new Error('missing expression for eval');
      return { type: 'tab.eval', tabId, expression: tokens.slice(1).join(' ') };
    case 'get': {
      const mode = tokens[1]?.toLowerCase();
      if (mode !== 'text' && mode !== 'attr' && mode !== 'value') throw new Error(`invalid get mode: ${mode}`);
      const target = tokens[2];
      if (!target) throw new Error('missing target for get');
      const attr = mode === 'attr' ? tokens[3] : undefined;
      return { type: 'tab.get', tabId, mode, target, attr };
    }
    case 'wait': {
      if (tokens.length < 2) throw new Error('wait requires milliseconds or --text/--url');
      if (tokens[1] === '--text') return { type: 'tab.wait', tabId, text: tokens.slice(2).join(' ') };
      if (tokens[1] === '--url') return { type: 'tab.wait', tabId, url: tokens[2] };
      const ms = Number(tokens[1]);
      if (Number.isNaN(ms)) throw new Error(`invalid wait parameter: ${tokens[1]}`);
      return { type: 'tab.wait', tabId, ms };
    }
    case 'route':
      if (tokens.length < 2) throw new Error('missing pattern for route');
      return { type: 'tab.route', tabId, pattern: tokens[1]!, abort: true };
    case 'unroute':
      return { type: 'tab.unroute', tabId, pattern: tokens[1] };
    default:
      throw new Error(`unknown command in batch: "${sub}"`);
  }
}

async function executeWaitOnTab(tab: InteractiveTab, req: { text?: string; url?: string; ms?: number; timeoutMs?: number }): Promise<void> {
  const timeout = req.timeoutMs ?? 30_000;
  if (req.ms !== undefined) {
    await new Promise((r) => setTimeout(r, req.ms));
  } else if (req.url !== undefined) {
    if (tab.session.wait) {
      await tab.session.wait({ url: req.url, timeoutMs: timeout });
    } else {
      const page = (tab.session as any).page;
      if (page?.waitForURL) {
        await page.waitForURL(req.url, { timeout });
      } else {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const cur = await tab.session.url().catch(() => '');
          if (cur.includes(req.url)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
  } else if (req.text !== undefined) {
    if (tab.session.wait) {
      await tab.session.wait({ text: req.text, timeoutMs: timeout });
    } else {
      const page = (tab.session as any).page;
      if (page?.locator) {
        await page.locator(`text=${req.text}`).first().waitFor({ timeout });
      } else {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const body = await tab.session.pageText().catch(() => '');
          if (body.includes(req.text)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
  }
  const info = await tab.session.settle({ timeoutMs: 5000 }).catch(() => null);
  if (info) {
    tab.title = info.title;
    tab.outlineUrl = info.url;
  }
}

async function executeTabOperation(
  tab: InteractiveTab,
  req: TabActionRequest,
  visualOverride?: boolean,
): Promise<TabActionResponse> {
  switch (req.type) {
    case 'tab.goto': {
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
    }

    case 'tab.back': {
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
    }

    case 'tab.outline': {
      const tree = await tab.session.snapshot();
      const budget = req.budgetTokens ?? 12_000;
      const outline = buildOutline(tree, budget, estimateTokens, {
        interactive: req.interactive,
        scope: req.scope,
        depth: req.depth,
      });
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
    }

    case 'tab.find': {
      if (!tab.lastOutline) {
        const tree = await tab.session.snapshot();
        tab.lastOutline = buildOutline(tree, 12_000, estimateTokens);
      }
      const matches = tab.lastOutline.find(req.text);
      return { type: 'tab.find', tabId: tab.tabId, matches };
    }

    case 'tab.html': {
      const { ref, node } = await resolveTarget(tab, req.target);
      let html: string;
      if (node) {
        html = outerHtml(node as AnnotatedNode).slice(0, 2000);
      } else {
        html = (await tab.session.read(ref, { mode: 'html' })).slice(0, 2000);
      }
      return { type: 'tab.html', tabId: tab.tabId, html };
    }

    case 'tab.get': {
      const { ref } = await resolveTarget(tab, req.target);
      let value: string;
      if (req.mode === 'attr') {
        if (!req.attr) throw new Error('attribute name is required for get attr');
        value = await tab.session.read(ref, { mode: 'text', attr: req.attr });
      } else if (req.mode === 'value') {
        const loc = (ref as { locator?: { evaluate: (fn: (el: any) => string) => Promise<string> } }).locator;
        if (loc) {
          value = await loc.evaluate((el: any) => el.value !== undefined ? String(el.value) : (el.getAttribute('value') ?? ''));
        } else {
          value = await tab.session.read(ref, { mode: 'text', attr: 'value' });
        }
      } else {
        value = await tab.session.read(ref, { mode: 'text' });
      }
      return { type: 'tab.get', tabId: tab.tabId, value };
    }

    case 'tab.click': {
      const { ref } = await resolveTarget(tab, req.target);
      const isVisual = visualOverride ?? req.visual ?? tab.visual;
      if (isVisual) {
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
    }

    case 'tab.fill': {
      const { ref } = await resolveTarget(tab, req.target);
      const isVisual = visualOverride ?? req.visual ?? tab.visual;
      if (isVisual) {
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
    }

    case 'tab.press': {
      let ref: ElementRef | undefined;
      if (req.target) {
        const resolved = await resolveTarget(tab, req.target);
        ref = resolved.ref;
        const isVisual = visualOverride ?? req.visual ?? tab.visual;
        if (isVisual) {
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
    }

    case 'tab.scroll': {
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
    }

    case 'tab.wait': {
      await executeWaitOnTab(tab, req);
      return {
        type: 'tab.page',
        tabId: tab.tabId,
        url: tab.outlineUrl ?? '',
        title: tab.title ?? '',
        message: 'waited successfully',
      };
    }

    case 'tab.route': {
      if (tab.session.route) {
        await tab.session.route(req.pattern, 'abort');
      }
      return {
        type: 'tab.page',
        tabId: tab.tabId,
        url: tab.outlineUrl ?? '',
        title: tab.title ?? '',
        message: `routed ${req.pattern} (abort)`,
      };
    }

    case 'tab.unroute': {
      if (tab.session.unroute) {
        await tab.session.unroute(req.pattern);
      }
      return {
        type: 'tab.page',
        tabId: tab.tabId,
        url: tab.outlineUrl ?? '',
        title: tab.title ?? '',
        message: req.pattern ? `unrouted ${req.pattern}` : 'unrouted all routes',
      };
    }

    case 'tab.eval': {
      const result = await tab.session.evaluate(req.expression);
      return { type: 'tab.eval', tabId: tab.tabId, result };
    }

    case 'tab.download': {
      const since = tab.session.downloadMark();
      if (req.target) {
        const { ref } = await resolveTarget(tab, req.target);
        const isVisual = visualOverride ?? req.visual ?? tab.visual;
        if (isVisual) {
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
    }

    default:
      throw new Error(`unsupported operation in tab: ${(req as any).type}`);
  }
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
        if (req.label !== undefined) {
          if (!/^[a-zA-Z0-9_-]+$/.test(req.label) || /^tab_\d+$/.test(req.label)) {
            throw new Error(`invalid label "${req.label}": must be alphanumeric with - or _, and cannot match tab_<n>`);
          }
          const existing = scheduler.getTab(req.label);
          if (existing) {
            throw new Error(`label "${req.label}" is already in use by tab ${existing.tab.tabId}`);
          }
        }

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
          label: req.label,
          visual: req.visual ?? true,
          humanize: req.humanize,
          timeoutMs: req.timeoutMs,
        });

        if (req.visual !== false) {
          await injectVisualFeedback(tab.session).catch(() => {});
        }

        const summary: TabSummary = {
          tabId: tab.tabId,
          ...(tab.label ? { label: tab.label } : {}),
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

      case 'tab.batch': {
        const found = scheduler.getTab(req.tabId);
        if (!found) return { type: 'tab.error', message: `tab not found: ${req.tabId}`, exitCode: 1 };
        const { tab } = found;
        return await runWithTabLock(tab, async () => {
          const results: TabActionResponse[] = [];
          for (const actionStr of req.actions) {
            try {
              const subReq = parseBatchAction(tab.tabId, actionStr);
              const res = await executeTabOperation(tab, subReq, req.visual);
              results.push(res);
              if (res.type === 'tab.error') {
                return { type: 'tab.batch', tabId: tab.tabId, results, error: res.message };
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return { type: 'tab.batch', tabId: tab.tabId, results, error: msg };
            }
          }
          return { type: 'tab.batch', tabId: tab.tabId, results };
        });
      }

      case 'tab.goto':
      case 'tab.back':
      case 'tab.outline':
      case 'tab.find':
      case 'tab.html':
      case 'tab.get':
      case 'tab.click':
      case 'tab.fill':
      case 'tab.press':
      case 'tab.scroll':
      case 'tab.wait':
      case 'tab.route':
      case 'tab.unroute':
      case 'tab.eval':
      case 'tab.download': {
        const found = scheduler.getTab(req.tabId);
        if (!found) return { type: 'tab.error', message: `tab not found: ${req.tabId}`, exitCode: 1 };
        const { tab } = found;
        return await runWithTabLock(tab, () => executeTabOperation(tab, req));
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
          const found = scheduler.getTab(req.tabId);
          const canonicalId = found?.tab.tabId ?? req.tabId;
          const ok = await scheduler.closeTab(req.tabId);
          return { type: 'tab.closed', closed: ok ? [canonicalId] : [] };
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
