import { describe, expect, it } from 'vitest';
import {
  annotate,
  descendantsOf,
  fingerprint,
  loadRecipe,
  recordEvents,
  RunEmitter,
  Runner,
  type Recipe,
  type RecipeInput,
  type RunOptions,
  type SerializedElement,
} from '../src';
import { FakeBrowser, h, type FakePage } from '../src/testing';
import { catalog, cards, css, PAGE, recipe } from './helpers';

const LOGIN = 'https://shop.test/login';
const RESULTS = 'https://shop.test/search?q=mouse';

const consent = (id = 'accept', cls = 'consent'): SerializedElement =>
  h('html', {}, h('body', {}, h('div', { id: 'modal' }, h('button', { id, class: cls }, 'Accept all'))));

/** A catalog hidden behind a consent modal until its button is clicked. */
const gated = (id = 'accept', cls = 'consent'): FakePage => ({
  dom: consent(id, cls),
  on: { click: (el) => (el?.attrs.id === id ? catalog(cards(3)) : undefined) },
});

function withSteps(steps: RecipeInput['steps'], extra: Partial<RecipeInput> = {}): Recipe {
  return loadRecipe(recipe({ url: PAGE, vars: [], steps, ...extra }));
}

function setup(pages: Record<string, FakePage>, recipe: Recipe, extra: Partial<RunOptions> = {}) {
  const browser = new FakeBrowser(pages);
  const emitter = new RunEmitter();
  const log = recordEvents(emitter);
  const runner = new Runner({ recipe, browser, profileDir: '/p', emitter, ...extra });
  return { browser, log, runner };
}

