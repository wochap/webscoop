import { describe, expect, it } from 'vitest';
import { loadRecipe, recordEvents, RunEmitter, Runner, runRecipe, tablesOf, type BrowserPort, type Recipe, type RecipeInput } from '../src';
import { FakeBrowser, h } from '../src/testing';
import { card, catalog, cards, css, mixedPage, PAGE, recipe, tablesRecipe, testid } from './helpers';

function setup(dom = catalog(cards(24)), delayMs = 0) {
  const browser = new FakeBrowser({ [PAGE]: { dom, title: 'Catalog', delayMs } });
  const emitter = new RunEmitter();
  const log = recordEvents(emitter);
  return { browser, emitter, log };
}

describe('Runner', () => {
  it('walks the states and emits events in order', async () => {
    const { browser, emitter, log } = setup();
    const runner = new Runner({ recipe: loadRecipe(recipe()), browser, profileDir: '/prof/shop', emitter });
    const result = await runner.run();
    expect(result.ok).toBe(true);
    expect(runner.states).toEqual(['idle', 'opening', 'navigating', 'extracting', 'done']);
    expect(log.sequence()).toEqual(['run.start', 'page.loaded', 'field.resolved', 'row.emitted', 'page.done', 'pagination.stopped', 'run.done']);
    expect(log.of('field.resolved')).toHaveLength(4);
    expect(log.of('row.emitted')).toHaveLength(24);
    expect(browser.visited).toEqual([PAGE]);
    expect(browser.openedProfiles).toEqual(['/prof/shop']);
    expect(browser.openSessions).toBe(0);
    const report = log.of('run.done')[0]!.report;
    expect(report).toMatchObject({ recipe: 'shop', finalUrl: PAGE, pageCount: 1, rowCount: 24 });
    expect(report.fields.map((f) => f.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
  });

  it('fails with missing-required and emits no rows when a required field is missing everywhere', async () => {
    const { browser, emitter, log } = setup(catalog(cards(24, () => ({ price: undefined }))));
    const runner = new Runner({ recipe: loadRecipe(recipe()), browser, profileDir: '/p', emitter });
    const result = await runner.run();
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'missing-required', fields: ['price'], rows: [] });
    expect(runner.state).toBe('failed');
    expect(log.of('row.emitted')).toHaveLength(0);
    expect(log.of('run.failed')[0]).toMatchObject({ reason: 'missing-required', fields: ['price'] });
    expect(browser.openSessions).toBe(0);
  });

  it('drops rows missing a required field and warns on success', async () => {
    const { browser } = setup(catalog(cards(24, (i) => (i === 0 ? { price: undefined } : {}))));
    const result = await runRecipe({ recipe: loadRecipe(recipe()), browser, profileDir: '/p' });
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(23);
    expect(result.rows.every((row) => row.price !== null)).toBe(true);
    expect(result.rows.map((row) => row._index)).toEqual([...Array(23).keys()]);
    expect(result.report.warnings[0]).toContain('price');
    expect(result.report).toMatchObject({ rowCount: 23, droppedCount: 1, pages: [{ page: 1, rows: 23, dropped: 1 }] });
    expect(result.report.fields.find((f) => f.name === 'price')).toMatchObject({ status: 'partial', missingRows: [0] });
  });

  it('fails with missing-required when every row on the first page is dropped', async () => {
    const { browser } = setup(catalog(cards(24, (i) => (i < 12 ? { noLink: true } : { price: undefined }))));
    const result = await runRecipe({ recipe: loadRecipe(recipe()), browser, profileDir: '/p' });
    expect(result).toMatchObject({ ok: false, reason: 'missing-required', fields: ['price', 'url'] });
    expect(result.rows).toEqual([]);
  });

  it('fails before opening the browser when a variable has no value', async () => {
    const { browser, emitter, log } = setup();
    const r = recipe({ vars: [{ name: 'category', type: 'string' }] });
    const result = await runRecipe({ recipe: loadRecipe(r), browser, profileDir: '/p', emitter });
    expect(result).toMatchObject({ ok: false, reason: 'invalid-input', fields: ['category'] });
    expect(browser.openedProfiles).toEqual([]);
    expect(log.names()).toEqual(['run.failed']);
  });

  it('substitutes and encodes variables', async () => {
    const { browser } = setup();
    browser.setPage('https://shop.test/c/running%20shoes', catalog(cards(1)));
    const result = await runRecipe({
      recipe: loadRecipe(recipe()),
      browser,
      profileDir: '/p',
      vars: { category: 'running shoes' },
    });
    expect(result.ok).toBe(true);
    expect(browser.visited).toEqual(['https://shop.test/c/running%20shoes']);
  });

  it('maps a navigation timeout to reason timeout', async () => {
    const { browser } = setup(catalog(cards(1)), 5000);
    const result = await runRecipe({ recipe: loadRecipe(recipe()), browser, profileDir: '/p', timeoutMs: 100 });
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    expect(browser.openSessions).toBe(0);
  });

  it('closes the session and reports aborted when the signal fires', async () => {
    let closed = false;
    let releaseGoto!: () => void;
    const browser: BrowserPort = {
      async open() {
        return {
          goto: () =>
            new Promise((_, reject) => {
              releaseGoto = () => reject(new Error('Target closed'));
            }),
          resolve: async () => [],
          read: async () => '',
          same: async () => false,
          snapshot: async () => ({ type: 'text', text: '' }),
          click: async () => {},
          fill: async () => {},
          press: async () => {},
          selectOption: async () => {},
          scrollToBottom: async () => {},
          settle: async () => ({ url: '', title: '', status: null }),
          url: async () => '',
          focus: async () => {},
          setTitle: async () => {},
          pageText: async () => '',
          close: async () => {
            closed = true;
            releaseGoto();
          },
        };
      },
    };
    const controller = new AbortController();
    const running = runRecipe({ recipe: loadRecipe(recipe()), browser, profileDir: '/p', signal: controller.signal });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const result = await running;
    expect(closed).toBe(true);
    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
  });
});

