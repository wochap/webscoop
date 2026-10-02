import { describe, expect, it } from 'vitest';
import {
  loadRecipe,
  recordEvents,
  RunEmitter,
  Runner,
  type AttentionPort,
  type AttentionSignal,
  type GuardBannerHandler,
  type GuardBannerInfo,
  type Recipe,
  type RecipeInput,
  type RunOptions,
  type SerializedElement,
} from '../src';
import { FakeBrowser, h, type FakePage } from '../src/testing';
import { card, cards, css, PAGE, testid } from './helpers';

const LOGIN = 'https://shop.test/login';
const field = (name: string, selector: string) => ({ name, type: 'text' as const, selectors: [css(selector)] });
const button = (id: string) => ({ selectors: [css(`#${id}`)] });
const click = (id: string, extra: Record<string, unknown> = {}) => ({ kind: 'click' as const, target: button(id), ...extra });

function load(input: Omit<RecipeInput, 'schemaVersion' | 'name' | 'url' | 'vars'> & Partial<RecipeInput>): Recipe {
  return loadRecipe({ schemaVersion: 2, name: 'spa', url: PAGE, vars: [], ...input } as RecipeInput);
}

function setup(pages: Record<string, FakePage>, recipe: Recipe, extra: Partial<RunOptions> = {}) {
  const browser = new FakeBrowser(pages);
  const emitter = new RunEmitter();
  const log = recordEvents(emitter);
  const runner = new Runner({ recipe, browser, profileDir: '/p', emitter, ...extra });
  return { browser, log, runner, session: () => browser.sessions.at(-1)! };
}

const page = (...children: (SerializedElement | false)[]) => h('html', {}, h('body', {}, ...children));

/** An SPA: a summary heading and a Details tab that swaps in a details list without changing the URL. */
function spa(): FakePage {
  const summary = page(h('h1', { id: 'summary' }, 'Total 42'), h('button', { id: 'details' }, 'Details'));
  const details = page(h('ul', {}, h('li', { class: 'row' }, h('span', {}, 'A')), h('li', { class: 'row' }, h('span', {}, 'B'))));
  return { dom: summary, on: { click: (el) => (el?.attrs.id === 'details' ? details : undefined) } };
}

const spaTables = [
  { name: 'summary', fields: [field('total', '#summary')] },
  { name: 'details', item: { selectors: [css('li.row')] }, fields: [field('name', 'span')] },
];

