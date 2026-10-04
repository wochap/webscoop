import { classifyFillElement } from '../fill-kind';
import { DownloadQueue, type DownloadOutcome } from '../downloads';
import type {
  BrowserPort,
  ElementRef,
  FillOptions,
  Geometry,
  GotoOptions,
  InteractiveSession,
  OpenOptions,
  NextDownloadOptions,
  PageInfo,
  ReadOptions,
  SavedDownload,
  RecorderWindow,
  SerializedElement,
  SerializedNode,
  Session,
  SettleOptions,
} from '../ports';
import { FillUnresolvedError, MAIN_WINDOW, PAGE_TEXT_LIMIT, TimeoutError, uniqueFileName } from '../ports';
import type { SelectorCandidate } from '../recipe/schema';
import { compileCss } from './css';
import { accessibleName, indexTree, innerHtml, normalize, roleOf, textContent, type DomNode } from './dom';
import { evaluateXPath } from './xpath';

/**
 * An iframe in a fake page: an `<iframe>` whose only element child is a
 * `#document` holding the frame's `<html>`. Unscoped lookups, the document
 * xpath, `snapshot()`, and `pageText()` do not see into it; `frameRoot` does.
 */
export function iframe(attrs: Record<string, string>, html: SerializedElement): SerializedElement {
  return { type: 'element', tag: 'iframe', attrs, children: [{ type: 'element', tag: FRAME_DOCUMENT, attrs: {}, children: [html] }] };
}

const FRAME_DOCUMENT = '#document';

/** A copy of an element without the documents of the iframes inside it. */
function withoutFrames(el: SerializedElement): SerializedElement {
  return { ...el, attrs: { ...el.attrs }, children: el.children.filter((c) => c.type === 'text' || c.tag !== FRAME_DOCUMENT).map((c) => (c.type === 'text' ? { ...c } : withoutFrames(c))) };
}

export interface FakePage {
  /** Root element, normally `<html>`. */
  dom: SerializedElement;
  title?: string;
  status?: number;
  /** Simulated load time; a `goto` or `settle` whose timeout is shorter fails with `TimeoutError`. */
  delayMs?: number;
  /**
   * Renders the page with a given item count, for pages that grow. Each click
   * on an element without `href` takes the next `more` step, each
   * `scrollToBottom` the next `scroll` step; the page is re-rendered with that
   * step's count. Past the last step nothing changes.
   */
  render?: (count: number) => SerializedElement;
  /** Item counts after each load-more click. */
  more?: number[];
  /** Item counts after each scroll to the bottom. */
  scroll?: number[];
  /** Serve this URL's page instead, as an HTTP redirect would; `dom` is ignored. */
  redirect?: string;
  /** Navigating here starts this download instead of loading a document; `dom` is ignored. */
  download?: FakeDownload;
  /**
   * What the page does when the user acts on an element, for steps: return a
   * new DOM for the same URL, a `redirect` to navigate (loaded by the next
   * `settle`), or nothing to leave the page as it is. A click handler runs
   * before the `href` and `more` behavior and replaces it when it returns.
   */
  on?: {
    click?: FakeAction;
    fill?: FakeAction;
    select?: FakeAction;
    press?: FakeAction;
  };
  /** What a hover does to the hovered element: mutate it in place, as a page's `mouseover` handler would. */
  hover?: (el: SerializedElement, url: string) => void;
  /** Replace the DOM this many milliseconds after the page loads, for content that shows up late. */
  later?: { afterMs: number; dom: SerializedElement };
}

/**
 * A fake page's reaction to an action: the element acted on (null for a key
 * press without one) and the value typed, chosen, or pressed. `popup` opens
 * that URL in a new window, as `window.open` would; `close` closes the window
 * the action ran in, as `window.close` would.
 */
export type FakeAction = (
  el: SerializedElement | null,
  value: string,
  url: string,
) => SerializedElement | { redirect: string } | { popup: string } | { close: true } | { download: FakeDownload & { url: string } } | void;

/** A download a fake page starts. */
export interface FakeDownload {
  /** Suggested file name. */
  name: string;
  bytes?: number;
  /** Milliseconds until the download finishes. */
  delayMs?: number;
  /** Fail the download with this reason. */
  fail?: string;
}

