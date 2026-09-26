import {
  PAGE_GLOBAL,
  TimeoutError,
  type BrowserPort,
  type ElementRef,
  type Geometry,
  type GotoOptions,
  type InteractiveSession,
  type OpenOptions,
  PAGE_TEXT_LIMIT,
  type PageInfo,
  type ReadOptions,
  type SelectorCandidate,
  type SettleOptions,
  type SerializedNode,
} from '@webscoop/core';
import { chromium, errors, type BrowserContext, type Frame, type Locator, type Page } from 'playwright';

/** Launch flags that keep Chromium from advertising automation. */
export const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled'];
export const IGNORED_DEFAULT_ARGS = ['--enable-automation'];

export interface PlaywrightBrowserOptions {
  /** Chromium binary to use instead of the build Playwright downloaded. */
  executablePath?: string;
  /** Timeout for element operations after navigation, in ms. Default 5000. */
  actionTimeoutMs?: number;
}

/** How long `settle` waits for a navigation to start after an action. */
const SETTLE_GRACE_MS = 500;
/** How long `settle` waits for network idle when the action did not navigate. */
const SETTLE_IDLE_MS = 2000;

class PwRef implements ElementRef {
  constructor(
    readonly locator: Locator,
    readonly description: string,
  ) {}
}

type Root = Page | Locator;

/**
 * A role candidate's name as a pattern that ignores whitespace: accessible
 * name implementations differ on spaces between child elements (the page's
 * inspector writes `com› blog` where Playwright computes `com › blog`).
 */
