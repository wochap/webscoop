import {
  classifyFillElement,
  FILE_CHOOSER_TIMEOUT_MS,
  FillUnresolvedError,
  type FillKind,
  type FillOptions,
  MAIN_WINDOW,
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
  type RecorderWindow,
  type SelectorCandidate,
  type SettleOptions,
  type SerializedNode,
  type Session,
} from '@webscoop/core';
import { HOVER_INSET, HOVER_TIMEOUT_MS, Humanizer, type HoverOptions } from './humanize';
import { chromium, errors, type BrowserContext, type Frame, type FrameLocator, type Locator, type Page } from 'playwright';

/** Launch flags that keep Chromium from advertising automation. Patchright manages its own. */
export const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled'];
export const IGNORED_DEFAULT_ARGS = ['--enable-automation'];
/** Launch flags that keep background tabs and hidden windows running at full speed, for jobs sharing one browser. */
export const BACKGROUND_ARGS = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

export type Driver = 'playwright' | 'patchright';
type DriverModule = typeof import('playwright');
type LaunchOptions = NonNullable<Parameters<DriverModule['chromium']['launchPersistentContext']>[1]>;

/** The configured driver's package cannot be loaded. */
export class DriverMissingError extends Error {
  constructor(readonly driver: Driver, options?: ErrorOptions) {
    super(`the ${driver} package is not installed`, options);
    this.name = 'DriverMissingError';
  }
}

/** Load a driver's module. Patchright has Playwright's API, so it is typed as Playwright. */
export async function loadDriver(driver: Driver): Promise<DriverModule> {
  if (driver === 'playwright') return { chromium, errors } as DriverModule;
  try {
    return (await import('patchright')) as unknown as DriverModule;
  } catch (error) {
    throw new DriverMissingError(driver, { cause: error });
  }
}

export interface PlaywrightBrowserOptions {
  /** Automation driver. Default `playwright`. */
  driver?: Driver;
  /** Browser binary to use instead of the build the driver downloaded. */
  executablePath?: string;
  /** Timeout for element operations after navigation, in ms. Default 5000. */
  actionTimeoutMs?: number;
  /** Driver module loader, injectable for tests. */
  load?: (driver: Driver) => Promise<DriverModule>;
}

/** `launchPersistentContext` options for a driver and the open options. */
export function launchOptions(options: PlaywrightBrowserOptions, opts: OpenOptions): LaunchOptions {
  const playwright = (options.driver ?? 'playwright') === 'playwright';
  const extra = [
    ...(opts.remoteDebuggingPort !== undefined ? [`--remote-debugging-port=${opts.remoteDebuggingPort}`] : []),
    ...(opts.args ?? []),
  ];
  return {
    headless: false,
    viewport: null,
    // The CLI owns SIGINT: it aborts the run, closes the context, and releases the profile lock.
    handleSIGINT: false,
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    ...(playwright ? { ignoreDefaultArgs: IGNORED_DEFAULT_ARGS } : {}),
    ...(opts.bypassCSP ? { bypassCSP: true } : {}),
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
    ...(opts.timezone ? { timezoneId: opts.timezone } : {}),
    ...(opts.locale ? { locale: opts.locale } : {}),
    args: playwright ? [...STEALTH_ARGS, ...BACKGROUND_ARGS, ...extra] : [...BACKGROUND_ARGS, ...extra],
  };
}

/**
 * Hover with Playwright's own mouse: at the center, then just inside the
 * top-left corner, then give up quietly. Locator hover scrolls into view and
 * checks that the point receives events. After a hover, wait one animation
 * frame so synchronous handlers have run.
 */
export async function plainHover(
  target: { hover(options?: HoverOptions): Promise<void> },
  page: { evaluate<R>(fn: () => R): Promise<R> },
): Promise<void> {
  for (const options of [{ timeout: HOVER_TIMEOUT_MS.center }, { position: HOVER_INSET, timeout: HOVER_TIMEOUT_MS.inset }]) {
    try {
      await target.hover(options);
    } catch {
      continue;
    }
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))).catch(() => {});
    return;
  }
}

/** A driver timeout; matched by name, since each driver has its own error classes. */
function isDriverTimeout(error: unknown): boolean {
  return error instanceof errors.TimeoutError || (error instanceof Error && error.name === 'TimeoutError');
}

