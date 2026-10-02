import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dataset, type Product } from './dataset';
import { formsPage, formsSubmitPage } from './forms';
import {
  CHROME_MODES,
  escapeHtml,
  GATE_KINDS,
  MAX_TIER,
  PAGINATE_KINDS,
  render,
  renderCards,
  renderResults,
  UnimplementedTierError,
  type ChromeMode,
  type Gate,
  type PaginateKind,
  type Pager,
} from './render';
import { SPA_COOKIE, spaLoggedIn, spaLoginPage, spaPage, spaSession } from './spa';
import {
  challengePage,
  HUMAN_COOKIE,
  interstitialPage,
  loginPage,
  safeNext,
  SESSION_COOKIE,
  turnstileFrame,
  WALL_KINDS,
  type WallKind,
} from './walls';

export interface ControlState {
  tier: number;
  seed: number;
  delayMs: number;
}

export const INITIAL_CONTROL: Readonly<ControlState> = Object.freeze({ tier: 0, seed: 1, delayMs: 0 });

export const VISITOR_COOKIE = 'ws_visitor';
/** Current page of the `next` pagination kind. */
export const PAGE_COOKIE = 'ws_page';
/** Set by `go=next` for the redirect that follows; without it a `next` catalog starts at page 1. */
const ADVANCED_COOKIE = 'ws_go';

/** Products per page of a paginated catalog. */
export const PAGE_SIZE = 8;
/** Results on the `/results` page unless `count` says otherwise. */
const RESULTS = 8;
/** Pages of a paginated catalog before `lastPageRepeats` takes over. */
const LAST_PAGE = 3;

export interface RequestRecord {
  method: string;
  path: string;
  cookie: string | undefined;
  at: number;
}

export interface PlaygroundOptions {
  /** Port to listen on; 0 picks a free port. Default 0. */
  port?: number;
  host?: string;
  products?: readonly Product[];
}