/** One action a fake session performed, for assertions. */
export interface FakeActionRecord {
  /** `files`: paths a file input or chooser received, joined by `:`; `check`: a toggle or radio set to `true` or `false`. */
  kind: 'fill' | 'select' | 'press' | 'files' | 'check';
  target: string | null;
  value: string;
}

const HIDDEN_TAGS = new Set(['script', 'style', 'template', 'noscript', 'head', FRAME_DOCUMENT]);

function visibleText(el: SerializedElement): string {
  if (HIDDEN_TAGS.has(el.tag) || 'hidden' in el.attrs) return '';
  return el.children.map((c) => (c.type === 'text' ? c.text : ` ${visibleText(c)} `)).join('');
}

class FakeRef implements ElementRef {
  constructor(
    readonly node: DomNode,
    readonly description: string,
  ) {}
}

export class FakeSession implements Session {
  protected tree: { root: DomNode; document: DomNode } | null = null;
  protected closed = false;
  currentUrl = 'about:blank';
  /** Growth steps taken on the current page. */
  private steps = { more: 0, scroll: 0 };
  /** Page a click navigated to, loaded for real by the next `settle`. */
  private pendingUrl: string | null = null;
  /** When the current page was loaded, for `FakePage.later`. */
  private loadedAt = 0;
  /** Last element filled or clicked, where a key press without a target goes. */
  private focusedNode: DomNode | null = null;
  private readonly popupListeners = new Set<(popup: Session) => void>();
  protected readonly windowListeners = new Set<(win: RecorderWindow) => void>();
  /** Popups this window opened, oldest first. */
  readonly popups: FakeInteractiveSession[] = [];
  /** `MAIN_WINDOW` for a window the browser opened, `popup-N` for a popup. */
  readonly windowId: string;
  /** Download queue shared with the popups of the window at the top of the opener chain. */
  private readonly downloads: DownloadQueue;

  constructor(
    protected readonly browser: FakeBrowser,
    /** The window that opened this one, for a popup. */
    readonly opener: FakeSession | null = null,
  ) {
    this.windowId = opener ? `popup-${browser.popups.length + 1}` : MAIN_WINDOW;
    this.downloads = opener ? opener.downloads : new DownloadQueue(async (d, name) => browser.renameFile(d, name));
  }

  /** Start a download in this window, as a page would. */
  startDownload(url: string, download: FakeDownload): void {
    this.downloads.add(this, this.browser.saveDownload(url, download, this.downloadDir()));
  }

  private downloadDir(): string {
    return this.top().dir ?? '/downloads';
  }

  /** The download directory of a window the browser opened. */
  dir: string | undefined;

  downloadMark(): number {
    return this.downloads.mark();
  }

  nextDownload(opts: NextDownloadOptions): Promise<SavedDownload> {
    return this.downloads.next(opts);
  }

  onDownload(cb: (download: SavedDownload) => void): () => void {
    return this.downloads.onSaved(cb);
  }

  settleDownloads(timeoutMs: number): Promise<void> {
    return this.downloads.settle(timeoutMs);
  }

  /** The window at the top of the opener chain. */
  protected top(): FakeSession {
    return this.opener ? this.opener.top() : this;
  }

