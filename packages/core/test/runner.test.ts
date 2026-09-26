import { describe, expect, it } from 'vitest';
import { loadRecipe, recordEvents, RunEmitter, Runner, runRecipe, type BrowserPort } from '../src';
import { FakeBrowser, h } from '../src/testing';
import { card, catalog, cards, css, PAGE, recipe } from './helpers';

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