export interface Playground {
  readonly port: number;
  readonly url: string;
  /** Current control defaults for this instance. */
  readonly control: ControlState;
  /** Every request this instance received, oldest first. */
  readonly requests: RequestRecord[];
  stop(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A search box and a button that log every pointer, key, and wheel event into
 * `#events` as JSON, so a run can extract how the page was driven.
 */
function inputEventsPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Input events</title>
<style>body{font-family:sans-serif;margin:40px;min-height:3000px}#go{margin:200px 0 0 300px;width:140px;height:44px}</style></head>
<body>
<label>Search <input id="q" name="q" autocomplete="off"></label>
<div><button id="go" type="button">Search</button></div>
<p id="result"></p>
<pre id="events">[]</pre>
<script>
const events = [];
const out = document.getElementById('events');
const go = document.getElementById('go');
const log = (e) => {
  const r = go.getBoundingClientRect();
  events.push({ type: e.type, x: e.clientX, y: e.clientY, key: e.key, inButton: e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom });
  out.textContent = JSON.stringify(events);
};
for (const type of ['mousemove', 'mousedown', 'keydown', 'wheel']) window.addEventListener(type, log, true);
go.addEventListener('click', () => { document.getElementById('result').textContent = 'searched ' + document.getElementById('q').value; });
</script>
</body></html>`;
}

/**
 * A page that steals focus like Bing: any `keydown` on `document` (bubble
 * phase) whose target is not an input moves focus to `#q`. Bubble `keydown`
 * and `click` counts are kept on `window.__thief` and in `#counts`.
 */
/** Iframes of the framed page, in menu order: the menu label, the iframe `id`, and the inner view. */
const FRAMED_VIEWS = [
  { label: 'Catalog', id: 'frame-catalog', view: 'catalog' },
  { label: 'About', id: 'frame-about', view: 'about' },
] as const;
/** Products the framed catalog shows. */
export const FRAMED_COUNT = 8;

/** A short description of a product, for the framed catalog's details panel. */
export function productDescription(p: Product): string {
  return `${p.title}: ${p.category.toLowerCase()} from ${p.seller}, rated ${p.rating} out of 5.`;
}

/**
 * A menu page whose content lives in same-origin iframes, like a portal that
 * loads each option into an application frame. The menu shows one iframe and
 * hides the others without changing the URL; `show` picks the one shown first.
 */
function framedPage(show: string): string {
  const shown = FRAMED_VIEWS.some((v) => v.view === show) ? show : 'catalog';
  const buttons = FRAMED_VIEWS.map((v) => `<button type="button" class="menu-item" data-view="${v.view}">${v.label}</button>`).join('');
  const frames = FRAMED_VIEWS.map(
    (v) => `<iframe id="${v.id}" class="app-frame" name="${v.view}" src="/framed/inner?view=${v.view}" title="${v.label}"${v.view === shown ? '' : ' hidden'}></iframe>`,
  ).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Framed portal</title>
<style>body{font-family:sans-serif;margin:0;display:flex;min-height:100vh}nav{width:220px;padding:20px;display:flex;flex-direction:column;gap:8px;background:#f2f2f5}main{flex:1;padding:20px}.app-frame{width:100%;height:900px;border:1px solid #ccc}</style></head>
<body><nav aria-label="Menu"><h1 class="portal-title">Portal</h1>${buttons}</nav>
<main>${frames}</main>
<script>
document.querySelectorAll('.menu-item').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.app-frame').forEach((frame) => { frame.hidden = frame.name !== button.dataset.view; });
}));
</script>
</body></html>`;
}

/** The document inside a framed page iframe: the catalog cards with a details panel, or text only. */
function framedInner(view: string, products: readonly Product[], seed: number): string {
  if (view === 'about') {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About</title></head><body><h1>About the shop</h1><p class="about">A playground shop rendered inside an iframe.</p></body></html>';
  }
  if (view !== 'catalog') throw new HttpError(400, `invalid view ${JSON.stringify(view)}, expected catalog or about`);
  const shown = products.slice(0, FRAMED_COUNT);
  const first = shown[0];
  const details = first
    ? `<section class="framed-details"><button type="button" id="details-toggle">Details</button><div id="details" class="details-panel" hidden></div></section>
<script>document.getElementById('details-toggle').addEventListener('click', () => { const panel = document.getElementById('details'); panel.innerHTML = ${JSON.stringify(`<p class="details-text">${escapeHtml(productDescription(first))}</p>`)}; panel.hidden = false; });</script>`
    : '';
  return render(shown, { tier: 0, seed, category: first?.category }).replace('</body>', `${details}\n</body>`);
}

function focusThiefPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Focus thief</title>
<style>body{font-family:sans-serif;margin:40px}</style></head>
<body>
<label>Search <input id="q" name="q" autocomplete="off"></label>
<p id="intro">Typing anywhere on this page moves focus to the search box.</p>
<pre id="counts">{"keydown":0,"click":0}</pre>
<script>
const thief = window.__thief = { keydown: 0, click: 0 };
const q = document.getElementById('q');
const show = () => { document.getElementById('counts').textContent = JSON.stringify(thief); };
document.addEventListener('keydown', (e) => {
  thief.keydown++;
  show();
  const tag = e.target && e.target.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') q.focus();
});
document.addEventListener('click', () => { thief.click++; show(); });
</script>
</body></html>`;
}

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function intParam(value: string | null, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `invalid ${name} ${JSON.stringify(value)}`);
  }
  return n;
}

function parseControl(body: unknown): Partial<ControlState> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'control body must be a JSON object');
  }
  const out: Partial<ControlState> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== 'tier' && key !== 'seed' && key !== 'delayMs') throw new HttpError(400, `unknown control key ${key}`);
    const n = intParam(String(value), key, 0, key === 'tier' ? MAX_TIER : undefined);
    if (n !== undefined) out[key] = n;
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function cookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