  onPopup(cb: (popup: Session) => void): () => void {
    this.popupListeners.add(cb);
    return () => this.popupListeners.delete(cb);
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Tell this window's listeners and its opener's about a popup, so the run's main window hears of popups of popups. */
  protected announce(popup: FakeInteractiveSession, opener: string = this.windowId): void {
    for (const cb of this.popupListeners) cb(popup);
    for (const cb of this.windowListeners) cb({ id: popup.windowId, opener, session: popup });
    this.opener?.announce(popup, opener);
  }

  /** Replace the current page's DOM in place, as a page's script would. */
  replaceDom(dom: SerializedElement): void {
    this.load(this.currentUrl, dom);
  }

  private load(url: string, dom: SerializedElement): void {
    const { root } = indexTree(dom);
    const document: DomNode = { el: { type: 'element', tag: '#document', attrs: {}, children: [dom] }, parent: null, children: [root], order: -1 };
    root.parent = document;
    this.tree = { root, document };
    this.currentUrl = url;
    this.focusedNode = null;
  }

  /** Load a page freshly: its DOM now, and its late DOM when due. */
  private enter(url: string, page: FakePage): void {
    this.load(url, page.dom);
    this.loadedAt = Date.now();
  }

  private page(url: string): FakePage {
    if (url === 'about:blank' && !this.browser.pages.has(url)) return { dom: { type: 'element', tag: 'html', attrs: {}, children: [] } };
    const page = this.browser.pages.get(url);
    if (!page) throw new Error(`net::ERR_NAME_NOT_RESOLVED at ${url}`);
    return page;
  }

  /** Follow redirects: the final URL and its page. */
  private follow(url: string): { url: string; page: FakePage } {
    let page = this.page(url);
    for (let hops = 0; page.redirect !== undefined; hops++) {
      if (hops > 10) throw new Error(`net::ERR_TOO_MANY_REDIRECTS at ${url}`);
      url = new URL(page.redirect, url).href;
      page = this.page(url);
    }
    return { url, page };
  }

  /** A navigation that started a download: the window keeps its document. */
  private downloaded(url: string, download: FakeDownload): PageInfo {
    this.startDownload(url, download);
    const page = this.browser.pages.get(this.currentUrl);
    return { url: this.currentUrl, title: page?.title ?? '', status: null, download: true };
  }

  private info(url: string, page: FakePage): PageInfo {
    return { url, title: page.title ?? '', status: page.status ?? 200 };
  }

  private assertOpen(): { root: DomNode; document: DomNode } {
    if (this.closed) throw new Error('session is closed');
    if (!this.tree) throw new Error('no page loaded');
    const later = this.browser.pages.get(this.currentUrl)?.later;
    if (later && this.loadedAt > 0 && Date.now() - this.loadedAt >= later.afterMs) {
      this.loadedAt = 0;
      this.load(this.currentUrl, later.dom);
    }
    return this.tree!;
  }

  /** Run the page's handler for an action; true when it handled the action. */
  private react(kind: keyof NonNullable<FakePage['on']>, node: DomNode | null, value: string): boolean {
    const handler = this.browser.pages.get(this.currentUrl)?.on?.[kind];
    if (!handler) return false;
    const result = handler(node ? node.el : null, value, this.currentUrl);
    if (!result) return false;
    if ('redirect' in result) this.pendingUrl = new URL(result.redirect, this.currentUrl).href;
    else if ('popup' in result) this.openPopup(new URL(result.popup, this.currentUrl).href);
    else if ('close' in result) void this.userClose();
    else if ('download' in result) this.startDownload(new URL(result.download.url, this.currentUrl).href, result.download);
    else this.load(this.currentUrl, result);
    return true;
  }

  /** Open a URL in a new window, as `window.open` would. */
  openPopup(url: string): FakeInteractiveSession {
    const popup = new FakeInteractiveSession(this.browser, this);
    this.browser.openSessions++;
    this.browser.popups.push(popup);
    this.browser.sessionsByWindow.set(popup.windowId, popup);
    this.popups.push(popup);
    const { url: final, page } = this.follow(url);
    this.browser.visited.push(url);
    popup.enterPage(final, page);
    this.announce(popup);
    return popup;
  }

  /** Load a page into a fresh window. */
  protected enterPage(url: string, page: FakePage): void {
    this.enter(url, page);
  }

  private readonly closedListeners = new Set<() => void>();

  onClosed(cb: () => void): () => void {
    this.closedListeners.add(cb);
    return () => this.closedListeners.delete(cb);
  }

  /** Play the user, or the page itself, closing the window. */
  async userClose(): Promise<void> {
    await this.close();
    for (const cb of this.closedListeners) cb();
  }

  async goto(url: string, opts: GotoOptions): Promise<PageInfo> {
    if (this.closed) throw new Error('session is closed');
    this.browser.visited.push(url);
    const { url: final, page } = this.follow(url);
    if (page.download) return this.downloaded(final, page.download);
    if ((page.delayMs ?? 0) > opts.timeoutMs) {
      throw new TimeoutError(`navigation to ${url} timed out after ${opts.timeoutMs} ms`);
    }
    url = final;
    this.pendingUrl = null;
    this.steps = { more: 0, scroll: 0 };
    this.enter(url, page);
    return this.info(url, page);
  }

  /** Run the page's click handler, else follow a link's `href`, else take the page's next `more` step. */
  async click(ref: ElementRef): Promise<void> {
    this.assertOpen();
    this.browser.clicks.push(ref.description);
    const node = (ref as FakeRef).node;
    this.focusedNode = node;
    if (this.react('click', node, '')) return;
    const href = node.el.attrs.href;
    if (href !== undefined) {
      this.pendingUrl = new URL(href, this.currentUrl).href;
      return;
    }
    this.grow('more');
  }

  /** Record the hover, then run the page's hover hook on the element. */
  async hover(ref: ElementRef): Promise<void> {
    this.assertOpen();
    this.browser.hovers.push(ref.description);
    const node = (ref as FakeRef).node;
    this.browser.pages.get(this.currentUrl)?.hover?.(node.el, this.currentUrl);
  }

  /**
   * Set the element as a `fill` step does, by kind: files on a file input, or
   * through the chooser an element with `data-file-chooser` opens; a checked
   * state through a click; select options; a combobox option shown with role
   * `option`; one character per one-character box; else the `value`. The
   * page's fill (or select) handler runs after.
   */
  async fill(ref: ElementRef, value: string, opts: FillOptions = {}): Promise<void> {
    this.assertOpen();
    const node = (ref as FakeRef).node;
    const kind = classifyFillElement(elementShim(node.el));
    if (kind === 'file' || opts.files) {
      if (kind !== 'file' && !('data-file-chooser' in node.el.attrs)) throw new FillUnresolvedError(`${ref.description} opened no file chooser within 5 seconds`);
      const files = opts.files ? [...opts.files] : value.split(':').filter(Boolean);
      this.browser.actions.push({ kind: 'files', target: ref.description, value: files.join(':') });
      node.el.attrs.value = files.map((f) => f.slice(f.lastIndexOf('/') + 1)).join(', ');
      this.react('fill', node, files.join(':'));
      return;
    }
    switch (kind) {
      case 'toggle':
      case 'radio': {
        const wanted = value.trim().toLowerCase();
        if (wanted !== 'true' && wanted !== 'false') throw new Error(`a checkbox, switch, or radio takes true or false, not ${JSON.stringify(value)}`);
        if (kind === 'radio' && wanted === 'false') throw new Error('a radio cannot be set to false; fill the radio to choose instead');
        const attrs = node.el.attrs;
        const checked = node.el.tag === 'input' ? 'checked' in attrs : attrs['aria-checked'] === 'true';
        if (checked === (wanted === 'true')) return;
        this.browser.actions.push({ kind: 'check', target: ref.description, value: wanted });
        if (node.el.tag === 'input') {
          if (wanted === 'true') attrs.checked = '';
          else delete attrs.checked;
        } else attrs['aria-checked'] = wanted;
        return this.click(ref);
      }
      case 'select':
        return this.selectOption(ref, value);
      case 'combobox': {
        node.el.attrs.value = value;
        this.react('fill', node, value);
        const option = this.tree ? findNode(this.tree.root, (n) => roleOf(n) === 'option' && normalize(accessibleName(n)) === value) : null;
        if (!option) throw new FillUnresolvedError(`${ref.description} showed no option ${JSON.stringify(value)} within ${opts.timeoutMs ?? 30_000} ms`);
        this.browser.actions.push({ kind: 'fill', target: ref.description, value });
        return this.click(new FakeRef(option, `option ${value}`));
      }
      case 'otp': {
        const chars = [...value];
        if (chars.length > 1) {
          const boxes = otpBoxes(node);
          this.browser.actions.push({ kind: 'fill', target: ref.description, value });
          boxes.forEach((box, i) => (box.el.attrs.value = chars[i] ?? ''));
          this.focusedNode = boxes[Math.min(chars.length, boxes.length) - 1] ?? node;
          this.react('fill', node, value);
          return;
        }
        break;
      }
    }
    this.browser.actions.push({ kind: 'fill', target: ref.description, value });
    node.el.attrs.value = value;
    this.focusedNode = node;
    this.react('fill', node, value);
  }

  async press(key: string, ref?: ElementRef): Promise<void> {
    this.assertOpen();
    const node = ref ? (ref as FakeRef).node : this.focusedNode;
    this.browser.actions.push({ kind: 'press', target: ref?.description ?? null, value: key });
    this.react('press', node, key);
  }

  /** Mark the matching options selected, then run the page's select handler. Fails when no option matches. */
  private async selectOption(ref: ElementRef, value: string): Promise<void> {
    this.assertOpen();
    const node = (ref as FakeRef).node;
    const options: DomNode[] = [];
    const collect = (n: DomNode) => {
      for (const child of n.children) {
        if (child.el.tag === 'option') options.push(child);
        collect(child);
      }
    };
    collect(node);
    const wanted = 'multiple' in node.el.attrs ? value.split('\n').filter((w) => w !== '') : [value];
    const chosen = wanted.map((w) => {
      const option = options.find((o) => (o.el.attrs.value ?? normalize(textContent(o.el))) === w || normalize(textContent(o.el)) === w);
      if (!option) throw new Error(`no option ${JSON.stringify(w)} in ${ref.description}`);
      return option;
    });
    for (const o of options) delete o.el.attrs.selected;
    for (const option of chosen) option.el.attrs.selected = '';
    this.browser.actions.push({ kind: 'select', target: ref.description, value });
    this.react('select', node, value);
  }

  async scrollToBottom(): Promise<void> {
    this.assertOpen();
    this.grow('scroll');
  }

  private grow(kind: 'more' | 'scroll'): void {
    const page = this.browser.pages.get(this.currentUrl);
    const counts = page?.[kind];
    if (!page?.render || !counts || this.steps[kind] >= counts.length) return;
    const count = counts[this.steps[kind]++]!;
    this.load(this.currentUrl, page.render(count));
  }

  async settle(opts: SettleOptions): Promise<PageInfo> {
    this.assertOpen();
    let url = this.pendingUrl;
    if (url === null) return this.info(this.currentUrl, this.browser.pages.get(this.currentUrl) ?? { dom: this.tree!.root.el });
    this.pendingUrl = null;
    this.browser.visited.push(url);
    const { url: final, page } = this.follow(url);
    if (page.download) return this.downloaded(final, page.download);
    if ((page.delayMs ?? 0) > opts.timeoutMs) {
      throw new TimeoutError(`waiting for ${url} to load timed out after ${opts.timeoutMs} ms`);
    }
    url = final;
    this.steps = { more: 0, scroll: 0 };
    this.enter(url, page);
    return this.info(url, page);
  }

  async url(): Promise<string> {
    return this.currentUrl;
  }

  /** Times `focus` was called. */
  focused = 0;

  async focus(): Promise<void> {
    this.assertOpen();
    this.focused++;
  }

  /** Titles set through `setTitle`, in order. */
  readonly titles: string[] = [];

  async setTitle(title: string): Promise<void> {
    if (this.closed) throw new Error('session is closed');
    this.titles.push(title);
  }

  /** Text of `<body>` (or the root), without scripts and styles, whitespace collapsed. */
  async pageText(): Promise<string> {
    const { root } = this.assertOpen();
    const body = root.el.tag === 'body' ? root : (root.children.find((c) => c.el.tag === 'body') ?? root);
    return normalize(visibleText(body.el)).slice(0, PAGE_TEXT_LIMIT);
  }

  async resolve(candidate: SelectorCandidate, within?: ElementRef): Promise<ElementRef[]> {
    const { root, document } = this.assertOpen();
    const scope = within ? (within as FakeRef).node : null;
    const pool: DomNode[] = [];
    // Like Playwright, a lookup never crosses into an iframe's document.
    const collect = (node: DomNode) => {
      for (const child of node.children) {
        if (child.el.tag === FRAME_DOCUMENT) continue;
        pool.push(child);
        collect(child);
      }
    };
    if (scope) collect(scope);
    else {
      pool.push(root);
      collect(root);
    }

    let matches: DomNode[];
    switch (candidate.strategy) {
      case 'role': {
        const [role, ...rest] = candidate.value.split('|');
        const name = rest.length > 0 ? rest.join('|') : undefined;
        matches = pool.filter((n) => roleOf(n) === role && (name === undefined || accessibleName(n).replace(/\s+/g, '') === name.replace(/\s+/g, '')));
        break;
      }
      case 'testid':
        matches = pool.filter((n) => n.el.attrs['data-testid'] === candidate.value);
        break;
      case 'id':
        matches = pool.filter((n) => n.el.attrs.id === candidate.value);
        break;
      case 'text': {
        const wanted = normalize(candidate.value);
        const hit = (n: DomNode) => normalize(textContent(n.el)) === wanted;
        matches = pool.filter((n) => hit(n) && !n.children.some(hit));
        break;
      }
      case 'css':
      case 'class': {
        const test = compileCss(candidate.value);
        // Like Playwright, combinators only match elements strictly inside the scope.
        matches = pool.filter((n) => test(n, scope));
        break;
      }
      case 'xpath': {
        // Inside a frame root an absolute path is absolute in the iframe's document.
        const frameDocument = scope?.parent?.el.tag === FRAME_DOCUMENT ? scope.parent : null;
        const expr = scope && !frameDocument && candidate.value.startsWith('/') ? `.${candidate.value}` : candidate.value;
        const inPool = new Set(frameDocument ? [scope!, ...pool] : pool);
        matches = evaluateXPath(expr, scope ?? document, frameDocument ?? document).filter((n) => inPool.has(n));
        break;
      }
    }
    const prefix = `${within ? `${within.description} >> ` : ''}${candidate.strategy}=${candidate.value}`;
    return matches.map((node, i) => new FakeRef(node, `${prefix} >> nth=${i}`));
  }

  async read(ref: ElementRef, opts: ReadOptions): Promise<string> {
    this.assertOpen();
    const { el } = (ref as FakeRef).node;
    if (opts.attr) return el.attrs[opts.attr] ?? '';
    return opts.mode === 'html' ? innerHtml(el) : textContent(el);
  }

  async same(a: ElementRef, b: ElementRef): Promise<boolean> {
    return (a as FakeRef).node === (b as FakeRef).node;
  }

  async snapshot(within?: ElementRef): Promise<SerializedNode> {
    const { root } = this.assertOpen();
    return withoutFrames((within ? (within as FakeRef).node : root).el);
  }

  async frameRoot(frame: ElementRef): Promise<ElementRef | null> {
    this.assertOpen();
    const node = (frame as FakeRef).node;
    if (node.el.tag !== 'iframe') return null;
    const html = node.children.find((c) => c.el.tag === FRAME_DOCUMENT)?.children[0];
    return html ? new FakeRef(html, `${frame.description} >> frame`) : null;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.browser.openSessions--;
  }
}

/**
 * `InteractiveSession` over serialized DOM. Records injected scripts and
 * dispatched messages; `callHost` plays the page calling an exposed binding.
 */
export class FakeInteractiveSession extends FakeSession implements InteractiveSession {
  readonly injected: string[] = [];
  readonly dispatched: unknown[] = [];
  readonly exposed = new Map<string, (msg: unknown, windowId: string) => Promise<unknown>>();
  private readonly navigated = new Set<(url: string) => void>();

