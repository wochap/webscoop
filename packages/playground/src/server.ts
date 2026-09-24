import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dataset, type Product } from './dataset';
import { CHROME_MODES, escapeHtml, MAX_TIER, render, UnimplementedTierError, type ChromeMode } from './render';

export interface ControlState {
  tier: number;
  seed: number;
  delayMs: number;
}

export const INITIAL_CONTROL: Readonly<ControlState> = Object.freeze({ tier: 0, seed: 1, delayMs: 0 });

/** Routes and query parameters reserved for later changes. */
export const RESERVED_ROUTES = ['/login', '/challenge'] as const;
export const RESERVED_PARAMS = ['wall', 'paginate', 'nextRel', 'lastPageRepeats', 'moreDisappears'] as const;

export const VISITOR_COOKIE = 'ws_visitor';

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
    if ((RESERVED_ROUTES as readonly string[]).includes(url.pathname)) {
      throw new HttpError(501, `${url.pathname} is reserved for a later change`);
    }
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');

    if (url.pathname === '/' ) {
      res.writeHead(302, { location: '/catalog' });
      return void res.end();
    }
    if (url.pathname === '/catalog') {
      for (const param of RESERVED_PARAMS) {
        if (url.searchParams.has(param)) throw new HttpError(501, `query parameter ${param} is reserved for a later change`);
      }
      const tier = intParam(url.searchParams.get('tier'), 'tier', 0, MAX_TIER) ?? control.tier;
      const seed = intParam(url.searchParams.get('seed'), 'seed', 0) ?? control.seed;
      const delayMs = intParam(url.searchParams.get('delayMs'), 'delayMs', 0) ?? control.delayMs;
      const sponsored = intParam(url.searchParams.get('sponsored'), 'sponsored', 0, products.length) ?? 0;
      const chromeParam = url.searchParams.get('chrome');
      if (chromeParam !== null && !(CHROME_MODES as readonly string[]).includes(chromeParam)) {
        throw new HttpError(400, `invalid chrome ${JSON.stringify(chromeParam)}, expected one of ${CHROME_MODES.join(', ')}`);
      }
      const chrome = chromeParam as ChromeMode | null;
      let html: string;
      try {
        html = render(products, { tier, seed, chrome, sponsored });
      } catch (error) {
        if (error instanceof UnimplementedTierError) throw new HttpError(501, error.message);
        throw error;
      }
      if (delayMs > 0) await sleep(delayMs);
      const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
      if (!req.headers.cookie?.includes(`${VISITOR_COOKIE}=`)) {
        headers['set-cookie'] = `${VISITOR_COOKIE}=v${++visitors}; Path=/; Max-Age=31536000; SameSite=Lax`;
      }
      res.writeHead(200, headers);
      return void res.end(method === 'HEAD' ? undefined : html);
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