describe('sequence execution', () => {
  it('extracts a table, runs a flow that switches an SPA tab, and extracts another table', async () => {
    const recipe = load({
      tables: spaTables,
      flows: [{ name: 'open-detail', steps: [click('details')] }],
      sequence: [{ extract: 'summary' }, { flow: 'open-detail' }, { extract: 'details' }],
    });
    const t = setup({ [PAGE]: spa() }, recipe);
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(t.log.of('row.emitted').map((e) => [e.table, e.row._page, e.row._index, e.row.total ?? e.row.name])).toEqual([
      ['summary', 1, 0, 'Total 42'],
      ['details', 1, 0, 'A'],
      ['details', 1, 1, 'B'],
    ]);
    expect(t.browser.visited).toEqual([PAGE]);
    expect(result.report.pageCount).toBe(1);
  });

  it('succeeds without rows for a recipe that only runs flows', async () => {
    const form = page(h('input', { id: 'q' }), h('button', { id: 'submit' }, 'Send'));
    const recipe = load({ flows: [{ name: 'submit-form', steps: [{ kind: 'fill', target: button('q'), value: 'hello' }, click('submit')] }], sequence: [{ flow: 'submit-form' }] });
    const t = setup({ [PAGE]: { dom: form } }, recipe);
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: true, rows: [] });
    expect(t.browser.actions).toEqual([{ kind: 'fill', target: 'css=#q >> nth=0', value: 'hello' }]);
    expect(t.browser.clicks).toEqual(['css=#submit >> nth=0']);
    expect(result.report.tables).toEqual([]);
  });

  it('runs a flow inside a next paginate block once before each page', async () => {
    const pageOf = (n: number): FakePage => {
      const list = (show: boolean) =>
        page(
          h('button', { id: 'products' }, 'Products'),
          show && h('ul', {}, cards(2, (i) => ({ title: `P${n}-${i}` })).map((c, i) => h('li', {}, card(c, i)))),
          n < 3 ? h('a', { id: 'next', href: `${PAGE}?p=${n + 1}` }, 'Next') : h('a', { id: 'next', 'aria-disabled': 'true' }, 'Next'),
        );
      return { dom: list(false), on: { click: (el) => (el?.attrs.id === 'products' ? list(true) : undefined) } };
    };
    const recipe = load({
      item: { selectors: [testid('product-card')] },
      fields: [{ name: 'title', type: 'text', selectors: [css('h2')] }],
      flows: [{ name: 'products-tab', steps: [click('products')] }],
      sequence: [{ paginate: { kind: 'next', target: button('next'), limit: 3, do: [{ flow: 'products-tab' }, { extract: 'items' }] } }],
    });
    const t = setup({ [PAGE]: pageOf(1), [`${PAGE}?p=2`]: pageOf(2), [`${PAGE}?p=3`]: pageOf(3) }, recipe);
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(t.log.of('flow.started').map((e) => e.page)).toEqual([1, 2, 3]);
    expect(result.rows.map((r) => [r._page, r.title])).toEqual([
      [1, 'P1-0'],
      [1, 'P1-1'],
      [2, 'P2-0'],
      [2, 'P2-1'],
      [3, 'P3-0'],
      [3, 'P3-1'],
    ]);
  });

  it('sets _page to 1 before the paginate block and to the last page after it', async () => {
    const at = (n: number) => `${PAGE}?page=${n}`;
    const site = (n: number) => page(h('h1', { id: 'h' }, `Heading ${n}`), h('ul', {}, cards(2, (i) => ({ title: `P${n}-${i}` })).map((c, i) => h('li', {}, card(c, i)))));
    const recipe = load({
      url: `${PAGE}?page={n}`,
      vars: [{ name: 'n', type: 'string' }],
      tables: [
        { name: 'before', fields: [field('heading', '#h')] },
        { name: 'products', item: { selectors: [testid('product-card')] }, fields: [{ name: 'title', type: 'text', selectors: [css('h2')], key: true }] },
        { name: 'after', fields: [field('heading', '#h')] },
      ],
      sequence: [{ extract: 'before' }, { paginate: { kind: 'url', param: { name: 'n', start: 1, step: 1 }, limit: 2, do: [{ extract: 'products' }] } }, { extract: 'after' }],
    });
    const t = setup({ [at(1)]: { dom: site(1) }, [at(2)]: { dom: site(2) } }, recipe);
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(t.log.of('row.emitted').map((e) => `${e.table}:${e.row._page}`)).toEqual(['before:1', 'products:1', 'products:1', 'products:2', 'products:2', 'after:2']);
    expect(t.log.of('row.emitted').at(-1)!.row.heading).toBe('Heading 2');
  });

  it('counts the explicit driving table to detect growth on more pagination', async () => {
    const render = (count: number) =>
      page(
        h('ul', {}, cards(8).map((c, i) => h('li', {}, card(c, i)))),
        h('section', {}, Array.from({ length: count }, (_, i) => h('div', { 'data-testid': 'question' }, h('h3', {}, `Q${i}`)))),
        h('button', { id: 'more' }, 'More'),
      );
    const recipe = load({
      tables: [
        { name: 'products', item: { selectors: [testid('product-card')] }, fields: [{ name: 'title', type: 'text', selectors: [css('h2')], key: true }] },
        { name: 'questions', item: { selectors: [testid('question')] }, fields: [{ name: 'q', type: 'text', selectors: [css('h3')], key: true }] },
      ],
      sequence: [{ paginate: { kind: 'more', target: button('more'), table: 'questions', limit: 2, do: [{ extract: 'products' }, { extract: 'questions' }] } }],
    });
    const t = setup({ [PAGE]: { dom: render(3), render, more: [6] } }, recipe);
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    const questions = result.rows.filter((r) => 'q' in r);
    expect(questions.map((r) => [r._page, r._index, r.q])).toEqual([
      [1, 0, 'Q0'],
      [1, 1, 'Q1'],
      [1, 2, 'Q2'],
      [2, 0, 'Q3'],
      [2, 1, 'Q4'],
      [2, 2, 'Q5'],
    ]);
    // Products did not grow, but they do not drive the page loop.
    expect(result.report.pageCount).toBe(2);
  });
});