describe('Runner abort while opening', () => {
  it('closes a session that finishes opening after the abort', async () => {
    const browser = new FakeBrowser({ [PAGE]: catalog(cards(1)) });
    const controller = new AbortController();
    const open = browser.open.bind(browser);
    browser.open = async (dir) => {
      const session = await open(dir);
      controller.abort();
      return session;
    };
    const result = await runRecipe({ recipe: loadRecipe(recipe()), browser, profileDir: '/p', signal: controller.signal });
    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
    expect(browser.openSessions).toBe(0);
  });
});

describe('Runner with a list parent', () => {
  /** The catalog plus a sidebar list of 4 cards, after the main list. */
  function withSidebar() {
    const dom = catalog(cards(24));
    const body = dom.children.find((c) => c.type === 'element' && c.tag === 'body') as ReturnType<typeof catalog>;
    body.children.push(h('aside', {}, h('ul', { class: 'sidebar' }, cards(4, (i) => ({ title: `Related ${i + 1}` })).map((c, i) => h('li', {}, card(c, 100 + i))))));
    return dom;
  }
  const role = (value: string) => ({ strategy: 'role' as const, value, stability: 'stable' as const });

  it('resolves containers inside the list parent and leaves the sidebar out', async () => {
    const { browser } = setup(withSidebar());
    const scoped = recipe({ item: { selectors: [role('listitem')], within: [role('list')] } });
    const result = await runRecipe({ recipe: loadRecipe(scoped), browser, profileDir: '/p' });
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(24);
    expect(result.rows.some((r) => String(r.title).startsWith('Related'))).toBe(false);
    expect(result.report.item).toMatchObject({ count: 24, within: { candidateIndex: 0, candidate: role('list'), outcome: { kind: 'candidate', index: 0 } } });

    const unscoped = await runRecipe({ recipe: loadRecipe(recipe({ item: { selectors: [role('listitem')] } })), browser, profileDir: '/p' });
    expect(unscoped.rows).toHaveLength(28);
    expect(unscoped.report.item!.within).toBeUndefined();
  });

  it('reports within as missing and the container unresolved when the list parent matches nothing', async () => {
    const { browser, emitter, log } = setup(withSidebar());
    const missing = recipe({ item: { selectors: [role('listitem')], within: [css('ol.gone')] } });
    const result = await runRecipe({ recipe: loadRecipe(missing), browser, profileDir: '/p', emitter, healing: { enabled: false, writeBack: false } });
    expect(result).toMatchObject({ ok: false, reason: 'missing-required', rows: [] });
    expect(result.ok === false && result.fields).toEqual(['within', 'item']);
    expect(result.ok === false && result.message).toContain('item.within');
    const report = log.of('run.failed')[0]!.report;
    expect(report.item).toMatchObject({ count: 0, outcome: { kind: 'unresolved' }, within: { candidate: null, outcome: { kind: 'unresolved' } } });
  });

  it('falls back to the document with a warning when healing cannot find the list parent', async () => {
    const { browser } = setup(withSidebar());
    const missing = recipe({ item: { selectors: [role('listitem')], within: [css('ol.gone')] } });
    const result = await runRecipe({ recipe: loadRecipe(missing), browser, profileDir: '/p' });
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(28);
    expect(result.report.item!.within!.outcome).toEqual({ kind: 'unresolved' });
    expect(result.report.warnings.join('\n')).toContain('item.within');
  });
});