function flag(url: URL, name: string): boolean {
  const value = url.searchParams.get(name);
  if (value === null) return false;
  if (value !== '0' && value !== '1') throw new HttpError(400, `invalid ${name} ${JSON.stringify(value)}, expected 0 or 1`);
  return value === '1';
}

/** A catalog URL with some query parameters replaced or removed. */
function withParams(url: URL, changes: Record<string, string | null>): string {
  const params = new URLSearchParams(url.searchParams);
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) params.delete(name);
    else params.set(name, value);
  }
  return `${url.pathname}?${params.toString()}`;
}

interface PagedView {
  products: readonly Product[];
  pager: Pager;
}

/** Which products and controls page `page` of a paginated catalog shows. */
function pagedView(
  products: readonly Product[],
  url: URL,
  kind: PaginateKind,
  page: number,
  opts: { tier: number; seed: number; nextRel: boolean; lastPageRepeats: boolean; moreDisappears: boolean },
): PagedView {
  const slice = (n: number) => products.slice((n - 1) * PAGE_SIZE, n * PAGE_SIZE);
  if (kind === 'more' || kind === 'scroll') {
    return {
      products: slice(1),
      pager: { kind, more: { after: PAGE_SIZE, total: products.length, tier: opts.tier, seed: opts.seed, disappear: opts.moreDisappears } },
    };
  }
  const shown = page > LAST_PAGE && opts.lastPageRepeats ? LAST_PAGE : page;
  const hasNext = page < LAST_PAGE || opts.lastPageRepeats;
  if (kind === 'url') {
    const links = Array.from({ length: LAST_PAGE }, (_, i) => ({ page: i + 1, href: withParams(url, { page: String(i + 1) }), current: i + 1 === page }));
    return {
      products: slice(shown),
      pager: { kind, links, ...(hasNext ? { next: withParams(url, { page: String(page + 1) }) } : {}), rel: opts.nextRel },
    };
  }
  return {
    products: slice(shown),
    pager: { kind, next: hasNext ? withParams(url, { go: 'next' }) : null, rel: opts.nextRel },
  };
}

/**
 * The `gate` parameter as a render gate. A search gate carries the query and
 * every other parameter but `page`, so submitting the form starts over at page 1
 * with the same options.
 */
function parseGate(url: URL): Gate | null {
  const kind = url.searchParams.get('gate');
  if (kind === null) return null;
  if (!(GATE_KINDS as readonly string[]).includes(kind)) {
    throw new HttpError(400, `invalid gate ${JSON.stringify(kind)}, expected one of ${GATE_KINDS.join(', ')}`);
  }
  if (kind !== 'search') return { kind: kind as 'cookie' | 'tabs' };
  const params = [...url.searchParams].filter(([name]) => name !== 'q' && name !== 'page');
  return { kind: 'search', action: url.pathname, query: url.searchParams.get('q') ?? '', params };
}

/** Products whose title contains the query, case-insensitive, in order; none for an empty query. */
function searched(products: readonly Product[], query: string): readonly Product[] {
  const needle = query.trim().toLowerCase();
  return needle ? products.filter((p) => p.title.toLowerCase().includes(needle)) : [];
}

interface Wall {
  kind: WallKind;
  /** Pages up to this one render normally. */
  after: number;
}

function parseWall(url: URL): Wall | null {
  const kind = url.searchParams.get('wall');
  const after = intParam(url.searchParams.get('wallAfterPage'), 'wallAfterPage', 0) ?? 0;
  if (kind === null) return null;
  if (!(WALL_KINDS as readonly string[]).includes(kind)) {
    throw new HttpError(400, `invalid wall ${JSON.stringify(kind)}, expected one of ${WALL_KINDS.join(', ')}`);
  }
  return { kind: kind as WallKind, after };
}

/** Whether the wall stands for this page and request: past `wallAfterPage` and without the cookie that clears it. */
function walled(wall: Wall | null, page: number, jar: Map<string, string>): wall is Wall {
  if (!wall || page <= wall.after) return false;
  return !jar.has(wall.kind === 'login' ? SESSION_COOKIE : HUMAN_COOKIE);
}

