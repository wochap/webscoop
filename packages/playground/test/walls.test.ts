import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { dataset, safeNext, startPlayground, type Playground } from '../src';

const running: Playground[] = [];
async function start() {
  const pg = await startPlayground({ port: 0 });
  running.push(pg);
  return pg;
}
afterEach(async () => {
  await Promise.all(running.splice(0).map((pg) => pg.stop()));
});

const doc = (html: string) => new JSDOM(html).window.document;
const visibleText = (html: string) => (doc(html).body.textContent ?? '').replace(/\s+/g, ' ').trim();
const products = (html: string) => doc(html).querySelectorAll('[data-product-id]').length;

async function get(pg: Playground, path: string, cookie?: string) {
  const res = await fetch(`${pg.url}${path}`, { redirect: 'manual', ...(cookie ? { headers: { cookie } } : {}) });
  return { res, html: await res.text() };
}

/** `name=value` of a response's Set-Cookie headers. */
const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ');

describe('login wall', () => {
  it('redirects the catalog to the login form with the original path and query', async () => {
    const pg = await start();
    const { res } = await get(pg, '/catalog?wall=login');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?next=%2Fcatalog%3Fwall%3Dlogin');
  });

  it('renders a username and password form that carries next', async () => {
    const pg = await start();
    const { res, html } = await get(pg, '/login?next=%2Fcatalog%3Fwall%3Dlogin');
    expect(res.status).toBe(200);
    const d = doc(html);
    expect(d.querySelector('input[name="username"]')).not.toBeNull();
    expect(d.querySelector('input[type="password"][name="password"]')).not.toBeNull();
    expect(d.querySelector('button[type="submit"]')).not.toBeNull();
    expect(d.querySelector<HTMLInputElement>('input[name="next"]')!.value).toBe('/catalog?wall=login');
  });

  it('sets the session cookie on POST, redirects to next, and then renders the catalog', async () => {
    const pg = await start();
    const res = await fetch(`${pg.url}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'anyone', password: 'anything', next: '/catalog?wall=login' }).toString(),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/catalog?wall=login');
    const cookie = cookieOf(res);
    expect(cookie).toBe('ws_sess=1');
    const back = await get(pg, '/catalog?wall=login', cookie);
    expect(back.res.status).toBe(200);
    expect(products(back.html)).toBe(dataset.length);
  });

  it('redirects to / without next and refuses other origins', async () => {
    const pg = await start();
    const res = await fetch(`${pg.url}/login`, { method: 'POST', redirect: 'manual', body: 'username=a&password=b' });
    expect(res.headers.get('location')).toBe('/');
    expect(safeNext('//evil.test/x')).toBe('/');
    expect(safeNext('https://evil.test/')).toBe('/');
    expect(safeNext('/catalog?page=2')).toBe('/catalog?page=2');
  });

  it('clears the cookie on logout', async () => {
    const pg = await start();
    const { res } = await get(pg, '/logout', 'ws_sess=1');
    expect(res.status).toBe(302);
    expect(res.headers.getSetCookie()[0]).toMatch(/^ws_sess=; .*Max-Age=0/);
  });
});

describe('captcha wall', () => {
  it('serves the catalog as a 403 challenge with the turnstile iframe, form, text, and button', async () => {
    const pg = await start();
    const { res, html } = await get(pg, '/catalog?wall=captcha');
    expect(res.status).toBe(403);
    const d = doc(html);
    expect(d.querySelector('iframe')!.getAttribute('src')).toContain('turnstile');
    expect(d.getElementById('challenge-form')).not.toBeNull();
    expect(visibleText(html)).toContain('Verify you are human');
    expect(Array.from(d.querySelectorAll('button')).map((b) => b.textContent)).toContain('I am human');
    expect(html).toContain("fetch('/challenge', { method: 'POST' })");
    expect(html).toContain('location.reload()');
    expect(products(html)).toBe(0);
  });

  it('sets ws_human on POST /challenge, after which the catalog renders', async () => {
    const pg = await start();
    const res = await fetch(`${pg.url}/challenge`, { method: 'POST' });
    expect(res.status).toBe(204);
    const cookie = cookieOf(res);
    expect(cookie).toBe('ws_human=1');
    const back = await get(pg, '/catalog?wall=captcha', cookie);
    expect(back.res.status).toBe(200);
    expect(products(back.html)).toBe(dataset.length);
  });

  it('serves /challenge directly for inspection, and its frame', async () => {
    const pg = await start();
    const { res, html } = await get(pg, '/challenge');
    expect(res.status).toBe(200);
    expect(html).toContain('Verify you are human');
    expect((await get(pg, '/challenge/turnstile')).res.status).toBe(200);
  });

  it('rejects an unknown wall', async () => {
    const pg = await start();
    expect((await get(pg, '/catalog?wall=moat')).res.status).toBe(400);
  });
});

describe('interstitial wall', () => {
  it('serves a 503 page with fewer than 200 visible characters and no product', async () => {
    const pg = await start();
    const { res, html } = await get(pg, '/catalog?wall=interstitial');
    expect(res.status).toBe(503);
    expect(visibleText(html.replace(/<script[\s\S]*?<\/script>/g, '')).length).toBeLessThan(200);
    expect(products(html)).toBe(0);
    expect((await get(pg, '/catalog?wall=interstitial', 'ws_human=1')).res.status).toBe(200);
  });
});

describe('wallAfterPage', () => {
  it('walls only pages beyond N on the url kind', async () => {
    const pg = await start();
    const path = (page: number) => `/catalog?wall=captcha&wallAfterPage=2&paginate=url&page=${page}`;
    expect((await get(pg, path(1))).res.status).toBe(200);
    expect((await get(pg, path(2))).res.status).toBe(200);
    const third = await get(pg, path(3));
    expect(third.res.status).toBe(403);
    expect(third.html).toContain('Verify you are human');
    expect((await get(pg, path(3), 'ws_human=1')).res.status).toBe(200);
  });

  it('walls the next cookie page beyond N and keeps the page cookie for the return', async () => {
    const pg = await start();
    const base = '/catalog?wall=login&wallAfterPage=2&paginate=next';
    expect((await get(pg, base)).res.status).toBe(200);
    // Advanced to page 3: the render request is walled and its cookies are left alone.
    const third = await get(pg, base, 'ws_page=3; ws_go=1');
    expect(third.res.status).toBe(302);
    expect(third.res.headers.get('location')).toBe(`/login?next=${encodeURIComponent(base)}`);
    expect(third.res.headers.getSetCookie()).toEqual([]);
    const after = await get(pg, base, 'ws_page=3; ws_go=1; ws_sess=1');
    expect(after.res.status).toBe(200);
    expect(doc(after.html).querySelector('[data-product-id]')!.getAttribute('data-product-id')).toBe('p17');
    expect((await get(pg, base, 'ws_page=2; ws_go=1')).res.status).toBe(200);
  });

  it('applies to the plain catalog as page 1', async () => {
    const pg = await start();
    expect((await get(pg, '/catalog?wall=login&wallAfterPage=1')).res.status).toBe(200);
    expect((await get(pg, '/catalog?wall=login&wallAfterPage=0')).res.status).toBe(302);
  });
});