describe('Runner with tables', () => {
  const QUESTIONS = ['Is it waterproof?', 'Does it ship abroad?'];
  const run = (dom: ReturnType<typeof mixedPage>, r = tablesRecipe()) => {
    const { browser, emitter, log } = setup(dom);
    return { log, result: runRecipe({ recipe: loadRecipe(r), browser, profileDir: '/p', emitter }) };
  };
  /** The tables recipe with one table changed. */
  const edit = (index: number, patch: (table: NonNullable<RecipeInput['tables']>[number]) => NonNullable<RecipeInput['tables']>[number]) => {
    const r = tablesRecipe();
    return { ...r, tables: r.tables!.map((t, i) => (i === index ? patch(t) : t)) };
  };

  it('emits rows table by table, each naming its table, and reports every table', async () => {
    const { log, result } = run(mixedPage(cards(4), QUESTIONS));
    const out = await result;
    expect(out.ok).toBe(true);
    expect(log.sequence()).toEqual(['run.start', 'page.loaded', 'field.resolved', 'row.emitted', 'page.done', 'pagination.stopped', 'run.done']);
    expect(log.of('row.emitted').map((e) => e.table)).toEqual(['page', 'products', 'products', 'products', 'products', 'questions', 'questions']);
    expect(log.of('row.emitted').map((e) => e.row._index)).toEqual([0, 0, 1, 2, 3, 0, 1]);
    expect(log.of('field.resolved').map((e) => `${e.table}.${e.field.name}`)).toEqual(['page.heading', 'products.title', 'products.url', 'questions.title']);
    const report = out.report;
    expect(report.rowCount).toBe(7);
    expect(report.tables.map((t) => [t.name, t.rowCount, t.duplicateCount, t.droppedCount])).toEqual([
      ['page', 1, 0, 0],
      ['products', 4, 0, 0],
      ['questions', 2, 0, 0],
    ]);
    expect(report.tables[0]!.item).toBeNull();
    expect(report.tables[1]!.item?.count).toBe(4);
    expect(report.tables[2]!.fields.map((f) => f.name)).toEqual(['title']);
    // The top level mirrors the primary table.
    expect(report.item).toEqual(report.tables[1]!.item);
    expect(report.fields).toEqual(report.tables[1]!.fields);
    expect(report.pages).toEqual([
      {
        page: 1,
        url: PAGE,
        rows: 7,
        dropped: 0,
        tables: [
          { name: 'page', rows: 1, dropped: 0 },
          { name: 'products', rows: 4, dropped: 0 },
          { name: 'questions', rows: 2, dropped: 0 },
        ],
      },
    ]);
  });

  it('fails naming the table and the field when a page table field is missing', async () => {
    const r = edit(0, (t) => ({ ...t, fields: [{ ...t.fields[0]!, selectors: [css('.gone')] }] }));
    const { log, result } = run(mixedPage(cards(4), QUESTIONS), r);
    const out = await result;
    expect(out).toMatchObject({ ok: false, reason: 'missing-required', fields: ['heading'], rows: [] });
    expect(out.ok || out.message).toContain('table "page"');
    expect(log.of('row.emitted')).toHaveLength(0);
  });

  it('fails when a required field of a secondary table is missing everywhere', async () => {
    const r = edit(2, (t) => ({ ...t, fields: [{ ...t.fields[0]!, selectors: [css('h4')] }] }));
    const out = await run(mixedPage(cards(4), QUESTIONS), r).result;
    expect(out).toMatchObject({ ok: false, reason: 'missing-required', fields: ['title'] });
    expect(out.ok || out.message).toContain('table "questions"');
  });

  it('fails when every row of an item table is dropped', async () => {
    const r = edit(1, (t) => ({ ...t, fields: [...t.fields, { name: 'price', type: 'number', selectors: [testid('price')] }] }));
    const out = await run(mixedPage(cards(4, (i) => (i < 2 ? { price: undefined } : { noLink: true })), QUESTIONS), r).result;
    expect(out).toMatchObject({ ok: false, reason: 'missing-required', fields: ['url', 'price'] });
    expect(out.ok || out.message).toContain('table "products": every row on page 1 was dropped');
  });

  it('fails when the primary table matches no container', async () => {
    const out = await run(mixedPage([], QUESTIONS)).result;
    expect(out).toMatchObject({ ok: false, reason: 'missing-required', fields: ['item'] });
    expect(out.ok || out.message).toContain('table "products"');
  });

  it('warns and continues when a secondary table matches no container', async () => {
    const { log, result } = run(mixedPage(cards(4), []));
    const out = await result;
    expect(out.ok).toBe(true);
    expect(log.of('row.emitted').map((e) => e.table)).toEqual(['page', 'products', 'products', 'products', 'products']);
    expect(out.report.warnings).toEqual([expect.stringContaining('table "questions"')]);
    expect(out.report.tables[2]).toMatchObject({ name: 'questions', rowCount: 0 });
  });

  it('names the table of a healed field and writes the recipe back in the tables form', async () => {
    const r = edit(2, (t) => ({ ...t, fields: [{ ...t.fields[0]!, selectors: [css('h4'), css('h3')] }] }));
    const { browser, emitter, log } = setup(mixedPage(cards(4), QUESTIONS));
    const saved: Recipe[] = [];
    const out = await runRecipe({
      recipe: loadRecipe(r),
      browser,
      profileDir: '/p',
      emitter,
      saveRecipe: async (recipe) => {
        saved.push(recipe);
        return '/r/shop.json';
      },
    });
    expect(out.ok).toBe(true);
    expect(log.of('field.healed')).toMatchObject([{ table: 'questions', target: 'title' }]);
    expect(out.report.healed).toBe(1);
    expect(saved[0]!.fields).toBeUndefined();
    expect(tablesOf(saved[0]!)[2]!.fields[0]!.selectors[0]).toEqual(css('h3'));
    expect(tablesOf(saved[0]!)[1]!.fields[0]!.selectors).toEqual([css('h2')]);
  });

  it('runs a recipe made only of a page table', async () => {
    const r = tablesRecipe({ tables: [tablesRecipe().tables![0]!] });
    const out = await run(mixedPage(cards(2), []), r).result;
    expect(out.ok).toBe(true);
    expect(out.rows).toEqual([{ _page: 1, _index: 0, heading: 'Electronics' }]);
    expect(out.report.item).toBeNull();
  });
});
