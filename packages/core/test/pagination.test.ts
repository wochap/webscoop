import { describe, expect, it } from 'vitest';
import {
  annotate,
  createStrategy,
  Dedup,
  defaultLadder,
  descendantsOf,
  evaluateStop,
  extractPage,
  fingerprint,
  isDisabled,
  loadRecipe,
  recordEvents,
  RUN_EVENT_NAMES,
  RunEmitter,
  Runner,
  type PageSummary,
  type Recipe,
  type RecipeInput,
  type Row,
  type SelectorCandidate,
  type SerializedElement,
  type Session,
} from '../src';
import { FakeBrowser, h } from '../src/testing';
import { card, css, recipe as baseRecipe, testid, type CardSpec } from './helpers';

const BASE = 'https://shop.test/list';
const role = (value: string): SelectorCandidate => ({ strategy: 'role', value, stability: 'stable' });

/** Products `from` to `to`, 1-based, each with its own link `/p/<n - 1>`. */
function products(from: number, to: number): { spec: CardSpec; index: number }[] {
  return Array.from({ length: to - from + 1 }, (_, i) => ({ spec: { title: `Product ${from + i}`, price: `$${from + i}.00` }, index: from + i - 1 }));
}

function listPage(items: { spec: CardSpec; index: number }[], nav?: SerializedElement | false): SerializedElement {
  return h(
    'html',
    {},
    h('head', {}, h('title', {}, 'Catalog')),
    h(
      'body',
      {},
      h(
        'main',
        {},
        h('h1', { class: 'category-heading', 'data-testid': 'category' }, 'Electronics'),
        h('ul', {}, items.map(({ spec, index }) => h('li', {}, card(spec, index)))),
      ),
      nav ?? false,
    ),
  );
}

/** Products of page `page` (8 per page), 1-based. */
const slice = (page: number) => products((page - 1) * 8 + 1, page * 8);

const nextLink = (href: string | null, cls = 'next') =>
  h('nav', { class: 'pager' }, href === null ? h('a', { class: cls, 'aria-disabled': 'true' }, 'Next') : h('a', { class: cls, href, rel: 'next' }, 'Next'));

function pagedRecipe(pagination: RecipeInput['pagination'], overrides: Partial<RecipeInput> = {}): Recipe {
  const base = baseRecipe();
  return loadRecipe({
    ...base,
    url: `${BASE}?page={n}`,
    vars: [{ name: 'n', type: 'string' }],
    fields: base.fields.map((f) => (f.name === 'url' ? { ...f, attr: 'href', key: true } : f)),
    pagination,
    ...overrides,
  });
}

const URL_PAGINATION = { kind: 'url' as const, param: { name: 'n', start: 1, step: 1 }, limit: 3 as const };

function urlSite(pages: number, extra: (page: number) => { spec: CardSpec; index: number }[] = slice) {
  const browser = new FakeBrowser();
  for (let p = 1; p <= pages; p++) browser.setPage(`${BASE}?page=${p}`, { dom: listPage(extra(p)), title: `Page ${p}` });
  return browser;
}

function run(recipe: Recipe, browser: FakeBrowser, extra: Partial<ConstructorParameters<typeof Runner>[0]> = {}) {
  const emitter = new RunEmitter();
  const log = recordEvents(emitter);
  const runner = new Runner({ recipe, browser, profileDir: '/p', emitter, timeoutMs: 1000, ...extra });
  return { runner, log, result: runner.run() };
}

const titles = (rows: Row[]) => rows.map((r) => r.title);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `Product ${from + i}`);

