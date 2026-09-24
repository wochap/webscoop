import type {
  BrowserPort,
  ElementRef,
  Geometry,
  GotoOptions,
  InteractiveSession,
  OpenOptions,
  PageInfo,
  ReadOptions,
  SerializedElement,
  SerializedNode,
  Session,
  SettleOptions,
} from '../ports';
import { PAGE_TEXT_LIMIT, TimeoutError } from '../ports';
import type { SelectorCandidate } from '../recipe/schema';
import { compileCss } from './css';
import { accessibleName, indexTree, innerHtml, normalize, roleOf, textContent, type DomNode } from './dom';
import { evaluateXPath } from './xpath';

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
  /** Replace the DOM this many milliseconds after the page loads, for content that shows up late. */
  later?: { afterMs: number; dom: SerializedElement };
}

/** A fake page's reaction to an action: the element acted on (null for a key press without one) and the value typed, chosen, or pressed. */
export type FakeAction = (el: SerializedElement | null, value: string, url: string) => SerializedElement | { redirect: string } | void;

/** One action a fake session performed, for assertions. */
export interface FakeActionRecord {
  kind: 'fill' | 'select' | 'press';
  target: string | null;
  value: string;
}

const HIDDEN_TAGS = new Set(['script', 'style', 'template', 'noscript', 'head']);

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

  constructor(protected readonly browser: FakeBrowser) {}

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
    else this.load(this.currentUrl, result);
    return true;
  }

  async goto(url: string, opts: GotoOptions): Promise<PageInfo> {
    if (this.closed) throw new Error('session is closed');
    this.browser.visited.push(url);
    const { url: final, page } = this.follow(url);
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

  /** Set the element's `value` attribute, then run the page's fill handler. */
  async fill(ref: ElementRef, value: string): Promise<void> {
    this.assertOpen();
    const node = (ref as FakeRef).node;
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

  /** Mark the matching option selected, then run the page's select handler. Fails when no option matches. */
  async selectOption(ref: ElementRef, value: string): Promise<void> {
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
    const option = options.find((o) => (o.el.attrs.value ?? normalize(textContent(o.el))) === value || normalize(textContent(o.el)) === value);
    if (!option) throw new Error(`no option ${JSON.stringify(value)} in ${ref.description}`);
    for (const o of options) delete o.el.attrs.selected;
    option.el.attrs.selected = '';
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
    const collect = (node: DomNode) => {
      for (const child of node.children) {
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
        matches = pool.filter((n) => roleOf(n) === role && (name === undefined || accessibleName(n) === name));
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
      case 'css': {
        const test = compileCss(candidate.value);
        matches = pool.filter((n) => test(n, null));
        break;
      }
      case 'xpath': {
        const expr = scope && candidate.value.startsWith('/') ? `.${candidate.value}` : candidate.value;
        const inPool = new Set(pool);
        matches = evaluateXPath(expr, scope ?? document, document).filter((n) => inPool.has(n));
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
    return structuredClone((within ? (within as FakeRef).node : root).el);
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
  readonly exposed = new Map<string, (msg: unknown) => Promise<unknown>>();
  private readonly navigated = new Set<(url: string) => void>();
  private readonly closedListeners = new Set<() => void>();

  override async goto(url: string, opts: GotoOptions): Promise<PageInfo> {
    const info = await super.goto(url, opts);
    for (const cb of this.navigated) cb(info.url);
    return info;
  }

  async inject(source: string): Promise<void> {
    this.injected.push(source);
  }

  async expose(name: string, fn: (msg: unknown) => Promise<unknown>): Promise<void> {
    this.exposed.set(name, fn);
  }

  async dispatch(msg: unknown): Promise<void> {
    if (this.closed) throw new Error('session is closed');
    this.dispatched.push(msg);
  }

  onNavigated(cb: (url: string) => void): () => void {
    this.navigated.add(cb);
    return () => this.navigated.delete(cb);
  }

  onClosed(cb: () => void): () => void {
    this.closedListeners.add(cb);
    return () => this.closedListeners.delete(cb);
  }

  async geometry(ref: ElementRef): Promise<Geometry> {
    const el = (ref as FakeRef).node.el as SerializedElement & { bbox?: Geometry };
    return el.bbox ? { ...el.bbox } : { x: 0, y: 0, w: 0, h: 0 };
  }

  /** Play the page calling `window[name](msg)`. */
  async callHost(msg: unknown, name = '__webscoopHost'): Promise<unknown> {
    const fn = this.exposed.get(name);
    if (!fn) throw new Error(`no binding named ${name}`);
    return fn(msg);
  }

  /** Play the user closing the browser window. */
  async userClose(): Promise<void> {
    await this.close();
    for (const cb of this.closedListeners) cb();
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
  /** Every fill, select, and key press, in order. */
  readonly actions: FakeActionRecord[] = [];
  readonly openedProfiles: string[] = [];
  openSessions = 0;

  constructor(pages: Record<string, FakePage | SerializedElement> = {}) {
    for (const [url, page] of Object.entries(pages)) this.setPage(url, page);
  }

  setPage(url: string, page: FakePage | SerializedElement): this {
    this.pages.set(url, 'type' in page ? { dom: page } : page);
    return this;
  }

  readonly openOptions: (OpenOptions | undefined)[] = [];
  /** Every session opened, most recent last. */
  readonly sessions: FakeInteractiveSession[] = [];

  async open(profileDir: string, opts?: OpenOptions): Promise<FakeInteractiveSession> {
    this.openedProfiles.push(profileDir);
    this.openOptions.push(opts);
    this.openSessions++;
    const session = new FakeInteractiveSession(this);
    this.sessions.push(session);
    return session;
  }
}