describe('reactive flows', () => {
  const at = (n: number) => `${PAGE}?page=${n}`;
  /** A list page; with `banner` it shows a consent button that a click removes. */
  function listPage(n: number, banner: boolean): FakePage {
    const list = (show: boolean) => page(show && h('div', { id: 'banner' }, h('button', { id: 'consent' }, 'OK')), h('ul', {}, cards(2, (i) => ({ title: `P${n}-${i}` })).map((c, i) => h('li', {}, card(c, i)))));
    return { dom: list(banner), on: { click: (el) => (el?.attrs.id === 'consent' ? list(false) : undefined) } };
  }
  const paged = (flows: RecipeInput['flows'], limit = 3): Recipe =>
    load({
      url: `${PAGE}?page={n}`,
      vars: [{ name: 'n', type: 'string' }],
      item: { selectors: [testid('product-card')] },
      fields: [{ name: 'title', type: 'text', selectors: [css('h2')], key: true }],
      flows,
      sequence: [{ paginate: { kind: 'url', param: { name: 'n', start: 1, step: 1 }, limit, do: [{ extract: 'items' }] } }],
    });
  const cookieBanner = { name: 'cookie-banner', trigger: { appears: button('consent') }, steps: [click('consent')] };

  it('fires a cookie banner flow whenever the banner shows, before the extraction', async () => {
    const t = setup({ [at(1)]: listPage(1, true), [at(2)]: listPage(2, false), [at(3)]: listPage(3, true) }, paged([cookieBanner]));
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(t.log.of('flow.started')).toEqual([
      { flow: 'cookie-banner', kind: 'reactive', page: 1, window: at(1) },
      { flow: 'cookie-banner', kind: 'reactive', page: 3, window: at(3) },
    ]);
    expect(result.report.flows.map((f) => [f.name, f.kind, f.page, f.outcome, f.steps.length])).toEqual([
      ['cookie-banner', 'reactive', 1, 'ok', 1],
      ['cookie-banner', 'reactive', 3, 'ok', 1],
    ]);
    const names = t.log.names();
    expect(names.indexOf('flow.done')).toBeLessThan(names.indexOf('row.emitted'));
    expect(result.rows).toHaveLength(6);
  });

  it('runs the first matching reactive flow in recipe order', async () => {
    const both = { dom: page(h('button', { id: 'consent' }, 'OK'), h('button', { id: 'other' }, 'X'), h('ul', {}, h('li', {}, card({ title: 'P' }, 0)))), on: { click: () => page(h('ul', {}, h('li', {}, card({ title: 'P' }, 0)))) } };
    const recipe = paged([{ name: 'other', trigger: { appears: button('other') }, steps: [click('other')] }, cookieBanner], 1);
    const t = setup({ [at(1)]: both }, recipe);
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(t.log.of('flow.started').map((e) => e.flow)).toEqual(['other']);
  });

  it("does not re-check triggers while a reactive flow's own steps run", async () => {
    // The banner stays up until the second click; a re-entrant check would fire again before it.
    let clicks = 0;
    const list = (show: boolean) => page(show && h('button', { id: 'consent' }, 'OK'), h('button', { id: 'confirm' }, 'Sure'), h('ul', {}, h('li', {}, card({ title: 'P' }, 0))));
    const banner: FakePage = { dom: list(true), on: { click: (el) => (el?.attrs.id === 'confirm' && ++clicks ? list(false) : list(true)) } };
    const recipe = paged([{ ...cookieBanner, steps: [click('consent'), click('confirm')] }], 1);
    const t = setup({ [at(1)]: banner }, recipe);
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(t.log.of('flow.started')).toHaveLength(1);
    expect(t.log.of('step.replayed')).toHaveLength(2);
  });

  it('fails with flow-loop when the trigger keeps reappearing without an extraction in between', async () => {
    const stuck = { dom: page(h('button', { id: 'login' }, 'Log in'), h('ul', {}, h('li', {}, card({ title: 'P' }, 0)))) };
    // Checkpoints after the page settles and before each of the two steps: the third firing is one too many.
    const recipe = load({
      item: { selectors: [testid('product-card')] },
      fields: [{ name: 'title', type: 'text', selectors: [css('h2')] }],
      flows: [
        { name: 'setup', steps: [{ kind: 'wait', value: '1' }, { kind: 'wait', value: '1' }] },
        { name: 'login-wall', trigger: { appears: button('login') }, steps: [click('login')] },
      ],
      sequence: [{ flow: 'setup' }, { extract: 'items' }],
    });
    const t = setup({ [PAGE]: stuck }, recipe);
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'flow-loop', fields: ['login-wall'] });
    expect(result.ok === false && result.message).toContain('"login-wall"');
    expect(t.log.of('flow.started').filter((e) => e.flow === 'login-wall')).toHaveLength(2);
  });

  it('gives retries back after each successful extraction', async () => {
    const recipe = paged([{ ...cookieBanner, maxRetries: 1 }]);
    const t = setup({ [at(1)]: listPage(1, true), [at(2)]: listPage(2, true), [at(3)]: listPage(3, true) }, recipe);
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(t.log.of('flow.started')).toHaveLength(3);
  });

  it('fires in a popup window opened by the run, in that window', async () => {
    const POPUP = 'https://shop.test/popup';
    const main: FakePage = {
      dom: page(h('button', { id: 'open' }, 'Open'), h('ul', {}, h('li', {}, card({ title: 'P' }, 0)))),
      on: { click: (el) => (el?.attrs.id === 'open' ? { popup: '/popup' } : undefined) },
    };
    const popup: FakePage = { dom: page(h('button', { id: 'consent' }, 'OK')), on: { click: () => ({ close: true }) } };
    const recipe = load({
      item: { selectors: [testid('product-card')] },
      fields: [{ name: 'title', type: 'text', selectors: [css('h2')] }],
      flows: [{ name: 'opener', steps: [click('open')] }, cookieBanner],
      sequence: [{ flow: 'opener' }, { extract: 'items' }],
    });
    const t = setup({ [PAGE]: main, [POPUP]: popup }, recipe);
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(t.log.of('flow.started')).toEqual([
      { flow: 'opener', kind: 'called', page: 1 },
      { flow: 'cookie-banner', kind: 'reactive', page: 1, window: POPUP },
    ]);
    expect(t.browser.popups[0]!.isClosed()).toBe(true);
    expect(t.browser.openSessions).toBe(0);
  });

  it('runs no reactive flow with flows disabled', async () => {
    const t = setup({ [at(1)]: listPage(1, true) }, paged([cookieBanner], 1), { flows: { enabled: false } });
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(t.log.of('flow.started')).toEqual([]);
  });
});