describe('url strategy', () => {
  it('fills the page variable and navigates pages 1 to 3', async () => {
    const browser = urlSite(3);
    const { runner, log, result } = run(pagedRecipe(URL_PAGINATION), browser);
    const r = await result;
    expect(r.ok).toBe(true);
    expect(browser.visited).toEqual([`${BASE}?page=1`, `${BASE}?page=2`, `${BASE}?page=3`]);
    expect(titles(r.rows)).toEqual(range(1, 24));
    expect(r.rows.map((row) => row._page)).toEqual([...Array(8).fill(1), ...Array(8).fill(2), ...Array(8).fill(3)]);
    expect(r.rows.slice(8, 16).map((row) => row._index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(runner.states).toEqual(['idle', 'opening', 'navigating', 'extracting', 'paginating', 'navigating', 'extracting', 'paginating', 'navigating', 'extracting', 'done']);
    expect(r.report).toMatchObject({
      pageCount: 3,
      rowCount: 24,
      duplicateCount: 0,
      stopReason: 'limit',
      finalUrl: `${BASE}?page=3`,
      pages: [
        { page: 1, url: `${BASE}?page=1`, rows: 8 },
        { page: 2, url: `${BASE}?page=2`, rows: 8 },
        { page: 3, url: `${BASE}?page=3`, rows: 8 },
      ],
    });
    expect(log.of('page.advanced')).toEqual([
      { page: 2, kind: 'url' },
      { page: 3, kind: 'url' },
    ]);
    expect(log.of('pagination.stopped')).toEqual([{ page: 3, reason: 'limit' }]);
    expect(log.of('page.done')).toEqual([
      { page: 1, rows: 8 },
      { page: 2, rows: 8 },
      { page: 3, rows: 8 },
    ]);
  });

  it('starts at the page given with --var', async () => {
    const browser = urlSite(4);
    const r = await run(pagedRecipe({ ...URL_PAGINATION, limit: 2 }), browser, { vars: { n: '3' } }).result;
    expect(r.ok).toBe(true);
    expect(browser.visited).toEqual([`${BASE}?page=3`, `${BASE}?page=4`]);
    expect(titles(r.rows)).toEqual(range(17, 32));
    expect(r.rows[0]).toMatchObject({ _page: 1, _index: 0 });
  });

  it('builds the first URL before the browser opens and rejects a non-numeric page variable', async () => {
    expect(createStrategy(pagedRecipe(URL_PAGINATION), { n: '5' }).url).toBe(`${BASE}?page=5`);
    const browser = urlSite(1);
    const r = await run(pagedRecipe(URL_PAGINATION), browser, { vars: { n: 'x' } }).result;
    expect(r).toMatchObject({ ok: false, reason: 'invalid-input', fields: ['n'] });
    expect(browser.openedProfiles).toEqual([]);
  });

  it('sets the page as a query parameter when the template has no page variable', async () => {
    const browser = urlSite(2);
    browser.setPage(`${BASE}?page=1`, listPage(slice(1)));
    const recipe = pagedRecipe({ kind: 'url', param: { name: 'page', start: 1, step: 1 }, limit: 2 }, { url: `${BASE}?page=1`, vars: [] });
    const r = await run(recipe, browser).result;
    expect(r.ok).toBe(true);
    expect(browser.visited).toEqual([`${BASE}?page=1`, `${BASE}?page=2`]);
  });

  it('stops without counting an empty page', async () => {
    const browser = urlSite(4, (p) => (p <= 3 ? slice(p) : []));
    const r = await run(pagedRecipe({ ...URL_PAGINATION, limit: 'all' }), browser).result;
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(24);
    expect(r.report).toMatchObject({ pageCount: 3, stopReason: 'no-new-items' });
  });

  it('applies the per-run limit override and the delay between pages', async () => {
    const browser = urlSite(3);
    const started = Date.now();
    const r = await run(pagedRecipe({ ...URL_PAGINATION, limit: 1, delayMs: 5000 }), browser, { pagination: { limit: 3, delayMs: 40 } }).result;
    expect(r.ok).toBe(true);
    expect(r.report.pageCount).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });
});

describe('next strategy', () => {
  function nextSite(lastHref: string | null = null) {
    return new FakeBrowser({
      [BASE]: listPage(slice(1), nextLink('/list?p=2')),
      [`${BASE}?p=2`]: listPage(slice(2), nextLink('/list?p=3')),
      [`${BASE}?p=3`]: listPage(slice(3), nextLink(lastHref)),
    });
  }
  const nextRecipe = (extra: Partial<RecipeInput['pagination']> = {}) =>
    pagedRecipe({ kind: 'next', target: { selectors: [role('link|Next'), css('a.next')] }, limit: 'all', ...extra }, { url: BASE, vars: [] });

  it('clicks through three pages and stops when the link is disabled', async () => {
    const browser = nextSite();
    const { runner, log, result } = run(nextRecipe(), browser);
    const r = await result;
    expect(r.ok).toBe(true);
    expect(titles(r.rows)).toEqual(range(1, 24));
    expect(browser.visited).toEqual([BASE, `${BASE}?p=2`, `${BASE}?p=3`]);
    expect(r.report).toMatchObject({ pageCount: 3, stopReason: 'target-missing', pagination: { outcome: { kind: 'candidate', index: 0 } } });
    expect(runner.states.slice(-3)).toEqual(['extracting', 'paginating', 'done']);
    expect(log.of('page.advanced')).toEqual([
      { page: 2, kind: 'next' },
      { page: 3, kind: 'next' },
    ]);
  });

  it('treats disabled, aria-disabled, and href-less controls as disabled', async () => {
    const browser = new FakeBrowser({
      [BASE]: h(
        'html',
        {},
        h('body', {}, h('button', { id: 'a', disabled: '' }, 'More'), h('a', { id: 'b', 'aria-disabled': 'true', href: '/x' }, 'Next'), h('a', { id: 'c' }, 'Next'), h('a', { id: 'd', href: '/x' }, 'Next')),
      ),
    });
    const session = await browser.open('/p');
    await session.goto(BASE, { timeoutMs: 1000 });
    const disabled = async (id: string) => isDisabled(session, (await session.resolve({ strategy: 'id', value: id, stability: 'stable' }))[0]!);
    expect([await disabled('a'), await disabled('b'), await disabled('c'), await disabled('d')]).toEqual([true, true, true, false]);
  });

  it('stops with the loop guard when the next link leads back to the same page', async () => {
    const browser = nextSite('/list?p=3');
    const r = await run(nextRecipe(), browser).result;
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(24);
    expect(r.report).toMatchObject({ pageCount: 4, stopReason: 'loop', duplicateCount: 8 });
    expect(r.report.pages[3]).toEqual({ page: 4, url: `${BASE}?p=3`, rows: 0 });
  });

  it('prefers the loop guard over first-item-repeats on the same URL', async () => {
    const r = await run(nextRecipe({ stopRules: ['first-item-repeats'] }), nextSite('/list?p=3')).result;
    expect(r.report).toMatchObject({ pageCount: 4, stopReason: 'loop' });
  });

  it('stops on first-item-repeats without counting the repeated page', async () => {
    const browser = nextSite('/list?p=4').setPage(`${BASE}?p=4`, listPage(slice(3), nextLink('/list?p=5')));
    const r = await run(nextRecipe({ stopRules: ['first-item-repeats'] }), browser).result;
    expect(r.report).toMatchObject({ pageCount: 3, stopReason: 'first-item-repeats', duplicateCount: 0 });
    expect(r.rows).toHaveLength(24);
  });

  it('heals the next link by fingerprint and promotes pagination.target on write-back', async () => {
    const recorded = listPage(slice(1), nextLink('/list?p=2', 'next'));
    const link = descendantsOf(annotate(recorded)).find((n) => n.tag === 'a' && n.attrs.rel === 'next')!;
    const browser = new FakeBrowser({
      [BASE]: listPage(slice(1), nextLink('/list?p=2', 'x9f3k2a')),
      [`${BASE}?p=2`]: listPage(slice(2), nextLink('/list?p=3', 'x9f3k2a')),
      [`${BASE}?p=3`]: listPage(slice(3), nextLink(null, 'x9f3k2a')),
    });
    const recipe = pagedRecipe(
      { kind: 'next', target: { selectors: [css('a.next'), css('#next-page')], fingerprint: fingerprint(link) }, limit: 'all' },
      { url: BASE, vars: [] },
    );
    const saved: Recipe[] = [];
    const { log, result } = run(recipe, browser, { saveRecipe: async (r) => (saved.push(r), '/recipes/shop.json') });
    const r = await result;
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(24);
    expect(r.report.pagination?.outcome.kind).toBe('fuzzy');
    expect(r.report.healed).toBe(1);
    expect(log.of('field.healed').map((e) => e.target)).toEqual(['pagination']);
    expect(saved).toHaveLength(1);
    const promoted = saved[0]!.pagination.target!.selectors;
    expect(promoted[0]).not.toEqual(css('a.next'));
    const session = await browser.open('/check');
    await session.goto(BASE, { timeoutMs: 1000 });
    expect(await session.resolve(promoted[0]!)).toHaveLength(1);
  });
});

describe('more and scroll strategies', () => {
  const render = (count: number, button: (count: number) => boolean) =>
    listPage(products(1, count), button(count) && h('div', {}, h('button', { class: 'load-more', type: 'button' }, 'Load more')));

  it('clicks load more and extracts only the growth, until the button is gone', async () => {
    const draw = (count: number) => render(count, (c) => c < 24);
    const browser = new FakeBrowser({ [BASE]: { dom: draw(8), render: draw, more: [16, 24] } });
    const recipe = pagedRecipe({ kind: 'more', target: { selectors: [role('button|Load more')] }, limit: 'all' }, { url: BASE, vars: [] });
    const { runner, log, result } = run(recipe, browser);
    const r = await result;
    expect(r.ok).toBe(true);
    expect(titles(r.rows)).toEqual(range(1, 24));
    expect(r.rows.filter((row) => row._page === 2).map((row) => row._index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(r.report).toMatchObject({ pageCount: 3, stopReason: 'target-missing', duplicateCount: 0 });
    expect(runner.states).toEqual(['idle', 'opening', 'navigating', 'extracting', 'paginating', 'extracting', 'paginating', 'extracting', 'paginating', 'done']);
    expect(log.of('page.loaded')).toHaveLength(1);
    expect(browser.clicks).toHaveLength(2);
  });

  it('stops with target-missing when the button vanishes after the first click', async () => {
    const draw = (count: number) => render(count, (c) => c === 8);
    const browser = new FakeBrowser({ [BASE]: { dom: draw(8), render: draw, more: [16, 24] } });
    const recipe = pagedRecipe({ kind: 'more', target: { selectors: [role('button|Load more')] }, limit: 'all' }, { url: BASE, vars: [] });
    const r = await run(recipe, browser).result;
    expect(r.rows).toHaveLength(16);
    expect(r.report).toMatchObject({ pageCount: 2, stopReason: 'target-missing' });
  });

  it('scrolls until the item count stops growing', async () => {
    const draw = (count: number) => listPage(products(1, count));
    const browser = new FakeBrowser({ [BASE]: { dom: draw(8), render: draw, scroll: [16, 24] } });
    const recipe = pagedRecipe({ kind: 'scroll', limit: 'all' }, { url: BASE, vars: [] });
    const { log, result } = run(recipe, browser, { timeoutMs: 50 });
    const r = await result;
    expect(r.ok).toBe(true);
    expect(titles(r.rows)).toEqual(range(1, 24));
    expect(r.report).toMatchObject({ pageCount: 3, stopReason: 'no-growth' });
    expect(log.of('page.advanced').map((e) => e.page)).toEqual([2, 3, 4]);
  });
});

describe('extractPage across pages', () => {
  async function open(dom: SerializedElement) {
    const session = await new FakeBrowser({ [BASE]: dom }).open('/p');
    await session.goto(BASE, { timeoutMs: 1000 });
    const calls: string[] = [];
    const spy: Session = Object.create(session) as Session;
    spy.resolve = (candidate, within) => {
      calls.push(candidate.value);
      return session.resolve(candidate, within);
    };
    return { session: spy, calls };
  }

  const recipe = () => {
    const base = baseRecipe();
    return loadRecipe({ ...base, fields: base.fields.map((f) => (f.name === 'title' ? { ...f, selectors: [css('h3.gone'), css('h2')] } : f)) });
  };

  it('reuses the selectors page 1 settled on, without the ladder', async () => {
    const first = await open(listPage(slice(1)));
    const page1 = await extractPage(first.session, recipe(), { pageUrl: BASE, page: 1, ladder: defaultLadder({ enabled: true }) });
    expect(first.calls).toContain('h3.gone');
    expect(page1.resolved).toEqual({ item: [testid('product-card')], fields: [[css('h2')], [testid('price')], [css('a.product-link')], [testid('category')]] });

    const second = await open(listPage(slice(2)));
    const page2 = await extractPage(second.session, recipe(), { pageUrl: BASE, page: 2, resolved: page1.resolved });
    expect(second.calls).not.toContain('h3.gone');
    expect(titles(page2.rows)).toEqual(range(9, 16));
    expect(page2.rows.every((r) => r._page === 2)).toBe(true);
    expect(page2.missingRequired).toEqual([]);
  });

  it('extracts only containers from fromIndex on, numbered from 0', async () => {
    const { session } = await open(listPage(products(1, 16)));
    const page1 = await extractPage(session, recipe(), { pageUrl: BASE, page: 1 });
    const grown = await extractPage(session, recipe(), { pageUrl: BASE, page: 2, resolved: page1.resolved, fromIndex: 8 });
    expect(grown.rows.map((r) => r._index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(titles(grown.rows)).toEqual(range(9, 16));
  });
});

describe('dedup and stop rules', () => {
  it('drops rows an earlier page had, by key, and counts them', async () => {
    const browser = urlSite(2, (p) => (p === 1 ? slice(1) : [...products(7, 8), ...products(9, 14)]));
    const r = await run(pagedRecipe({ ...URL_PAGINATION, limit: 2 }), browser).result;
    expect(r.ok).toBe(true);
    expect(titles(r.rows)).toEqual(range(1, 14));
    expect(r.report).toMatchObject({ duplicateCount: 2, pages: [{ rows: 8 }, { rows: 6 }] });
    expect(r.rows.filter((row) => row._page === 2).map((row) => row._index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('dedups by all field values without a key, and never within page 1', () => {
    const recipe = loadRecipe(baseRecipe());
    const dedup = new Dedup(recipe);
    const row = (title: string, price: number): Row => ({ _page: 1, _index: 0, title, price, url: null, category: 'x' });
    const page1 = dedup.preview([row('a', 1), row('a', 1)], 1);
    expect(page1.kept).toHaveLength(2);
    page1.commit();
    const page2 = dedup.preview([row('a', 1), row('a', 2), row('a', 2)], 2);
    expect(page2.kept).toEqual([row('a', 2)]);
    expect(dedup.duplicates).toBe(0);
    page2.commit();
    expect(dedup.duplicates).toBe(2);
  });

  it('evaluates the rules in order', () => {
    const page = (n: number, url: string, firstKey: string | null, raw = 8, kept = raw): PageSummary => ({ page: n, url, firstKey, raw, kept });
    const base = { kind: 'url' as const, stopRules: [] as string[], limit: 'all' as const, cap: 500 };
    expect(evaluateStop({ ...base, current: page(1, 'a', 'k1'), previous: null })).toEqual({ reason: null, discard: false });
    expect(evaluateStop({ ...base, current: page(2, 'b', null, 0), previous: page(1, 'a', 'k1') })).toEqual({ reason: 'no-new-items', discard: true });
    expect(evaluateStop({ ...base, stopRules: ['first-item-repeats'], current: page(2, 'a', 'k1', 8, 0), previous: page(1, 'a', 'k1') })).toEqual({
      reason: 'loop',
      discard: false,
    });
    expect(evaluateStop({ ...base, stopRules: ['no-new-items', 'first-item-repeats'], current: page(2, 'b', 'k1', 8, 0), previous: page(1, 'a', 'k1') })).toEqual({
      reason: 'no-new-items',
      discard: false,
    });
    expect(evaluateStop({ ...base, stopRules: ['first-item-repeats'], current: page(2, 'b', 'k1', 8, 0), previous: page(1, 'a', 'k1') })).toEqual({
      reason: 'first-item-repeats',
      discard: true,
    });
    expect(evaluateStop({ ...base, current: page(2, 'b', 'k1', 8, 0), previous: page(1, 'a', 'k1') })).toEqual({ reason: null, discard: false });
    expect(evaluateStop({ ...base, kind: 'none', limit: 3 as never, current: page(1, 'a', 'k1'), previous: null }).reason).toBe('none');
    expect(evaluateStop({ ...base, limit: 2 as never, current: page(2, 'b', 'k2'), previous: page(1, 'a', 'k1') }).reason).toBe('limit');
    expect(evaluateStop({ ...base, cap: 2, current: page(2, 'b', 'k2'), previous: page(1, 'a', 'k1') }).reason).toBe('cap');
  });

  it('keeps walking a repeating last page without rules until the cap, and warns', async () => {
    const browser = urlSite(6, (p) => slice(Math.min(p, 3)));
    const r = await run(pagedRecipe({ ...URL_PAGINATION, limit: 'all' }), browser, { pagination: { cap: 5 } }).result;
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(24);
    expect(r.report).toMatchObject({ pageCount: 5, stopReason: 'cap', duplicateCount: 16 });
    expect(r.report.warnings.some((w) => w.includes('cap of 5'))).toBe(true);
  });

  it('stops on a repeating last page with first-item-repeats', async () => {
    const browser = urlSite(6, (p) => slice(Math.min(p, 3)));
    const r = await run(pagedRecipe({ ...URL_PAGINATION, limit: 'all', stopRules: ['first-item-repeats'] }), browser).result;
    expect(r.report).toMatchObject({ pageCount: 3, stopReason: 'first-item-repeats', duplicateCount: 0 });
    expect(browser.visited).toHaveLength(4);
  });
});

describe('runner page loop', () => {
  it('orders page.done, page.advanced, and page.loaded across pages', async () => {
    const { log, result } = run(pagedRecipe({ ...URL_PAGINATION, limit: 2 }), urlSite(2));
    await result;
    const at = (name: string, page: number) => log.events.findIndex((e) => e.name === name && (e.payload as { page: number }).page === page);
    expect(at('page.done', 1)).toBeLessThan(at('page.advanced', 2));
    expect(at('page.advanced', 2)).toBeLessThan(at('page.loaded', 2));
    expect(at('page.loaded', 2)).toBeLessThan(at('page.done', 2));
    expect(log.sequence().slice(-3)).toEqual(['page.done', 'pagination.stopped', 'run.done']);
    expect(log.of('field.resolved')).toHaveLength(4);
    expect(RUN_EVENT_NAMES).toContain('page.advanced');
    expect(RUN_EVENT_NAMES).toContain('pagination.stopped');
  });

  it('reports kind none as one page stopped with reason none', async () => {
    const browser = new FakeBrowser({ [`${BASE}?page=1`]: listPage(slice(1)) });
    const { runner, result } = run(pagedRecipe({ kind: 'none' }, { url: `${BASE}?page=1`, vars: [] }), browser, { pagination: { limit: 'all' } });
    const r = await result;
    expect(r.report).toMatchObject({ pageCount: 1, stopReason: 'none' });
    expect(runner.states).toEqual(['idle', 'opening', 'navigating', 'extracting', 'done']);
  });

  it('saves promotions from page 1 once, after the last page', async () => {
    const recipe = pagedRecipe(URL_PAGINATION);
    recipe.fields[0]!.selectors = [css('h3.gone'), css('h2')];
    const saved: Recipe[] = [];
    const { log, result } = run(recipe, urlSite(3), { saveRecipe: async (r) => (saved.push(r), '/r.json') });
    const r = await result;
    expect(r.ok).toBe(true);
    expect(saved).toHaveLength(1);
    expect(log.of('field.healed')).toHaveLength(1);
    expect(log.of('recipe.saved')).toHaveLength(1);
    const names = log.names();
    expect(names.indexOf('recipe.saved')).toBeGreaterThan(names.lastIndexOf('page.done'));
  });

  it('fails with missing-required naming page 2 after emitting page 1', async () => {
    const browser = urlSite(2, (p) => (p === 1 ? slice(1) : slice(2).map((x) => ({ ...x, spec: { title: x.spec.title } }))));
    const { log, result } = run(pagedRecipe(URL_PAGINATION), browser);
    const r = await result;
    expect(r).toMatchObject({ ok: false, reason: 'missing-required', fields: ['price'] });
    expect(r.ok === false && r.message).toContain('page 2');
    expect(log.of('row.emitted').map((e) => e.page)).toEqual(Array(8).fill(1));
    expect(log.of('page.done')).toEqual([{ page: 1, rows: 8 }]);
  });

  it('fails with timeout on a slow later page after emitting the earlier ones', async () => {
    const browser = urlSite(3);
    browser.setPage(`${BASE}?page=3`, { dom: listPage(slice(3)), delayMs: 5000 });
    const { log, result } = run(pagedRecipe(URL_PAGINATION), browser);
    const r = await result;
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    expect(log.of('row.emitted')).toHaveLength(16);
    expect(browser.openSessions).toBe(0);
  });
});

describe('playground-paged reference recipe', () => {
  it('loads and walks the url kind over three rendered pages', async () => {
    const { readFileSync } = await import('node:fs');
    const { dataset, render } = await import('@webscoop/playground');
    const { snapshotFromHtml } = await import('./snapshot');
    const recipe = loadRecipe(readFileSync(new URL('../../cli/fixtures/playground-paged.json', import.meta.url), 'utf8'));
    expect(recipe.pagination).toMatchObject({ kind: 'url', param: { name: 'page', start: 1, step: 1 }, limit: 'all' });
    expect(recipe.pagination.target!.selectors[0]).toEqual(role('link|Next'));
    expect(recipe.pagination.target!.fingerprint).toBeDefined();
    expect(recipe.fields.find((f) => f.key)?.name).toBe('url');

    const at = (page: number) => `http://127.0.0.1:4777/catalog?paginate=url&tier=0&page=${page}`;
    const browser = new FakeBrowser();
    for (let page = 1; page <= 4; page++) {
      const html = render(dataset.slice((page - 1) * 8, page * 8), { tier: 0, seed: 1, pager: { kind: 'url', ...(page < 3 ? { next: `/catalog?page=${page + 1}` } : {}) } });
      browser.setPage(at(page), snapshotFromHtml(html) as SerializedElement);
    }
    const r = await run(recipe, browser).result;
    expect(r.ok).toBe(true);
    expect(r.rows.map((row) => row.title)).toEqual(dataset.map((p) => p.title));
    expect(r.report).toMatchObject({ pageCount: 3, stopReason: 'no-new-items' });
  });
});