  override async goto(url: string, opts: GotoOptions): Promise<PageInfo> {
    const info = await super.goto(url, opts);
    for (const cb of this.navigated) cb(info.url);
    return info;
  }

  async inject(source: string): Promise<void> {
    this.injected.push(source);
  }

  /** Scripts run in one document with `evaluate`, with the URL they ran on. */
  readonly evaluated: { url: string; source: string }[] = [];

  async evaluate(source: string): Promise<void> {
    this.evaluated.push({ url: this.currentUrl, source });
  }

  async expose(name: string, fn: (msg: unknown, windowId: string) => Promise<unknown>): Promise<void> {
    this.exposed.set(name, fn);
  }

  onWindow(cb: (win: RecorderWindow) => void): () => void {
    this.windowListeners.add(cb);
    return () => this.windowListeners.delete(cb);
  }

  async dispatch(msg: unknown): Promise<void> {
    if (this.closed) throw new Error('session is closed');
    this.dispatched.push(msg);
  }

  onNavigated(cb: (url: string) => void): () => void {
    this.navigated.add(cb);
    return () => this.navigated.delete(cb);
  }

  async geometry(ref: ElementRef): Promise<Geometry> {
    const el = (ref as FakeRef).node.el as SerializedElement & { bbox?: Geometry };
    return el.bbox ? { ...el.bbox } : { x: 0, y: 0, w: 0, h: 0 };
  }

