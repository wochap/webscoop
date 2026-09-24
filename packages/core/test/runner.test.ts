import { describe, expect, it } from 'vitest';
import { loadRecipe, recordEvents, RunEmitter, Runner, runRecipe, type BrowserPort } from '../src';
import { FakeBrowser } from '../src/testing';
import { catalog, cards, PAGE, recipe } from './helpers';

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

  it('reports partial fields as warnings on success', async () => {
    const { browser } = setup(catalog(cards(24, (i) => (i === 0 ? { price: undefined } : {}))));
    const result = await runRecipe({ recipe: loadRecipe(recipe()), browser, profileDir: '/p' });
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(24);
    expect(result.report.warnings[0]).toContain('price');
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
          scrollToBottom: async () => {},
          settle: async () => ({ url: '', title: '', status: null }),
          url: async () => '',
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
