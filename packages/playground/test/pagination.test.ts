import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { dataset, pagerHtml, render, renderCards, startPlayground, type Playground } from '../src';

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
const ids = (html: string) => Array.from(doc(html).querySelectorAll('[data-product-id]')).map((el) => el.getAttribute('data-product-id'));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `p${String(from + i).padStart(2, '0')}`);
const nextLink = (html: string) =>
  Array.from(doc(html).querySelectorAll('nav a')).find((a) => a.textContent === 'Next') as HTMLAnchorElement | undefined;
const setCookies = (res: Response) => res.headers.getSetCookie();

async function get(pg: Playground, path: string, cookie?: string) {
  const res = await fetch(`${pg.url}${path}`, { redirect: 'manual', ...(cookie ? { headers: { cookie } } : {}) });
  return { res, html: await res.text() };
}

describe('paginated catalog, url kind', () => {
  it('slices 8 products per page with numbered links and a Next link', async () => {
    const pg = await start();
    const { res, html } = await get(pg, '/catalog?paginate=url&page=2');
    expect(res.status).toBe(200);
    expect(ids(html)).toEqual(range(9, 16));
    const links = Array.from(doc(html).querySelectorAll('nav[aria-label="Pagination"] a')).map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['1', '/catalog?paginate=url&page=1'],
      ['2', '/catalog?paginate=url&page=2'],
      ['3', '/catalog?paginate=url&page=3'],
      ['Next', '/catalog?paginate=url&page=3'],
    ]);
    expect(nextLink(html)!.getAttribute('rel')).toBe('next');
    expect(doc(html).querySelector('[aria-current="page"]')!.textContent).toBe('2');
    expect(ids((await get(pg, '/catalog?paginate=url')).html)).toEqual(range(1, 8));
  });

  it('interleaves questions blocks per page with mixed=1', async () => {
    const pg = await start();
    const { html } = await get(pg, '/catalog?paginate=url&page=1&mixed=1');
    const list = doc(html).querySelector('ul.product-list')!;
    expect(list.querySelectorAll('article.product-card')).toHaveLength(8);
    expect(list.querySelectorAll('.mixed-questions')).toHaveLength(2);
    expect(ids(html)).toEqual(range(1, 8));
    const second = doc((await get(pg, '/catalog?paginate=url&page=2&mixed=1&rows=4')).html);
    expect(second.querySelectorAll('.product-row')).toHaveLength(2);
    expect(second.querySelectorAll('.mixed-questions')).toHaveLength(2);
    expect(second.querySelectorAll('.mixed-ad')).toHaveLength(1);
  });

  it('has no Next link on page 3 and nothing beyond it', async () => {
    const pg = await start();
    const page3 = (await get(pg, '/catalog?paginate=url&page=3&tier=0')).html;
    expect(ids(page3)).toEqual(range(17, 24));
    expect(nextLink(page3)).toBeUndefined();
    expect(ids((await get(pg, '/catalog?paginate=url&page=4')).html)).toEqual([]);
  });

  it('repeats page 3 with a Next link beyond it when lastPageRepeats=1', async () => {
    const pg = await start();
    const { html } = await get(pg, '/catalog?paginate=url&page=4&lastPageRepeats=1');
    expect(ids(html)).toEqual(range(17, 24));
    expect(nextLink(html)!.getAttribute('href')).toBe('/catalog?paginate=url&page=5&lastPageRepeats=1');
  });

  it('keeps other parameters in the links and drops rel with nextRel=0', async () => {
    const pg = await start();
    const { html } = await get(pg, '/catalog?paginate=url&tier=0&nextRel=0');
    const next = nextLink(html)!;
    expect(next.getAttribute('href')).toBe('/catalog?paginate=url&tier=0&nextRel=0&page=2');
    expect(next.hasAttribute('rel')).toBe(false);
  });

  it('rejects an unknown kind and a bad switch', async () => {
    const pg = await start();
    expect((await get(pg, '/catalog?paginate=pages')).res.status).toBe(400);
    expect((await get(pg, '/catalog?paginate=url&nextRel=2')).res.status).toBe(400);
    expect((await get(pg, '/catalog?paginate=url&page=0')).res.status).toBe(400);
  });

  it('renders all 24 products without paginate', async () => {
    const pg = await start();
    const { html } = await get(pg, '/catalog');
    expect(ids(html)).toHaveLength(24);
    expect(html).not.toContain('Pagination');
  });
});