describe('recovery', () => {
  const loginForm = () => page(h('form', {}, h('input', { name: 'password', type: 'password' })));

  it('rebuilds SPA state after a guard clears before the extraction: reloads the recipe URL and replays the flows before', async () => {
    let loggedIn = false;
    const home = () => page(h('button', { id: 'report' }, 'Report'));
    const report = page(h('ul', {}, h('li', { class: 'row' }, h('span', {}, 'R1'))));
    const spaPage = (): FakePage => ({ dom: home(), on: { click: (el) => (el?.attrs.id === 'report' ? (loggedIn ? report : loginForm()) : undefined) } });
    const recipe = load({
      tables: [{ name: 'results', item: { selectors: [css('li.row')] }, fields: [field('name', 'span')] }],
      flows: [{ name: 'reach-report', steps: [click('report')] }],
      sequence: [{ flow: 'reach-report' }, { extract: 'results' }],
    });
    const t = setup({ [PAGE]: spaPage() }, recipe, { guards: { enabled: true, timeoutMs: 5_000, pollMs: 1 } });
    t.runner.emitter.on('guard.raised', () => {
      loggedIn = true;
      t.session().replaceDom(home());
    });
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(result.rows.map((r) => r.name)).toEqual(['R1']);
    expect(t.browser.visited).toEqual([PAGE, PAGE]);
    expect(t.log.of('flow.started').map((e) => e.flow)).toEqual(['reach-report', 'reach-report']);
  });

  it('fails with pagination-lost on a later page of next pagination and keeps the rows of earlier pages', async () => {
    const at = (n: number) => `${PAGE}?p=${n}`;
    const list = (n: number) => ({ dom: page(h('ul', {}, cards(2, (i) => ({ title: `P${n}-${i}` })).map((c, i) => h('li', {}, card(c, i)))), h('a', { id: 'next', href: at(n + 1) }, 'Next')) });
    const recipe = load({
      item: { selectors: [testid('product-card')] },
      fields: [{ name: 'title', type: 'text', selectors: [css('h2')], key: true }],
      sequence: [{ paginate: { kind: 'next', target: button('next'), limit: 'all', do: [{ extract: 'items' }] } }],
    });
    const t = setup({ [PAGE]: list(1), [at(2)]: list(2), [at(3)]: { dom: loginForm(), redirect: LOGIN }, [LOGIN]: { dom: loginForm() } }, recipe, {
      guards: { enabled: true, timeoutMs: 5_000, pollMs: 1 },
    });
    t.runner.emitter.on('guard.raised', () =>
      void Promise.resolve().then(async () => {
        t.browser.setPage(at(3), list(3));
        await t.session().goto(at(3), { timeoutMs: 1000 });
      }),
    );
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'pagination-lost' });
    expect(result.ok === false && result.message).toContain('page 3');
    expect(result.rows.map((r) => r._page)).toEqual([1, 1, 2, 2]);
  });

  it('restores the page state after a reactive flow with recover', async () => {
    let expired = true;
    const home = () => page(expired ? h('button', { id: 'login' }, 'Log in') : h('button', { id: 'report' }, 'Report'));
    const report = page(h('ul', {}, h('li', { class: 'row' }, h('span', {}, 'R1'))));
    const spaPage: FakePage = {
      dom: home(),
      on: {
        click: (el) => {
          if (el?.attrs.id === 'login') {
            expired = false;
            return home();
          }
          return el?.attrs.id === 'report' ? report : undefined;
        },
      },
    };
    const recipe = load({
      tables: [{ name: 'results', item: { selectors: [css('li.row')] }, fields: [field('name', 'span')] }],
      flows: [
        { name: 'reach-report', steps: [click('report', { optional: true })] },
        { name: 'login-wall', trigger: { appears: button('login') }, recover: true, steps: [click('login')] },
      ],
      sequence: [{ flow: 'reach-report' }, { extract: 'results' }],
    });
    const t = setup({ [PAGE]: spaPage }, recipe);
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(result.rows.map((r) => r.name)).toEqual(['R1']);
    expect(t.log.of('flow.started').map((e) => e.flow)).toEqual(['login-wall', 'reach-report']);
  });
});