describe('runner steps', () => {
  it('replays a first-page step between navigating and extracting', async () => {
    const t = setup({ [PAGE]: gated() }, withSteps([{ kind: 'click', target: { selectors: [css('#accept')] } }]));
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(3);
    expect(t.runner.states).toEqual(['idle', 'opening', 'navigating', 'stepping', 'extracting', 'done']);
    expect(t.log.sequence()).toEqual([
      'run.start',
      'page.loaded',
      'step.replayed',
      'field.resolved',
      'row.emitted',
      'page.done',
      'pagination.stopped',
      'run.done',
    ]);
    expect(t.log.of('step.replayed')[0]).toMatchObject({ page: 1, step: { index: 0, kind: 'click', outcome: 'ok' } });
    expect(result.report.steps).toEqual([expect.objectContaining({ index: 0, page: 1, outcome: 'ok' })]);
  });

  it('replays no step with steps disabled, so the gate hides every field', async () => {
    const t = setup({ [PAGE]: gated() }, withSteps([{ kind: 'click', target: { selectors: [css('#accept')] } }]), { steps: { enabled: false } });
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'missing-required' });
    expect(t.runner.states).not.toContain('stepping');
    expect(t.browser.clicks).toEqual([]);
    expect(t.log.of('step.replayed')).toEqual([]);
  });

  it('fails with missing-required naming a required step whose target is gone', async () => {
    const t = setup({ [PAGE]: { dom: catalog(cards(2)) } }, withSteps([{ kind: 'click', target: { selectors: [css('#accept')] } }]));
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'missing-required', fields: ['step:0'] });
    expect(result.report.steps[0]).toMatchObject({ outcome: 'failed' });
  });

  it('skips an optional step, reports it, and extracts', async () => {
    const t = setup({ [PAGE]: { dom: catalog(cards(2)) } }, withSteps([{ kind: 'click', target: { selectors: [css('#accept')] }, optional: true }]));
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(t.log.of('step.skipped')).toEqual([{ page: 1, step: expect.objectContaining({ index: 0, outcome: 'skipped' }) }]);
    expect(result.report.steps[0]!.outcome).toBe('skipped');
  });

  it('fails with invalid-input before opening the browser when a step variable has no value', async () => {
    const recipe = loadRecipe(
      recipeInput([{ kind: 'type', target: { selectors: [css('input')] }, value: '{q}' }], { vars: [{ name: 'q', type: 'string' }] }),
    );
    const t = setup({ [PAGE]: { dom: catalog(cards(2)) } }, recipe);
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'invalid-input', fields: ['q'] });
    expect(t.browser.openedProfiles).toEqual([]);
  });

  it('extracts the page a search step navigated to and re-checks guards there', async () => {
    const form = h('html', {}, h('body', {}, h('input', { name: 'q' })));
    const loginForm = h('html', {}, h('body', {}, h('form', {}, h('input', { name: 'password', type: 'password' }))));
    const recipe = loadRecipe(
      recipeInput(
        [
          { kind: 'type', target: { selectors: [css('input[name="q"]')] }, value: '{q}' },
          { kind: 'press', value: 'Enter' },
        ],
        { vars: [{ name: 'q', type: 'string' }] },
      ),
    );
    const t = setup(
      {
        [PAGE]: { dom: form, on: { press: (el) => ({ redirect: `/search?q=${el?.attrs.value}` }) } },
        [RESULTS]: { dom: loginForm, redirect: LOGIN },
        [LOGIN]: { dom: loginForm },
      },
      recipe,
      { vars: { q: 'mouse' }, guards: { enabled: true, timeoutMs: 5_000, pollMs: 1 } },
    );
    t.log.stop();
    const events = recordEvents(t.runner.emitter);
    t.runner.emitter.on('guard.raised', () =>
      void Promise.resolve().then(async () => {
        t.browser.setPage(RESULTS, catalog(cards(2)));
        await t.browser.sessions.at(-1)!.goto(RESULTS, { timeoutMs: 1000 });
      }),
    );
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(result.report.finalUrl).toBe(RESULTS);
    expect(t.runner.states).toEqual(['idle', 'opening', 'navigating', 'stepping', 'guarded', 'stepping', 'extracting', 'done']);
    expect(events.sequence().indexOf('guard.cleared')).toBeLessThan(events.sequence().indexOf('field.resolved'));
    expect(result.report.pages[0]!.url).toBe(RESULTS);
  });

  it('runs an every-page step once per page and a first-page step once', async () => {
    const page = (n: number) => `${PAGE}?page=${n}`;
    const tabbed = (n: number): FakePage => ({
      dom: h('html', {}, h('body', {}, h('button', { id: 'accept' }, 'A'), h('button', { id: 'tab' }, 'Products'))),
      on: { click: (el) => (el?.attrs.id === 'tab' ? catalog(cards(2, (i) => ({ title: `P${n}-${i}` }))) : undefined) },
    });
    const recipe = loadRecipe(
      recipeInput(
        [
          { kind: 'click', target: { selectors: [css('#accept')] }, optional: true },
          { kind: 'click', target: { selectors: [css('#tab')] }, when: 'every-page' },
        ],
        { url: `${PAGE}?page=1`, pagination: { kind: 'url', param: { name: 'page', start: 1, step: 1 }, limit: 3 } },
      ),
    );
    const t = setup({ [page(1)]: tabbed(1), [page(2)]: tabbed(2), [page(3)]: tabbed(3) }, recipe);
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(6);
    expect(t.log.of('step.replayed').map((e) => [e.page, e.step.index])).toEqual([
      [1, 0],
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
  });

  it('heals a renamed consent button, counts it, and writes the step target back', async () => {
    const recorded = annotate(consent().children[0] as SerializedElement);
    const button = descendantsOf(recorded).find((n) => n.tag === 'button')!;
    const saved: Recipe[] = [];
    const recipe = withSteps([
      { kind: 'click', target: { selectors: [css('#accept')], fingerprint: fingerprint(button) } },
      { kind: 'wait', value: '1' },
    ]);
    const t = setup({ [PAGE]: gated('x7f3a', 'k2') }, recipe, { saveRecipe: async (r) => (saved.push(r), '/recipes/shop.json') });
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(result.report.steps.map((s) => s.outcome)).toEqual(['healed', 'ok']);
    expect(result.report.healed).toBe(1);
    expect(t.log.of('field.healed')[0]).toMatchObject({ target: 'step:0' });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.steps[0]!.target!.selectors[0]).not.toEqual(css('#accept'));
    expect(saved[0]!.steps[1]).toEqual(recipe.steps[1]);
  });
});

function recipeInput(steps: RecipeInput['steps'], extra: Partial<RecipeInput> = {}): RecipeInput {
  return recipe({ url: PAGE, vars: [], steps, ...extra });
}