  /** Play the page calling `window[name](msg)`; in a popup the binding is the main window's, as with a context-level binding. */
  async callHost(msg: unknown, name = '__webscoopHost'): Promise<unknown> {
    const fn = (this.top() as FakeInteractiveSession).exposed.get(name);
    if (!fn) throw new Error(`no binding named ${name}`);
    return fn(msg, this.windowId);
  }

  /** Messages dispatched so far with the given kind. */
  dispatchedOf(kind: string): unknown[] {
    return this.dispatched.filter((m) => (m as { kind?: string }).kind === kind);
  }
}

/** `BrowserPort` over serialized DOM fixtures, for unit tests without a browser. */
export class FakeBrowser implements BrowserPort {
  readonly pages = new Map<string, FakePage>();
  readonly visited: string[] = [];
  /** Descriptions of every clicked element, in order. */
  readonly clicks: string[] = [];
  /** Descriptions of every hovered element, in order. */
  readonly hovers: string[] = [];
  /** Every fill, select, and key press, in order. */
  readonly actions: FakeActionRecord[] = [];
  readonly openedProfiles: string[] = [];
  openSessions = 0;
  /** Every popup opened by any window, oldest first. */
  readonly popups: FakeInteractiveSession[] = [];
  readonly sessionsByWindow = new Map<string, FakeInteractiveSession>();