describe('paginated catalog, next kind', () => {
  it('advances the ws_page cookie on go=next and redirects back', async () => {
    const pg = await start();
    const first = await get(pg, '/catalog?paginate=next');
    expect(ids(first.html)).toEqual(range(1, 8));
    expect(setCookies(first.res).some((c) => c.startsWith('ws_page=1;'))).toBe(true);
    expect(nextLink(first.html)!.getAttribute('href')).toBe('/catalog?paginate=next&go=next');

    const go = await get(pg, '/catalog?paginate=next&go=next', 'ws_page=1');
    expect(go.res.status).toBe(302);
    expect(go.res.headers.get('location')).toBe('/catalog?paginate=next');
    expect(setCookies(go.res).some((c) => c.startsWith('ws_page=2;'))).toBe(true);

    const second = await get(pg, '/catalog?paginate=next', 'ws_page=2; ws_go=1');
    expect(ids(second.html)).toEqual(range(9, 16));
  });

  it('disables the Next link on page 3 and starts over on a plain visit', async () => {
    const pg = await start();
    const third = await get(pg, '/catalog?paginate=next', 'ws_page=3; ws_go=1');
    expect(ids(third.html)).toEqual(range(17, 24));
    const next = nextLink(third.html)!;
    expect(next.getAttribute('aria-disabled')).toBe('true');
    expect(next.hasAttribute('href')).toBe(false);
    expect(ids((await get(pg, '/catalog?paginate=next', 'ws_page=3')).html)).toEqual(range(1, 8));
  });

  it('keeps the Next link enabled past page 3 with lastPageRepeats=1', async () => {
    const pg = await start();
    const { html } = await get(pg, '/catalog?paginate=next&lastPageRepeats=1', 'ws_page=4; ws_go=1');
    expect(ids(html)).toEqual(range(17, 24));
    expect(nextLink(html)!.getAttribute('href')).toBe('/catalog?paginate=next&lastPageRepeats=1&go=next');
  });
});

describe('paginated catalog, more and scroll kinds', () => {
  it('renders 8 products and a Load more button with the fetch script', async () => {
    const pg = await start();
    const { html } = await get(pg, '/catalog?paginate=more&tier=0&seed=1');
    expect(ids(html)).toEqual(range(1, 8));
    const button = doc(html).querySelector('button[data-more]')!;
    expect(button.textContent).toBe('Load more');
    expect(html).toContain('/catalog/more?after=');
    expect(html).toContain('"disappear":false');
    expect((await get(pg, '/catalog?paginate=more&moreDisappears=1')).html).toContain('"disappear":true');
  });

  it('renders 8 products, a spacer, and a scroll script for scroll', async () => {
    const pg = await start();
    const { html } = await get(pg, '/catalog?paginate=scroll');
    expect(ids(html)).toEqual(range(1, 8));
    expect(doc(html).querySelector('button')).toBeNull();
    expect(html).toContain("addEventListener('scroll'");
  });

  it('serves the next 8 cards as a fragment with the page tokens', async () => {
    const pg = await start();
    const fragment = (await get(pg, '/catalog/more?after=8&tier=1&seed=4')).html;
    expect(ids(fragment)).toEqual(range(9, 16));
    expect(fragment.trimStart().startsWith('<li')).toBe(true);
    const page = (await get(pg, '/catalog?paginate=more&tier=1&seed=4')).html;
    const cardClass = (html: string) => doc(html).querySelector('[data-product-id]')!.getAttribute('class');
    expect(cardClass(fragment)).toBe(cardClass(page));
    expect(cardClass(page)).not.toContain('product-card');
    expect((await get(pg, '/catalog/more?after=24')).html).toBe('');
  });

  it('renders cards alone with the tier markup', () => {
    const cards = renderCards(dataset.slice(0, 2), { tier: 0, seed: 1 });
    expect(ids(cards)).toEqual(['p01', 'p02']);
    expect(cards).not.toContain('<ul');
    expect(render(dataset.slice(0, 8), { tier: 0, seed: 1, pager: { kind: 'url', next: null } })).toContain('<a class="pager-next" aria-disabled="true">Next</a>');
    expect(pagerHtml({ kind: 'next', next: '/n', rel: false })).toContain('<a class="pager-next" href="/n">Next</a>');
  });
});