/** How long `settle` waits for a navigation to start after an action. */
const SETTLE_GRACE_MS = 500;
/** How long `frameRoot` waits for an iframe's document to load when the caller gives no timeout. */
const FRAME_LOAD_MS = 30_000;
/** How long `settle` waits for network idle when the action did not navigate. */
const SETTLE_IDLE_MS = 2000;

class PwRef implements ElementRef {
  constructor(
    readonly locator: Locator,
    readonly description: string,
    /** Set on a frame root: the iframe's document, where an absolute xpath starts. */
    readonly frame?: FrameLocator,
  ) {}
}

type Root = Page | Locator | FrameLocator;

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

/**
 * Runs in the page: serialize an element subtree into `SerializedNode` form as
 * a JSON string. A string crosses DevTools at any document depth; a nested
 * object hits Chromium's CBOR-to-JSON nesting limit on deep pages.
 */
function serializeInPage(target: Element[] | null): string {
  // `evaluateAll` passes the scope's matches; `page.evaluate` passes null for the whole document.
  if (target && !target[0]) throw new Error('element gone');
  const element = target ? target[0]! : null;
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
  return JSON.stringify(walk(element ?? document.documentElement) ?? { type: 'text', text: '' });
}

export class PlaywrightSession implements InteractiveSession {
  /** Current handler per exposed name; a binding can be registered only once per context. */
  private readonly bindings = new Map<string, (msg: unknown, windowId: string) => Promise<unknown>>();
  /** Window ids of the popups the bindings were called from or that were reported, by page. */
  private readonly windowIds = new WeakMap<Page, string>();
  private windowCount = 0;
  /** Scripts injected so far, for popups of a tab, whose injection is page level. */
  private readonly injected: string[] = [];