  constructor(pages: Record<string, FakePage | SerializedElement> = {}) {
    for (const [url, page] of Object.entries(pages)) this.setPage(url, page);
  }

  setPage(url: string, page: FakePage | SerializedElement): this {
    this.pages.set(url, 'type' in page ? { dom: page } : page);
    return this;
  }

  /** Files saved in download directories, by absolute path, with their sizes. Tests may add files that already exist. */
  readonly files = new Map<string, number>();

  /** Save a download under its suggested name with the collision rule, after its delay. */
  async saveDownload(url: string, download: FakeDownload, dir: string): Promise<DownloadOutcome> {
    if (download.delayMs) await new Promise((r) => setTimeout(r, download.delayMs));
    if (download.fail !== undefined) throw new Error(download.fail);
    const name = uniqueFileName(download.name, (n) => this.files.has(`${dir}/${n}`));
    const bytes = download.bytes ?? 0;
    this.files.set(`${dir}/${name}`, bytes);
    return { file: `${dir}/${name}`, name, url, bytes };
  }

  /** Rename a saved file in its directory with the collision rule. */
  renameFile(download: SavedDownload, name: string): DownloadOutcome {
    const dir = download.file.slice(0, download.file.length - download.name.length - 1);
    this.files.delete(download.file);
    const unique = uniqueFileName(name, (n) => this.files.has(`${dir}/${n}`));
    this.files.set(`${dir}/${unique}`, download.bytes);
    return { file: `${dir}/${unique}`, name: unique, url: download.url, bytes: download.bytes };
  }