function roleName(name: string): RegExp {
  const chars = [...name.replace(/\s+/g, '')].map((ch) => ch.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'));
  return new RegExp(`^\\s*${chars.join('\\s*')}\\s*$`);
}

function locate(root: Root, candidate: SelectorCandidate): Locator {
  const { value } = candidate;
  switch (candidate.strategy) {
    case 'role': {
      const bar = value.indexOf('|');
      const role = (bar === -1 ? value : value.slice(0, bar)) as Parameters<Page['getByRole']>[0];
      return bar === -1 ? root.getByRole(role) : root.getByRole(role, { name: roleName(value.slice(bar + 1)) });
    }
    case 'testid':
      return root.getByTestId(value);
    case 'id':
      return root.locator(`css=[id=${JSON.stringify(value)}]`);
    case 'text':
      return root.getByText(value, { exact: true });
    case 'css':
    case 'class':
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
    const r = el.getBoundingClientRect();
    const bbox = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    return { type: 'element', tag: el.tagName.toLowerCase(), attrs, children, bbox };
  };
  return walk(element ?? document.documentElement) ?? { type: 'text', text: '' };
}

class PlaywrightSession implements InteractiveSession {
  /** Current handler per exposed name; a binding can be registered only once per context. */
  private readonly bindings = new Map<string, (msg: unknown) => Promise<unknown>>();

  /** Main frame navigations so far, so `settle` can tell whether a click navigated. */
  private navigations = 0;
  /** Navigations counted when the last action started. */
  private navigationsBefore = 0;
  /** HTTP status of the last main frame document response. */
  private lastStatus: number | null = null;

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.navigations++;
    });
    page.on('response', (response) => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) this.lastStatus = response.status();
    });
  }

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

  async click(ref: ElementRef): Promise<void> {
    const { locator } = ref as PwRef;
    this.navigationsBefore = this.navigations;
    await locator.scrollIntoViewIfNeeded();
    await locator.click();
  }

  async fill(ref: ElementRef, value: string): Promise<void> {
    const { locator } = ref as PwRef;
    this.navigationsBefore = this.navigations;
    await locator.fill(value);
  }

  async press(key: string, ref?: ElementRef): Promise<void> {
    this.navigationsBefore = this.navigations;
    if (ref) await (ref as PwRef).locator.press(key);
    else await this.page.keyboard.press(key);
  }

  async selectOption(ref: ElementRef, value: string): Promise<void> {
    const { locator } = ref as PwRef;
    this.navigationsBefore = this.navigations;
    // An option matches by value first, then by visible label; looked up in the page so a miss fails at once instead of waiting.
    const option = await locator.evaluate((el, wanted) => {
      const options = Array.from((el as HTMLSelectElement).options ?? []);
      const hit = options.find((o) => o.value === wanted) ?? options.find((o) => o.label.trim() === wanted || o.text.trim() === wanted);
      return hit ? hit.value : null;
    }, value);
    if (option === null) throw new Error(`no option ${JSON.stringify(value)} in ${ref.description}`);
    await locator.selectOption({ value: option });
  }

  async scrollToBottom(): Promise<void> {
    this.navigationsBefore = this.navigations;
    await this.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  }

  async settle(opts: SettleOptions): Promise<PageInfo> {
    const deadline = Date.now() + opts.timeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    const navigated = () => this.navigations !== this.navigationsBefore || (opts.previousUrl !== undefined && this.page.url() !== opts.previousUrl);
    try {
      if (!navigated()) {
        // A click may start its navigation a moment later; give it a short grace period.
        await this.page
          .waitForEvent('framenavigated', { predicate: (frame) => frame === this.page.mainFrame(), timeout: Math.min(SETTLE_GRACE_MS, left()) })
          .catch(() => {});
      }
      if (navigated()) {
        await this.page.waitForLoadState('load', { timeout: left() });
        await this.page.waitForLoadState('networkidle', { timeout: left() });
      } else {
        // Same document: wait for requests the action started, but never long.
        await this.page.waitForLoadState('networkidle', { timeout: Math.min(SETTLE_IDLE_MS, left()) }).catch(() => {});
      }
      return { url: this.page.url(), title: await this.page.title(), status: this.lastStatus };
    } catch (error) {
      if (error instanceof errors.TimeoutError) {
        throw new TimeoutError(`waiting for ${this.page.url()} to load timed out after ${opts.timeoutMs} ms`);
      }
      throw error;
    }
  }

  async url(): Promise<string> {
    return this.page.url();
  }

  async focus(): Promise<void> {
    await this.page.bringToFront();
  }

  async setTitle(title: string): Promise<void> {
    await this.page.evaluate((t) => {
      document.title = t;
    }, title);
  }

  async pageText(): Promise<string> {
    const text = await this.page.evaluate(() => document.body?.innerText ?? '');
    return text.replace(/\s+/g, ' ').trim().slice(0, PAGE_TEXT_LIMIT);
  }

  async close(): Promise<void> {
    await this.context.close();
  }

  async inject(source: string): Promise<void> {
    await this.context.addInitScript({ content: source });
    try {
      await this.page.evaluate(source);
    } catch {
      // The current document may be mid-navigation; the init script covers the next one.
    }
  }

  async expose(name: string, fn: (msg: unknown) => Promise<unknown>): Promise<void> {
    const known = this.bindings.has(name);
    this.bindings.set(name, fn);
    if (!known) await this.context.exposeBinding(name, (_source, msg: unknown) => this.bindings.get(name)!(msg));
  }

  async dispatch(msg: unknown): Promise<void> {
    await this.page.evaluate(
      ([global, message]) => {
        const target = (window as unknown as Record<string, { dispatch(m: unknown): void } | undefined>)[global];
        if (!target) throw new Error('the recorder is not loaded in this page');
        target.dispatch(message);
      },
      [PAGE_GLOBAL, msg] as const,
    );
  }

  onNavigated(cb: (url: string) => void): () => void {
    const listener = (frame: Frame) => {
      if (frame === this.page.mainFrame()) cb(frame.url());
    };
    this.page.on('framenavigated', listener);
    return () => this.page.off('framenavigated', listener);
  }

  onClosed(cb: () => void): () => void {
    let fired = false;
    const listener = () => {
      if (fired) return;
      fired = true;
      cb();
    };
    this.page.on('close', listener);
    this.context.on('close', listener);
    return () => {
      this.page.off('close', listener);
      this.context.off('close', listener);
    };
  }

  async geometry(ref: ElementRef): Promise<Geometry> {
    const box = await (ref as PwRef).locator.boundingBox();
    return box ? { x: box.x, y: box.y, w: box.width, h: box.height } : { x: 0, y: 0, w: 0, h: 0 };
  }
}

/** `BrowserPort` over a headed, persistent Playwright Chromium context. */
export class PlaywrightBrowser implements BrowserPort {
  constructor(private readonly options: PlaywrightBrowserOptions = {}) {}

  async open(profileDir: string, opts: OpenOptions = {}): Promise<InteractiveSession> {
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: null,
      // The CLI owns SIGINT: it aborts the run, closes the context, and releases the profile lock.
      handleSIGINT: false,
      ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
      ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
      ...(opts.bypassCSP ? { bypassCSP: true } : {}),
      args: [
        ...STEALTH_ARGS,
        ...(opts.remoteDebuggingPort !== undefined ? [`--remote-debugging-port=${opts.remoteDebuggingPort}`] : []),
        ...(opts.args ?? []),
      ],
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