  /** Main frame navigations so far, so `settle` can tell whether a click navigated. */
  private navigations = 0;
  /** Navigations counted when the last action started. */
  private navigationsBefore = 0;
  /** HTTP status of the last main frame document response. */
  private lastStatus: number | null = null;

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly driver: Driver = 'playwright',
    /** Humanized input, when the run turned it on. */
    private readonly humanizer?: Humanizer,
    /** Set for a tab of a shared browser: closing ends only the tab, and scripts and bindings stay on its page. */
    private readonly tab?: { close(): Promise<void> },
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
      // `load` is ready; idle is only a short grace, since some pages never stop requesting.
      await this.page
        .waitForLoadState('networkidle', { timeout: Math.max(1, Math.min(SETTLE_IDLE_MS, deadline - Date.now())) })
        .catch(() => {});
      await this.humanizer?.dwell();
      return { url: this.page.url(), title: await this.page.title(), status: response?.status() ?? null };
    } catch (error) {
      if (isDriverTimeout(error)) {
        throw new TimeoutError(`navigation to ${url} timed out after ${opts.timeoutMs} ms`);
      }
      throw error;
    }
  }

  async resolve(candidate: SelectorCandidate, within?: ElementRef): Promise<ElementRef[]> {
    const scope = within ? (within as PwRef) : undefined;
    // In a chained locator an xpath starting with `/` is relative; inside a frame root it is absolute in the iframe's document.
    const root = scope?.frame && candidate.strategy === 'xpath' && candidate.value.startsWith('/') ? scope.frame : (scope?.locator ?? this.page);
    const locator = locate(root, candidate);
    const count = await locator.evaluateAll((els) => els.length);
    const prefix = `${scope ? `${scope.description} >> ` : ''}${candidate.strategy}=${candidate.value}`;
    return Array.from({ length: count }, (_, i) => new PwRef(locator.nth(i), `${prefix} >> nth=${i}`));
  }

  async read(ref: ElementRef, opts: ReadOptions): Promise<string> {
    const { locator, description } = ref as PwRef;
    // One page call; a ref that no longer matches fails at once instead of waiting the action timeout.
    const value = await locator.evaluateAll(
      (els, o) => {
        const el = els[0];
        if (!el) return null;
        if (o.attr) return el.getAttribute(o.attr) ?? '';
        if (o.mode === 'html') return el.innerHTML;
        return el.textContent ?? '';
      },
      { attr: opts.attr ?? null, mode: opts.mode },
    );
    if (value === null) throw new Error(`element gone: ${description}`);
    return value;
  }

  async same(a: ElementRef, b: ElementRef): Promise<boolean> {
    // Mark a's element under a one-off key, then check b's element against it; both calls run in the same world.
    const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    type Marks = Map<string, WeakRef<Element>>;
    const marked = await (a as PwRef).locator.evaluateAll((els, k) => {
      const el = els[0];
      if (!el) return false;
      const w = window as unknown as { __webscoopSame?: Marks };
      (w.__webscoopSame ??= new Map()).set(k, new WeakRef(el));
      return true;
    }, key);
    if (!marked) return false;
    return (b as PwRef).locator.evaluateAll((els, k) => {
      const marks = (window as unknown as { __webscoopSame?: Marks }).__webscoopSame;
      const mark = marks?.get(k)?.deref();
      marks?.delete(k);
      return els[0] !== undefined && els[0] === mark;
    }, key);
  }

  async snapshot(within?: ElementRef): Promise<SerializedNode> {
    try {
      const json = within ? await (within as PwRef).locator.evaluateAll(serializeInPage) : await this.page.evaluate(serializeInPage, null);
      return JSON.parse(json) as SerializedNode;
    } catch (error) {
      throw new Error(`snapshot: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  async frameRoot(frame: ElementRef, opts?: { timeoutMs: number }): Promise<ElementRef | null> {
    const { locator, description } = frame as PwRef;
    const reachable = await locator
      .evaluateAll((els) => {
        const el = els[0];
        if (!(el instanceof HTMLIFrameElement)) return false;
        try {
          return el.contentDocument !== null;
        } catch {
          return false;
        }
      })
      .catch(() => false);
    if (!reachable) return null;
    const timeout = opts?.timeoutMs ?? FRAME_LOAD_MS;
    try {
      const handle = await locator.first().elementHandle({ timeout });
      const content = await handle?.contentFrame();
      await handle?.dispose();
      if (!content) return null;
      await content.waitForLoadState('load', { timeout });
    } catch {
      return null;
    }
    const inner = locator.first().contentFrame();
    return new PwRef(inner.locator(':root'), `${description} >> frame`, inner);
  }

  async click(ref: ElementRef): Promise<void> {
    const { locator } = ref as PwRef;
    this.navigationsBefore = this.navigations;
    if (this.humanizer) return this.humanizer.click(locator);
    await locator.scrollIntoViewIfNeeded();
    await locator.click();
  }

  async hover(ref: ElementRef): Promise<void> {
    const { locator } = ref as PwRef;
    if (this.humanizer) return this.humanizer.hover(locator);
    await plainHover(locator, this.page);
  }

  async fill(ref: ElementRef, value: string, opts: FillOptions = {}): Promise<void> {
    const { locator: all } = ref as PwRef;
    const locator = all.first();
    this.navigationsBefore = this.navigations;
    const kind = (await locator.evaluate(classifyFillElement)) as FillKind;
    if (kind === 'file') return locator.setInputFiles(opts.files ? [...opts.files] : value.split(':').filter(Boolean));
    if (opts.files) return this.chooseFiles(ref, opts.files);
    switch (kind) {
      case 'toggle':
      case 'radio':
        return this.setChecked(ref, kind, value);
      case 'select':
        return this.selectOptions(locator, ref.description, value);
      case 'combobox':
        return this.fillCombobox(ref, value, opts.timeoutMs ?? 30_000);
      case 'otp':
        if ([...value].length > 1) return this.typeKeys(locator, value);
        return this.fillText(locator, value);
      default:
        return this.fillText(locator, value);
    }
  }

  /** Click the element and hand the files to the chooser it opens. */
  private async chooseFiles(ref: ElementRef, files: readonly string[]): Promise<void> {
    const chooser = this.page.waitForEvent('filechooser', { timeout: FILE_CHOOSER_TIMEOUT_MS }).catch(() => null);
    await this.click(ref);
    const opened = await chooser;
    if (!opened) throw new FillUnresolvedError(`${ref.description} opened no file chooser within ${FILE_CHOOSER_TIMEOUT_MS / 1000} seconds`);
    await opened.setFiles([...files]);
  }

  /** Click a checkbox, switch, or radio only when its checked state differs from `true` or `false`. */
  private async setChecked(ref: ElementRef, kind: 'toggle' | 'radio', value: string): Promise<void> {
    const wanted = value.trim().toLowerCase();
    if (wanted !== 'true' && wanted !== 'false') throw new Error(`a checkbox, switch, or radio takes true or false, not ${JSON.stringify(value)}`);
    if (kind === 'radio' && wanted === 'false') throw new Error('a radio cannot be set to false; fill the radio to choose instead');
    const checked = await (ref as PwRef).locator
      .first()
      .evaluate((el) => (el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true'));
    if (checked !== (wanted === 'true')) await this.click(ref);
  }

  /** Choose the option whose value or visible label equals the value; for a multiple select, each line's option. */
  private async selectOptions(locator: Locator, description: string, value: string): Promise<void> {
    // Looked up in the page so a miss fails at once instead of waiting.
    const found = await locator.evaluate((el, wanted) => {
      const select = el as HTMLSelectElement;
      const options = Array.from(select.options ?? []);
      const want = select.multiple ? wanted.split('\n').filter((w) => w !== '') : [wanted];
      const values: string[] = [];
      for (const w of want) {
        const hit = options.find((o) => o.value === w) ?? options.find((o) => o.label.trim() === w || o.text.trim() === w);
        if (!hit) return { missing: w };
        values.push(hit.value);
      }
      return { values };
    }, value);
    if ('missing' in found) throw new Error(`no option ${JSON.stringify(found.missing)} in ${description}`);
    if (this.humanizer) return this.humanizer.selectOption(locator, found.values);
    await locator.selectOption(found.values.map((v) => ({ value: v })));
  }

  /** Type into a combobox, then click the visible option whose accessible name is the value. */
  private async fillCombobox(ref: ElementRef, value: string, timeoutMs: number): Promise<void> {
    const locator = (ref as PwRef).locator.first();
    const editable = await locator.evaluate((el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable);
    if (editable) await this.fillText(locator, value);
    else {
      await this.click(ref);
      await this.page.keyboard.type(value);
    }
    const handle = await locator.elementHandle();
    const frame = (await handle?.ownerFrame()) ?? this.page.mainFrame();
    await handle?.dispose();
    const option = frame.getByRole('option', { name: value, exact: true }).filter({ visible: true }).first();
    try {
      await option.waitFor({ state: 'visible', timeout: timeoutMs });
    } catch {
      throw new FillUnresolvedError(`${ref.description} showed no option ${JSON.stringify(value)} within ${timeoutMs} ms`);
    }
    if (this.humanizer) return this.humanizer.click(option);
    await option.click();
  }

  /** Focus the first box and press each character, so the page moves focus from box to box. */
  private async typeKeys(locator: Locator, value: string): Promise<void> {
    if (this.humanizer) return this.humanizer.type(locator, value);
    await locator.click();
    await locator.fill('');
    await this.page.keyboard.type(value, { delay: 20 });
  }

  /**
   * Clear and type. Plain `fill` sends the input events script frameworks
   * listen to; when the value read back still differs, type key by key.
   */
  private async fillText(locator: Locator, value: string): Promise<void> {
    // Date-like inputs take their value whole; typed keys go to locale-ordered segments.
    const typed = await locator.evaluate((el) => !(el instanceof HTMLInputElement) || !['date', 'time', 'datetime-local', 'month', 'week'].includes(el.type));
    if (this.humanizer && typed) return this.humanizer.type(locator, value);
    await locator.fill(value);
    const back = await locator.evaluate((el) => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? '')));
    if (back === value) return;
    await locator.fill('');
    await locator.pressSequentially(value, { delay: 10 });
  }

  async press(key: string, ref?: ElementRef): Promise<void> {
    this.navigationsBefore = this.navigations;
    if (this.humanizer) return this.humanizer.press(key, ref ? (ref as PwRef).locator : undefined);
    if (ref) await (ref as PwRef).locator.press(key);
    else await this.page.keyboard.press(key);
  }

  async scrollToBottom(): Promise<void> {
    this.navigationsBefore = this.navigations;
    if (this.humanizer) return this.humanizer.scroll();
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
        await this.humanizer?.dwell();
      } else {
        // Same document: wait for requests the action started, but never long.
        await this.page.waitForLoadState('networkidle', { timeout: Math.min(SETTLE_IDLE_MS, left()) }).catch(() => {});
      }
      return { url: this.page.url(), title: await this.page.title(), status: this.lastStatus };
    } catch (error) {
      if (isDriverTimeout(error)) {
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
    if (this.tab) await this.tab.close();
    else await this.context.close();
  }

  isClosed(): boolean {
    return this.page.isClosed();
  }

  /** The session over a popup of this page: same context and humanizer settings; closing it closes only the popup. */
  private popupSession(popup: Page): PlaywrightSession {
    return new PlaywrightSession(this.context, popup, this.driver, this.humanizer ? new Humanizer(popup) : undefined, { close: () => popup.close().catch(() => {}) });
  }

  onPopup(cb: (popup: Session) => void): () => void {
    const offs: (() => void)[] = [];
    const watch = (page: Page) => {
      const listener = (popup: Page) => {
        watch(popup);
        cb(this.popupSession(popup));
      };
      page.on('popup', listener);
      offs.push(() => page.off('popup', listener));
    };
    watch(this.page);
    return () => {
      for (const off of offs.splice(0)) off();
    };
  }

  /**
   * Evaluate in the page's main world, where the recorder bundle lives.
   * Patchright evaluates in an isolated world unless told otherwise.
   */
  private mainWorldEvaluate<R, A>(fn: string | ((arg: A) => R), arg?: A): Promise<R> {
    const evaluate = this.page.evaluate.bind(this.page) as (f: unknown, a: unknown, isolated?: boolean) => Promise<R>;
    return this.driver === 'patchright' ? evaluate(fn, arg, false) : evaluate(fn, arg);
  }

  /** The window id of a page: `MAIN_WINDOW` for this session's page, a fresh id for a popup seen first. */
  private windowIdOf(page: Page): string {
    if (page === this.page) return MAIN_WINDOW;
    let id = this.windowIds.get(page);
    if (!id) {
      id = `popup-${++this.windowCount}`;
      this.windowIds.set(page, id);
    }
    return id;
  }

  onWindow(cb: (win: RecorderWindow) => void): () => void {
    const offs: (() => void)[] = [];
    const watch = (page: Page) => {
      const listener = (popup: Page) => {
        watch(popup);
        const session = this.popupSession(popup);
        // A tab injects and exposes per page, so its popups need the recorder too.
        if (this.tab) void this.carryOver(popup, session);
        cb({ id: this.windowIdOf(popup), opener: this.windowIdOf(page), session });
      };
      page.on('popup', listener);
      offs.push(() => page.off('popup', listener));
    };
    watch(this.page);
    return () => {
      for (const off of offs.splice(0)) off();
    };
  }

  /** Give a tab's popup the scripts and bindings of the tab. */
  private async carryOver(popup: Page, session: PlaywrightSession): Promise<void> {
    try {
      for (const [name] of this.bindings) await popup.exposeBinding(name, (source, msg: unknown) => this.bindings.get(name)!(msg, this.windowIdOf(source.page)));
      for (const source of this.injected) await session.inject(source);
    } catch {
      // The popup closed meanwhile.
    }
  }

  async inject(source: string): Promise<void> {
    this.injected.push(source);
    await (this.tab ? this.page : this.context).addInitScript({ content: source });
    try {
      await this.mainWorldEvaluate(source);
    } catch {
      // The current document may be mid-navigation; the init script covers the next one.
    }
  }

  async expose(name: string, fn: (msg: unknown, windowId: string) => Promise<unknown>): Promise<void> {
    const known = this.bindings.has(name);
    this.bindings.set(name, fn);
    if (known) return;
    await (this.tab ? this.page : this.context).exposeBinding(name, (source, msg: unknown) => this.bindings.get(name)!(msg, this.windowIdOf(source.page)));
    if (this.driver === 'patchright' && this.bindings.size === 1) {
      // Patchright adds bindings to a document's main world only once the host evaluates there.
      this.page.on('domcontentloaded', () => void this.mainWorldEvaluate('0').catch(() => {}));
      await this.mainWorldEvaluate('0').catch(() => {});
    }
  }

  async dispatch(msg: unknown): Promise<void> {
    await this.mainWorldEvaluate(
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
    // Page coordinates, so an element inside an iframe is measured from the top viewport.
    const box = await (ref as PwRef).locator.boundingBox({ timeout: 1000 }).catch(() => null);
    return box ? { x: box.x, y: box.y, w: box.width, h: box.height } : { x: 0, y: 0, w: 0, h: 0 };
  }
}

/** `BrowserPort` over a headed, persistent Chromium context, driven by Playwright or Patchright. */
export class PlaywrightBrowser implements BrowserPort {
  constructor(private readonly options: PlaywrightBrowserOptions = {}) {}

  async open(profileDir: string, opts: OpenOptions = {}): Promise<InteractiveSession> {
    const driver = this.options.driver ?? 'playwright';
    const module = await (this.options.load ?? loadDriver)(driver);
    const context = await module.chromium.launchPersistentContext(profileDir, launchOptions(this.options, opts));
    try {
      context.setDefaultTimeout(this.options.actionTimeoutMs ?? 5000);
      const page = context.pages()[0] ?? (await context.newPage());
      return new PlaywrightSession(context, page, driver, opts.humanize ? new Humanizer(page) : undefined);
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }
}

/** Path of the Chromium build this driver version expects. */
export async function expectedChromiumPath(driver: Driver = 'playwright'): Promise<string> {
  return (await loadDriver(driver)).chromium.executablePath();
}

/** Per-tab options of a shared browser. */
export interface TabOptions {
  /** Humanized input for this tab. */
  humanize?: boolean;
  /** Ignore the tab's Content-Security-Policy from its next navigation on, so the banner and re-pick can be injected. */
  bypassCSP?: boolean;
}

/**
 * One headed, persistent Chromium context shared by many jobs: each job gets
 * its own tab, and closing the job's session closes only that tab and the
 * popups opened from it. The first page stays open as an idle placeholder, so
 * the window survives between jobs.
 */
export class SharedBrowser {
  private closed = false;
  private readonly closeListeners = new Set<() => void>();

  private constructor(
    private readonly context: BrowserContext,
    private readonly driver: Driver,
  ) {
    context.on('close', () => {
      this.closed = true;
      for (const cb of [...this.closeListeners]) cb();
    });
  }

  /** Launch the browser on a profile directory with the launch-level open options. */
  static async launch(options: PlaywrightBrowserOptions, profileDir: string, opts: OpenOptions = {}): Promise<SharedBrowser> {
    const driver = options.driver ?? 'playwright';
    const module = await (options.load ?? loadDriver)(driver);
    const context = await module.chromium.launchPersistentContext(profileDir, launchOptions(options, opts));
    try {
      context.setDefaultTimeout(options.actionTimeoutMs ?? 5000);
      if (context.pages().length === 0) await context.newPage();
      return new SharedBrowser(context, driver);
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Pages open in the browser, the placeholder included. */
  get pageCount(): number {
    return this.context.pages().length;
  }

  /** Open a new tab for one job. */
  async newSession(opts: TabOptions = {}): Promise<PlaywrightSession> {
    const page = await this.context.newPage();
    const owned = new Set<Page>();
    const track = (p: Page) => {
      p.on('popup', (popup) => {
        owned.add(popup);
        track(popup);
      });
    };
    track(page);
    try {
      if (opts.bypassCSP) await bypassPageCSP(this.context, page);
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
    let closing: Promise<void> | undefined;
    const tab = {
      close: () =>
        (closing ??= (async () => {
          for (const popup of owned) await popup.close().catch(() => {});
          await page.close().catch(() => {});
        })()),
    };
    return new PlaywrightSession(this.context, page, this.driver, opts.humanize ? new Humanizer(page) : undefined, tab);
  }

  /** Called once when the browser closes, by `close()` or by the user. Returns an unsubscribe function. */
  onClosed(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.context.close().catch(() => {});
  }
}

/** Turn off CSP for one page through DevTools, instead of the context-wide `bypassCSP`. */
export async function bypassPageCSP(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.setBypassCSP', { enabled: true });
}