  readonly openOptions: (OpenOptions | undefined)[] = [];
  /** Every session opened, most recent last. */
  readonly sessions: FakeInteractiveSession[] = [];

  async open(profileDir: string, opts?: OpenOptions): Promise<FakeInteractiveSession> {
    this.openedProfiles.push(profileDir);
    this.openOptions.push(opts);
    this.openSessions++;
    const session = new FakeInteractiveSession(this);
    session.dir = opts?.downloadDir;
    this.sessions.push(session);
    return session;
  }
}

/** Enough of a DOM element for `classifyFillElement`. */
function elementShim(el: SerializedElement): Element {
  return {
    tagName: el.tag.toUpperCase(),
    type: el.tag === 'input' ? (el.attrs.type ?? 'text') : undefined,
    getAttribute: (name: string) => el.attrs[name] ?? null,
    hasAttribute: (name: string) => name in el.attrs,
  } as unknown as Element;
}

function findNode(root: DomNode, match: (n: DomNode) => boolean): DomNode | null {
  if (match(root)) return root;
  for (const child of root.children) {
    const hit = findNode(child, match);
    if (hit) return hit;
  }
  return null;
}

/** The one-character boxes from `first` on, in the nearest ancestor holding several. */
function otpBoxes(first: DomNode): DomNode[] {
  for (let scope = first.parent, depth = 0; scope && depth < 4; scope = scope.parent, depth++) {
    const boxes: DomNode[] = [];
    const visit = (n: DomNode) => {
      if (n.el.tag === 'input' && n.el.attrs.maxlength === '1') boxes.push(n);
      n.children.forEach(visit);
    };
    visit(scope);
    if (boxes.length > 1) return boxes.slice(Math.max(0, boxes.indexOf(first)));
  }
  return [first];
}