describe('await-user', () => {
  /** Attention held at once, with continue and abort sent from outside. */
  function attentionPort() {
    const signals = new Set<(s: AttentionSignal) => void>();
    let released = 0;
    const port: AttentionPort = {
      acquire: async () => ({
        waited: false,
        onSignal: (cb) => (signals.add(cb), () => signals.delete(cb)),
        stillBlocked: () => {},
        release: () => void released++,
      }),
    };
    return { port, send: (s: AttentionSignal) => signals.forEach((cb) => cb(s)), released: () => released };
  }

  function banner() {
    const shown: GuardBannerInfo[] = [];
    const hidden: number[] = [];
    let continueCb: (() => void) | null = null;
    let abortCb: (() => void) | null = null;
    const handler: GuardBannerHandler = {
      show: async (_session, info) => {
        shown.push(info);
        return { onContinue: (cb) => void (continueCb = cb), onAbort: (cb) => void (abortCb = cb) };
      },
      hide: async () => void hidden.push(1),
    };
    return { handler, shown, hidden, continue: () => continueCb?.(), abort: () => abortCb?.() };
  }

  const loginPage = () => page(h('button', { id: 'login' }, 'Log in'));
  const loggedIn = () => page(h('ul', {}, h('li', {}, card({ title: 'Secret' }, 0))));
  const recipe = (step: Record<string, unknown> = {}) =>
    load({
      item: { selectors: [testid('product-card')] },
      fields: [{ name: 'title', type: 'text', selectors: [css('h2')] }],
      flows: [{ name: 'login', steps: [{ kind: 'await-user', target: button('login'), until: 'disappears', label: 'Log in to SOL', ...step }] }],
      sequence: [{ flow: 'login' }, { extract: 'items' }],
    });

  it('waits for the user, with attention, notification, and banner, and completes once the condition holds', async () => {
    const b = banner();
    const notes: string[] = [];
    const a = attentionPort();
    const t = setup({ [PAGE]: { dom: loginPage() } }, recipe(), {
      attention: a.port,
      guards: { enabled: true, timeoutMs: 5_000, pollMs: 5, banner: b.handler, notify: { notify: async (n) => void notes.push(n.body) } },
    });
    t.runner.emitter.on('attention.needed', () => void setTimeout(() => t.session().replaceDom(loggedIn()), 15));
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(result.rows.map((r) => r.title)).toEqual(['Secret']);
    expect(t.log.of('attention.needed')).toEqual([{ reason: 'await-user', page: 1, url: PAGE, label: 'Log in to SOL', flow: 'login' }]);
    expect(t.log.of('attention.resolved')).toEqual([{ reason: 'await-user', outcome: 'cleared' }]);
    expect(b.shown).toEqual([expect.objectContaining({ kind: 'await-user', label: 'Log in to SOL' })]);
    expect(b.hidden).toHaveLength(1);
    expect(notes).toEqual(['Log in to SOL (page 1)']);
    expect(a.released()).toBe(1);
    expect(result.report.steps[0]).toMatchObject({ kind: 'await-user', outcome: 'ok' });
  });

  it('does not ask when the condition already holds', async () => {
    const t = setup({ [PAGE]: { dom: loggedIn() } }, recipe(), { guards: { enabled: true, timeoutMs: 5_000, pollMs: 5 } });
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(t.log.of('attention.needed')).toEqual([]);
  });

  it('fails with paused when the guard budget is 0, keeping no attention open', async () => {
    const t = setup({ [PAGE]: { dom: loginPage() } }, recipe(), { guards: { enabled: true, timeoutMs: 0, pollMs: 5 } });
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'paused' });
    expect(result.ok === false && result.message).toContain('Log in to SOL');
    expect(t.log.of('attention.resolved')).toEqual([{ reason: 'await-user', outcome: 'timeout' }]);
  });

  it("uses the step's own timeout instead of the run's budget", async () => {
    const t = setup({ [PAGE]: { dom: loginPage() } }, recipe({ timeoutMs: 20 }), { guards: { enabled: true, timeoutMs: 60_000, pollMs: 5 } });
    const started = Date.now();
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'paused' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('checks at once on Continue and ends the run on Abort', async () => {
    const b = banner();
    const t = setup({ [PAGE]: { dom: loginPage() } }, recipe(), { guards: { enabled: true, timeoutMs: 60_000, pollMs: 60_000, banner: b.handler } });
    t.runner.emitter.on('attention.needed', () =>
      void setTimeout(() => {
        t.session().replaceDom(loggedIn());
        b.continue();
      }, 10),
    );
    const started = Date.now();
    expect((await t.runner.run()).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);

    const b2 = banner();
    const aborted = setup({ [PAGE]: { dom: loginPage() } }, recipe(), { guards: { enabled: true, timeoutMs: 60_000, pollMs: 60_000, banner: b2.handler } });
    aborted.runner.emitter.on('attention.needed', () => void setTimeout(() => b2.abort(), 10));
    const result = await aborted.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
    expect(aborted.log.of('attention.resolved')).toEqual([{ reason: 'await-user', outcome: 'ended' }]);
  });

  it('waits in a popup until the button of the main window disappears, with the banner on the popup', async () => {
    const POPUP = 'https://shop.test/login';
    let opened = false;
    const b = banner();
    const main: FakePage = { dom: loginPage(), on: { click: (el) => (el?.attrs.id === 'login' ? ((opened = true), { popup: '/login' }) : undefined) } };
    const popup: FakePage = { dom: page(h('input', { id: 'user' })) };
    const r = load({
      item: { selectors: [testid('product-card')] },
      fields: [{ name: 'title', type: 'text', selectors: [css('h2')] }],
      flows: [{ name: 'login', steps: [click('login'), { kind: 'await-user', target: button('login'), until: 'disappears', window: 'popup', label: 'Log in to SOL' }] }],
      sequence: [{ flow: 'login' }, { extract: 'items' }],
    });
    const t = setup({ [PAGE]: main, [POPUP]: popup }, r, { guards: { enabled: true, timeoutMs: 5_000, pollMs: 5, banner: b.handler } });
    const shownOn: string[] = [];
    b.handler.show = async (session, info) => {
      shownOn.push(await session.url());
      b.shown.push(info);
      return { onContinue: () => {}, onAbort: () => {} };
    };
    t.runner.emitter.on('attention.needed', () =>
      void setTimeout(async () => {
        await t.browser.popups[0]!.userClose();
        t.session().replaceDom(loggedIn());
      }, 15),
    );
    const result = await t.runner.run();
    expect(opened).toBe(true);
    expect(result.ok).toBe(true);
    expect(shownOn).toEqual([POPUP]);
    expect(t.log.of('attention.needed')[0]).toMatchObject({ reason: 'await-user', url: POPUP });
  });
});
