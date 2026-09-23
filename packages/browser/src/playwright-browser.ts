import {
  TimeoutError,
  type BrowserPort,
  type ElementRef,
  type GotoOptions,
  type OpenOptions,
  type PageInfo,
  type ReadOptions,
  type SelectorCandidate,
  type SerializedNode,
  type Session,
} from '@webscoop/core';
import { chromium, errors, type BrowserContext, type Locator, type Page } from 'playwright';

/** Launch flags that keep Chromium from advertising automation. */
export const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled'];
export const IGNORED_DEFAULT_ARGS = ['--enable-automation'];

export interface PlaywrightBrowserOptions {
  /** Chromium binary to use instead of the build Playwright downloaded. */
  executablePath?: string;
  /** Timeout for element operations after navigation, in ms. Default 5000. */
  actionTimeoutMs?: number;
}

class PwRef implements ElementRef {
  constructor(
    readonly locator: Locator,
    readonly description: string,
  ) {}
}

type Root = Page | Locator;

function locate(root: Root, candidate: SelectorCandidate): Locator {
  const { value } = candidate;
  switch (candidate.strategy) {
    case 'role': {
      const bar = value.indexOf('|');
      const role = (bar === -1 ? value : value.slice(0, bar)) as Parameters<Page['getByRole']>[0];
      return bar === -1 ? root.getByRole(role) : root.getByRole(role, { name: value.slice(bar + 1), exact: true });
    }
    case 'testid':
      return root.getByTestId(value);
    case 'id':
      return root.locator(`css=[id=${JSON.stringify(value)}]`);
    case 'text':
      return root.getByText(value, { exact: true });
    case 'css':
      return root.locator(`css=${value}`);
    case 'xpath':
      return root.locator(`xpath=${value}`);
  }
}

/** Runs in the page: serialize an element subtree into `SerializedNode` form. */
function serializeInPage(element: Element | null): SerializedNode {
  const walk = (node: Node): SerializedNode | null => {
    if (node.nodeType === Node.TEXT_NODE) return { type: 'text', text: node.textContent ?? '' };
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const el = node as Element;
    const attrs: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) attrs[attr.name] = attr.value;
    const children: SerializedNode[] = [];
    for (const child of Array.from(el.childNodes)) {
      const out = walk(child);
      if (out) children.push(out);
    }
    return { type: 'element', tag: el.tagName.toLowerCase(), attrs, children };
  };
  return walk(element ?? document.documentElement) ?? { type: 'text', text: '' };
}

class PlaywrightSession implements Session {
  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {}

  async goto(url: string, opts: GotoOptions): Promise<PageInfo> {
    const deadline = Date.now() + opts.timeoutMs;
    try {
      const response = await this.page.goto(url, { waitUntil: 'load', timeout: opts.timeoutMs });
      await this.page.waitForLoadState('networkidle', { timeout: Math.max(1, deadline - Date.now()) });
      return { url: this.page.url(), title: await this.page.title(), status: response?.status() ?? null };
    } catch (error) {
      if (error instanceof errors.TimeoutError) {
        throw new TimeoutError(`navigation to ${url} timed out after ${opts.timeoutMs} ms`);
      }
      throw error;
    }
  }

  async resolve(candidate: SelectorCandidate, within?: ElementRef): Promise<ElementRef[]> {
    const scope = within ? (within as PwRef) : undefined;
    const locator = locate(scope?.locator ?? this.page, candidate);
    const count = await locator.count();
    const prefix = `${scope ? `${scope.description} >> ` : ''}${candidate.strategy}=${candidate.value}`;
    return Array.from({ length: count }, (_, i) => new PwRef(locator.nth(i), `${prefix} >> nth=${i}`));
  }

  async read(ref: ElementRef, opts: ReadOptions): Promise<string> {
    const { locator } = ref as PwRef;
    if (opts.attr) return (await locator.getAttribute(opts.attr)) ?? '';
    if (opts.mode === 'html') return locator.innerHTML();
    return (await locator.textContent()) ?? '';
  }

  async same(a: ElementRef, b: ElementRef): Promise<boolean> {
    const [ha, hb] = await Promise.all([(a as PwRef).locator.elementHandle(), (b as PwRef).locator.elementHandle()]);
    try {
      if (!ha || !hb) return false;
      return await this.page.evaluate(([x, y]) => x === y, [ha, hb] as const);
    } finally {
      await Promise.all([ha?.dispose(), hb?.dispose()]);
    }
  }

  async snapshot(within?: ElementRef): Promise<SerializedNode> {
    if (within) return (within as PwRef).locator.evaluate(serializeInPage);
    return this.page.evaluate(serializeInPage, null);
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

/** `BrowserPort` over a headed, persistent Playwright Chromium context. */
export class PlaywrightBrowser implements BrowserPort {
  constructor(private readonly options: PlaywrightBrowserOptions = {}) {}

  async open(profileDir: string, opts: OpenOptions = {}): Promise<Session> {
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: null,
      // The CLI owns SIGINT: it aborts the run, closes the context, and releases the profile lock.
      handleSIGINT: false,
      ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
      ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
      args: [...STEALTH_ARGS, ...(opts.args ?? [])],
    });
    try {
      context.setDefaultTimeout(this.options.actionTimeoutMs ?? 5000);
      const page = context.pages()[0] ?? (await context.newPage());
      return new PlaywrightSession(context, page);
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }
}

/** Path of the Chromium build this Playwright version expects. */
export function expectedChromiumPath(): string {
  return chromium.executablePath();
}