/** Answer a walled catalog request: a redirect to the login form, a 403 challenge, or a 503 interstitial. */
function sendWall(res: ServerResponse, wall: Wall, url: URL, method: string): void {
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
  if (wall.kind === 'login') {
    res.writeHead(302, { location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`, 'cache-control': 'no-store' });
    return void res.end();
  }
  res.writeHead(wall.kind === 'captcha' ? 403 : 503, headers);
  res.end(method === 'HEAD' ? undefined : wall.kind === 'captcha' ? challengePage() : interstitialPage());
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function imageSvg(id: string): string {
  const hue = (Number.parseInt(id.replace(/\D/g, ''), 10) * 37) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="140" viewBox="0 0 220 140"><rect width="220" height="140" fill="hsl(${hue} 60% 70%)"/><text x="110" y="78" font-family="sans-serif" font-size="24" text-anchor="middle">${escapeHtml(id)}</text></svg>`;
}

/** Start a playground instance. Each instance has its own control state and request log. */
export async function startPlayground(opts: PlaygroundOptions = {}): Promise<Playground> {
  const products = opts.products ?? dataset;
  const host = opts.host ?? '127.0.0.1';
  const control: ControlState = { ...INITIAL_CONTROL };
  const requests: RequestRecord[] = [];
  let visitors = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const method = req.method ?? 'GET';
    requests.push({ method, path: url.pathname, cookie: req.headers.cookie, at: Date.now() });

    if (url.pathname === '/__control/reset' && method === 'POST') {
      Object.assign(control, INITIAL_CONTROL);
      return send(res, 200, JSON.stringify(control), 'application/json');
    }
    if (url.pathname === '/__control') {
      if (method === 'GET') return send(res, 200, JSON.stringify(control), 'application/json');
      if (method === 'POST') {
        let body: unknown;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch {
          throw new HttpError(400, 'control body must be JSON');
        }
        Object.assign(control, parseControl(body));
        return send(res, 200, JSON.stringify(control), 'application/json');
      }
      throw new HttpError(405, 'method not allowed');
    }
    if (url.pathname === '/login') {
      if (method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        const next = safeNext(form.get('next') ?? url.searchParams.get('next'));
        res.writeHead(302, { location: next, 'set-cookie': `${SESSION_COOKIE}=1; Path=/; SameSite=Lax`, 'cache-control': 'no-store' });
        return void res.end();
      }
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      return send(res, 200, loginPage(safeNext(url.searchParams.get('next'))), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/logout') {
      res.writeHead(302, { location: '/', 'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`, 'cache-control': 'no-store' });
      return void res.end();
    }
    if (url.pathname === '/challenge') {
      if (method === 'POST') {
        res.writeHead(204, { 'set-cookie': `${HUMAN_COOKIE}=1; Path=/; SameSite=Lax`, 'cache-control': 'no-store' });
        return void res.end();
      }
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      return send(res, 200, challengePage(), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/challenge/turnstile') return send(res, 200, turnstileFrame(), 'text/html; charset=utf-8');
    if (url.pathname === '/spa/login') {
      const ttl = intParam(url.searchParams.get('ttl'), 'ttl', 1) ?? null;
      if (method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        if (!form.get('user')?.trim() || !form.get('password')) throw new HttpError(400, 'user and password are required');
        res.writeHead(204, { 'set-cookie': `${SPA_COOKIE}=${spaSession(ttl)}; Path=/; SameSite=Lax`, 'cache-control': 'no-store' });
        return void res.end();
      }
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      return send(res, 200, spaLoginPage(ttl), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/spa/session') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return void res.end(JSON.stringify({ loggedIn: spaLoggedIn(cookies(req).get(SPA_COOKIE)) }));
    }
    if (url.pathname === '/spa') {
      const ttl = intParam(url.searchParams.get('ttl'), 'ttl', 1) ?? null;
      return send(res, 200, spaPage(products, { loggedIn: spaLoggedIn(cookies(req).get(SPA_COOKIE)), ttl, seed: control.seed }), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/forms/submit' && method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      return send(res, 200, formsSubmitPage(form.get('payload') ?? '{}'), 'text/html; charset=utf-8');
    }
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');

    if (url.pathname === '/focus-thief') return send(res, 200, focusThiefPage(), 'text/html; charset=utf-8');
    if (url.pathname === '/framed') return send(res, 200, framedPage(url.searchParams.get('show') ?? 'catalog'), 'text/html; charset=utf-8');
    if (url.pathname === '/framed/inner') return send(res, 200, framedInner(url.searchParams.get('view') ?? 'catalog', products, control.seed), 'text/html; charset=utf-8');
    if (url.pathname === '/forms') return send(res, 200, formsPage(), 'text/html; charset=utf-8');
    if (url.pathname === '/input-events') return send(res, 200, inputEventsPage(), 'text/html; charset=utf-8');
    if (url.pathname === '/csp') {
      // A strict policy: no inline or injected script or style runs unless CSP is bypassed.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'none'; style-src 'self'" });
      return void res.end('<!doctype html><title>CSP</title><h1 id="strict">strict</h1>');
    }
    if (url.pathname === '/' ) {
      res.writeHead(302, { location: '/catalog' });
      return void res.end();
    }
    if (url.pathname === '/catalog') {
      const wall = parseWall(url);
      const jar = cookies(req);
      const tier = intParam(url.searchParams.get('tier'), 'tier', 0, MAX_TIER) ?? control.tier;
      const seed = intParam(url.searchParams.get('seed'), 'seed', 0) ?? control.seed;
      const delayMs = intParam(url.searchParams.get('delayMs'), 'delayMs', 0) ?? control.delayMs;
      const sponsored = intParam(url.searchParams.get('sponsored'), 'sponsored', 0, products.length) ?? 0;
      const mixed = flag(url, 'mixed');
      const twins = flag(url, 'twins');
      const hover = flag(url, 'hover');
      const rows = intParam(url.searchParams.get('rows'), 'rows', 1, 24) ?? null;
      const chromeParam = url.searchParams.get('chrome');
      if (chromeParam !== null && !(CHROME_MODES as readonly string[]).includes(chromeParam)) {
        throw new HttpError(400, `invalid chrome ${JSON.stringify(chromeParam)}, expected one of ${CHROME_MODES.join(', ')}`);
      }
      const chrome = chromeParam as ChromeMode | null;
      const gate = parseGate(url);
      const headers: Record<string, string | string[]> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
      const setCookies: string[] = [];
      if (!req.headers.cookie?.includes(`${VISITOR_COOKIE}=`)) {
        setCookies.push(`${VISITOR_COOKIE}=v${++visitors}; Path=/; Max-Age=31536000; SameSite=Lax`);
      }

      // A search gate filters before pagination, so pages slice the matches.
      let shown: readonly Product[] = gate?.kind === 'search' ? searched(products, gate.query) : products;
      let pager: Pager | null = null;
      const paginate = url.searchParams.get('paginate');
      if (paginate === null && walled(wall, 1, jar)) return sendWall(res, wall, url, method);
      if (paginate !== null) {
        if (!(PAGINATE_KINDS as readonly string[]).includes(paginate)) {
          throw new HttpError(400, `invalid paginate ${JSON.stringify(paginate)}, expected one of ${PAGINATE_KINDS.join(', ')}`);
        }
        const kind = paginate as PaginateKind;
        const opts = {
          tier,
          seed,
          nextRel: url.searchParams.get('nextRel') === null ? true : flag(url, 'nextRel'),
          lastPageRepeats: flag(url, 'lastPageRepeats'),
          moreDisappears: flag(url, 'moreDisappears'),
        };
        let page = 1;
        if (kind === 'url') page = intParam(url.searchParams.get('page'), 'page', 1) ?? 1;
        if (kind === 'next') {
          const current = Number(jar.get(PAGE_COOKIE)) || 1;
          if (url.searchParams.get('go') === 'next') {
            // Advance, then redirect back to the catalog URL without `go`.
            res.writeHead(302, {
              location: withParams(url, { go: null }),
              'set-cookie': [...setCookies, `${PAGE_COOKIE}=${current + 1}; Path=/; SameSite=Lax`, `${ADVANCED_COOKIE}=1; Path=/; SameSite=Lax`],
              'cache-control': 'no-store',
            });
            return void res.end();
          }
          // Only the redirect after `go=next` keeps the page; any other visit starts over at page 1.
          page = jar.get(ADVANCED_COOKIE) === '1' ? current : 1;
          // A walled page keeps its cookies, so clearing the wall comes back to the same page.
          if (walled(wall, page, jar)) return sendWall(res, wall, url, method);
          setCookies.push(`${PAGE_COOKIE}=${page}; Path=/; SameSite=Lax`, `${ADVANCED_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`);
        }
        if (kind !== 'next' && walled(wall, page, jar)) return sendWall(res, wall, url, method);
        ({ products: shown, pager } = pagedView(shown, url, kind, page, opts));
      }

      let html: string;
      try {
        html = render(shown, { tier, seed, chrome, sponsored, pager, gate, category: products[0]?.category, mixed, rows, twins, hover });
      } catch (error) {
        if (error instanceof UnimplementedTierError) throw new HttpError(501, error.message);
        throw error;
      }
      if (delayMs > 0) await sleep(delayMs);
      if (setCookies.length > 0) headers['set-cookie'] = setCookies;
      res.writeHead(200, headers);
      return void res.end(method === 'HEAD' ? undefined : html);
    }
    if (url.pathname === '/results') {
      const count = intParam(url.searchParams.get('count'), 'count', 1, products.length) ?? RESULTS;
      const html = renderResults(products.slice(0, count), url.searchParams.get('q') ?? undefined);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(method === 'HEAD' ? undefined : html);
    }
    if (url.pathname === '/catalog/more') {
      const after = intParam(url.searchParams.get('after'), 'after', 0) ?? 0;
      const wall = parseWall(url);
      if (walled(wall, Math.floor(after / PAGE_SIZE) + 1, cookies(req))) {
        return send(res, wall.kind === 'login' ? 401 : wall.kind === 'captcha' ? 403 : 503, '', 'text/html; charset=utf-8');
      }
      const tier = intParam(url.searchParams.get('tier'), 'tier', 0, MAX_TIER) ?? control.tier;
      const seed = intParam(url.searchParams.get('seed'), 'seed', 0) ?? control.seed;
      try {
        return send(res, 200, renderCards(products.slice(after, after + PAGE_SIZE), { tier, seed }), 'text/html; charset=utf-8');
      } catch (error) {
        if (error instanceof UnimplementedTierError) throw new HttpError(501, error.message);
        throw error;
      }
    }
    const imageMatch = /^\/img\/(p\d+)\.svg$/.exec(url.pathname);
    if (imageMatch) return send(res, 200, imageSvg(imageMatch[1]!), 'image/svg+xml');
    const productMatch = /^\/p\/(p\d+)$/.exec(url.pathname);
    if (productMatch) {
      const product = products.find((p) => p.id === productMatch[1]);
      if (product) {
        return send(
          res,
          200,
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(product.title)}</title></head><body><h1>${escapeHtml(product.title)}</h1><p><a href="/catalog">Back to catalog</a></p></body></html>`,
          'text/html; charset=utf-8',
        );
      }
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return void res.end();
    }
    throw new HttpError(404, `not found: ${url.pathname}`);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return void res.end();
      if (error instanceof HttpError) return send(res, error.status, `${error.status} ${error.message}\n`);
      send(res, 500, `500 ${(error as Error).message}\n`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    url: `http://${host}:${port}`,
    control,
    requests,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
