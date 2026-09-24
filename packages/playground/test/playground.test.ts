import { afterEach, describe, expect, it } from 'vitest';
import { dataset, formatPrice, render, startPlayground, type Playground } from '../src';

const running: Playground[] = [];
async function start() {
  const pg = await startPlayground({ port: 0 });
  running.push(pg);
  return pg;
}
afterEach(async () => {
  await Promise.all(running.splice(0).map((pg) => pg.stop()));
});

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('dataset', () => {
  it('has 24 products with unique ids and every field', () => {
    expect(dataset).toHaveLength(24);
    expect(new Set(dataset.map((p) => p.id)).size).toBe(24);
    for (const p of dataset) {
      expect(Object.keys(p).sort()).toEqual(['category', 'id', 'image', 'price', 'rating', 'title', 'url']);
    }
  });
});

describe('render', () => {
  it('renders tier 0 with 24 items in dataset order', () => {
    const html = render(dataset, { tier: 0, seed: 1 });
    expect(count(html, 'data-testid="product-card"')).toBe(24);
    expect(count(html, 'data-testid="price"')).toBe(24);
    expect(count(html, '<h2 class="product-title">')).toBe(24);
    expect(html).toContain('<h1 class="category-heading" id="category" data-testid="category">Electronics</h1>');
    const positions = dataset.map((p) => html.indexOf(`>${p.title.replace('&', '&amp;')}</h2>`));
    expect(positions.every((pos) => pos > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).toContain(formatPrice(1299));
    expect(formatPrice(1299)).toBe('$1,299.00');
  });

  it('is byte-identical for the same seed', () => {
    expect(render(dataset, { tier: 0, seed: 7 })).toBe(render(dataset, { tier: 0, seed: 7 }));
  });

  it('wraps the catalog in hostile chrome only when asked', () => {
    const hostile = render(dataset, { tier: 0, seed: 1, chrome: 'hostile' });
    for (const marker of ['id="hostile-header"', 'id="promo-bar"', 'id="cookie-backdrop"', 'role="dialog"', 'window.__hostClicks', 'z-index: 2147483000', 'z-index: 99;', '!important']) {
      expect(hostile, marker).toContain(marker);
    }
    expect(hostile).toMatch(/#hostile-header \{ position: fixed; top: 0; left: 0; width: 100vw/);
    expect(count(hostile, 'data-testid="product-card"')).toBe(24);
    const plain = render(dataset, { tier: 0, seed: 1 });
    for (const marker of ['hostile', 'promo-bar', 'cookie', '__hostClicks']) expect(plain).not.toContain(marker);
  });

  it('marks the first N cards sponsored and keeps dataset order', () => {
    const html = render(dataset, { tier: 0, seed: 1, sponsored: 2 });
    expect(count(html, 'class="product-card sponsored"')).toBe(2);
    expect(count(html, 'data-sponsored="true"')).toBe(2);
    expect(html).toContain('<article class="product-card sponsored" id="product-p01" data-testid="product-card" data-product-id="p01" data-sponsored="true">');
    expect(html).toContain('<article class="product-card sponsored" id="product-p02" data-testid="product-card" data-product-id="p02" data-sponsored="true">');
    expect(html).toContain('<article class="product-card" id="product-p03" data-testid="product-card" data-product-id="p03">');
    const positions = dataset.map((p) => html.indexOf(`id="product-${p.id}"`));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(render(dataset, { tier: 0, seed: 1, sponsored: 0 })).toBe(render(dataset, { tier: 0, seed: 1 }));
  });

  it('throws for unimplemented tiers', () => {
    expect(() => render(dataset, { tier: 2, seed: 1 })).toThrow('tier 2');
  });
});

describe('server', () => {
  it('starts parallel instances on distinct random ports', async () => {
    const [a, b] = await Promise.all([start(), start()]);
    expect(a.port).toBeGreaterThan(0);
    expect(b.port).toBeGreaterThan(0);
    expect(a.port).not.toBe(b.port);
    const res = await fetch(`${a.url}/catalog`);
    expect(res.status).toBe(200);
    expect(count(await res.text(), 'data-testid="product-card"')).toBe(24);
  });

  it('serves identical markup for the same seed', async () => {
    const pg = await start();
    const one = await (await fetch(`${pg.url}/catalog?tier=0&seed=7`)).text();
    const two = await (await fetch(`${pg.url}/catalog?tier=0&seed=7`)).text();
    expect(one).toBe(two);
  });

  it('returns 501 naming the tier for tiers 1 to 4', async () => {
    const pg = await start();
    for (const tier of [1, 2, 3, 4]) {
      const res = await fetch(`${pg.url}/catalog?tier=${tier}`);
      expect(res.status).toBe(501);
      expect(await res.text()).toContain(`tier ${tier}`);
    }
  });

  it('serves chrome and sponsored options, and still returns 501 for tiers 1 to 4 with them', async () => {
    const pg = await start();
    const hostile = await (await fetch(`${pg.url}/catalog?tier=0&chrome=hostile&sponsored=2`)).text();
    expect(hostile).toContain('id="cookie-backdrop"');
    expect(count(hostile, 'data-sponsored="true"')).toBe(2);
    expect(await (await fetch(`${pg.url}/catalog?tier=0`)).text()).not.toContain('cookie-backdrop');
    for (const tier of [1, 2, 3, 4]) {
      const res = await fetch(`${pg.url}/catalog?tier=${tier}&chrome=hostile&sponsored=1`);
      expect(res.status).toBe(501);
      expect(await res.text()).toContain(`tier ${tier}`);
    }
    expect((await fetch(`${pg.url}/catalog?chrome=pretty`)).status).toBe(400);
    expect((await fetch(`${pg.url}/catalog?sponsored=99`)).status).toBe(400);
  });

  it('returns 400 for a tier out of range', async () => {
    const pg = await start();
    expect((await fetch(`${pg.url}/catalog?tier=9`)).status).toBe(400);
  });

  it('returns 501 for reserved routes and parameters', async () => {
    const pg = await start();
    expect((await fetch(`${pg.url}/login`)).status).toBe(501);
    expect((await fetch(`${pg.url}/challenge`)).status).toBe(501);
    expect((await fetch(`${pg.url}/catalog?paginate=next`)).status).toBe(501);
    expect((await fetch(`${pg.url}/catalog?wall=login`)).status).toBe(501);
  });

  it('delays the response by at least delayMs', async () => {
    const pg = await start();
    const started = performance.now();
    const res = await fetch(`${pg.url}/catalog?delayMs=300`);
    await res.text();
    expect(performance.now() - started).toBeGreaterThanOrEqual(295);
  });

  it('sets, reads, overrides, and resets control defaults', async () => {
    const pg = await start();
    const post = (body: unknown) =>
      fetch(`${pg.url}/__control`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
    expect(await post({ tier: 3, delayMs: 50 })).toEqual({ tier: 3, seed: 1, delayMs: 50 });
    expect(await (await fetch(`${pg.url}/__control`)).json()).toEqual({ tier: 3, seed: 1, delayMs: 50 });
    expect((await fetch(`${pg.url}/catalog`)).status).toBe(501);
    expect((await fetch(`${pg.url}/catalog?tier=0`)).status).toBe(200);
    await post({ tier: 0 });
    expect((await fetch(`${pg.url}/catalog`)).status).toBe(200);
    const reset = await (await fetch(`${pg.url}/__control/reset`, { method: 'POST' })).json();
    expect(reset).toEqual({ tier: 0, seed: 1, delayMs: 0 });
    expect(pg.control).toEqual({ tier: 0, seed: 1, delayMs: 0 });
  });

  it('keeps control state per instance', async () => {
    const [a, b] = await Promise.all([start(), start()]);
    await fetch(`${a.url}/__control`, { method: 'POST', body: JSON.stringify({ tier: 2 }) });
    expect(a.control.tier).toBe(2);
    expect(b.control.tier).toBe(0);
  });

  it('rejects unknown control keys', async () => {
    const pg = await start();
    const res = await fetch(`${pg.url}/__control`, { method: 'POST', body: JSON.stringify({ colour: 1 }) });
    expect(res.status).toBe(400);
  });

  it('sets a persistent visitor cookie and records request cookies', async () => {
    const pg = await start();
    const first = await fetch(`${pg.url}/catalog`);
    const cookie = first.headers.get('set-cookie');
    expect(cookie).toMatch(/^ws_visitor=v1;.*Max-Age=/);
    await fetch(`${pg.url}/catalog`, { headers: { cookie: 'ws_visitor=v1' } });
    expect(pg.requests.map((r) => r.cookie)).toEqual([undefined, 'ws_visitor=v1']);
  });
});
