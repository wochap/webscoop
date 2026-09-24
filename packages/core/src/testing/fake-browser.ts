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
import { TimeoutError } from '../ports';
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

  constructor(protected readonly browser: FakeBrowser) {}

  private load(url: string, dom: SerializedElement): void {
    const { root } = indexTree(dom);
    const document: DomNode = { el: { type: 'element', tag: '#document', attrs: {}, children: [dom] }, parent: null, children: [root], order: -1 };
    root.parent = document;
    this.tree = { root, document };
    this.currentUrl = url;
  }

  private page(url: string): FakePage {
    const page = this.browser.pages.get(url);
    if (!page) throw new Error(`net::ERR_NAME_NOT_RESOLVED at ${url}`);
    return page;
  }

  private info(url: string, page: FakePage): PageInfo {
    return { url, title: page.title ?? '', status: page.status ?? 200 };
  }

  private assertOpen(): { root: DomNode; document: DomNode } {
    if (this.closed) throw new Error('session is closed');
    if (!this.tree) throw new Error('no page loaded');
    return this.tree;
  }

  async goto(url: string, opts: GotoOptions): Promise<PageInfo> {
    if (this.closed) throw new Error('session is closed');
    this.browser.visited.push(url);
    const page = this.page(url);
    if ((page.delayMs ?? 0) > opts.timeoutMs) {
      throw new TimeoutError(`navigation to ${url} timed out after ${opts.timeoutMs} ms`);
    }
    this.pendingUrl = null;
    this.steps = { more: 0, scroll: 0 };
    this.load(url, page.dom);
    return this.info(url, page);
  }

  /** Follow a link's `href`, or take the page's next `more` step for any other element. */
  async click(ref: ElementRef): Promise<void> {
    this.assertOpen();
    this.browser.clicks.push(ref.description);
    const href = (ref as FakeRef).node.el.attrs.href;
    if (href !== undefined) {
      this.pendingUrl = new URL(href, this.currentUrl).href;
      return;
    }
    this.grow('more');
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
    const url = this.pendingUrl;
    if (url === null) return this.info(this.currentUrl, this.browser.pages.get(this.currentUrl) ?? { dom: this.tree!.root.el });
    this.pendingUrl = null;
    this.browser.visited.push(url);
    const page = this.page(url);
    if ((page.delayMs ?? 0) > opts.timeoutMs) {
      throw new TimeoutError(`waiting for ${url} to load timed out after ${opts.timeoutMs} ms`);
    }
    this.steps = { more: 0, scroll: 0 };
    this.load(url, page.dom);
    return this.info(url, page);
  }

  async url(): Promise<string> {
    return this.currentUrl;
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
