import { describe, expect, it, vi } from 'vitest';
import {
  annotate,
  descendantsOf,
  fingerprint,
  loadRecipe,
  RUN_EVENT_NAMES,
  recordEvents,
  RunEmitter,
  Runner,
  type Recipe,
  type RecipeField,
  type RepickHandler,
  type RunEvents,
  type SelectorCandidate,
  type SerializedElement,
} from '../src';
import { FakeBrowser, h } from '../src/testing';
import { catalogSnapshot, fingerprintedRecipe } from './healing-helpers';
import { card, cards, catalog, css, recipe, testid } from './helpers';
import { CATALOG } from './recorder-helpers';

function setup(dom: SerializedElement, recipe: Recipe, extra: Partial<ConstructorParameters<typeof Runner>[0]> = {}) {
  const browser = new FakeBrowser({ [CATALOG]: dom });
  const emitter = new RunEmitter();
  const log = recordEvents(emitter);
  const saved: Recipe[] = [];
  const saveRecipe = vi.fn(async (r: Recipe) => {
    saved.push(r);
    return '/recipes/playground-catalog.json';
  });
  const runner = new Runner({ recipe, browser, profileDir: '/p', emitter, saveRecipe, ...extra });
  return { browser, emitter, log, saved, saveRecipe, runner };
}

/** The reference recipe with one field's selectors replaced. */
function withField(recipe: Recipe, name: string, patch: Partial<RecipeField>): Recipe {
  return { ...recipe, fields: recipe.fields!.map((f) => (f.name === name ? { ...f, ...patch } : f)) };
}

describe('runner healing', () => {
  it('heals on tier 1, emits field.healed before field.resolved and recipe.saved before run.done, and writes back', async () => {
    const t = setup(catalogSnapshot(1), fingerprintedRecipe());
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(t.runner.states).toEqual(['idle', 'opening', 'navigating', 'extracting', 'done']);
    expect(t.log.sequence()).toEqual(['run.start', 'page.loaded', 'field.healed', 'field.resolved', 'row.emitted', 'page.done', 'pagination.stopped', 'recipe.saved', 'run.done']);
    const names = t.log.names();
    for (const healed of t.log.of('field.healed')) {
      if (healed.target === 'item') continue;
      const healedAt = t.log.events.findIndex((e) => e.name === 'field.healed' && (e.payload as RunEvents['field.healed']).target === healed.target);
      const resolvedAt = t.log.events.findIndex((e) => e.name === 'field.resolved' && (e.payload as RunEvents['field.resolved']).field.name === healed.target);
      expect(healedAt).toBeLessThan(resolvedAt);
    }
    expect(names.indexOf('recipe.saved')).toBeLessThan(names.indexOf('run.done'));

    const price = t.log.of('field.healed').find((e) => e.target === 'price')!;
    expect(price.page).toBe(1);
    expect(price.outcome.kind).toBe('fuzzy');
    expect(price.oldPrimary).toEqual(testid('price'));
    expect(price.newPrimary.strategy).toBe('testid');
    expect(t.log.of('recipe.saved')).toEqual([{ path: '/recipes/playground-catalog.json' }]);

    const report = t.log.of('run.done')[0]!.report;
    expect(report.healed).toBe(6);
    expect(report.savedTo).toBe('/recipes/playground-catalog.json');
    expect(report.item?.outcome.kind).toBe('fuzzy');
    expect(report.fields.find((f) => f.name === 'price')).toMatchObject({ status: 'healed', outcome: { kind: 'fuzzy' } });

    expect(t.saveRecipe).toHaveBeenCalledTimes(1);
    const written = t.saved[0]!;
    expect(written.fields!.find((f) => f.name === 'price')!.selectors[0]).toEqual(price.newPrimary);
    expect(written.fields!.find((f) => f.name === 'title')).toEqual(fingerprintedRecipe().fields!.find((f) => f.name === 'title'));

    // A second run against the written recipe resolves every target at candidate 0.
    const again = setup(catalogSnapshot(1), written);
    const second = await again.runner.run();
    expect(second.ok).toBe(true);
    expect(second.report.healed).toBe(0);
    expect(second.report.item?.outcome).toEqual({ kind: 'candidate', index: 0 });
    for (const f of second.report.fields) expect(f, f.name).toMatchObject({ status: 'ok', outcome: { kind: 'candidate', index: 0 } });
    expect(again.saveRecipe).not.toHaveBeenCalled();
  });

  it('does not write when the run fails after a field healed', async () => {
    const recipe = withField(fingerprintedRecipe(), 'category', { selectors: [css('.gone')], fingerprint: undefined });
    const t = setup(catalogSnapshot(1), recipe);
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'missing-required', fields: ['category'] });
    expect(t.log.of('field.healed').length).toBeGreaterThan(0);
    expect(t.saveRecipe).not.toHaveBeenCalled();
    expect(t.log.names()).not.toContain('recipe.saved');
    expect(result.report.savedTo).toBeNull();
  });

  it('heals but does not write when write-back is disabled', async () => {
    const t = setup(catalogSnapshot(1), fingerprintedRecipe(), { healing: { enabled: true, writeBack: false } });
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(result.report.healed).toBe(6);
    expect(t.saveRecipe).not.toHaveBeenCalled();
    expect(result.report.savedTo).toBeNull();
  });

  it('tries only the first candidate when healing is disabled', async () => {
    const recipe = withField(fingerprintedRecipe(), 'category', { selectors: [css('.gone'), testid('category')] });
    const t = setup(catalogSnapshot(0), recipe, { healing: { enabled: false, writeBack: true } });
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'missing-required', fields: ['category'] });
    expect(t.log.names()).not.toContain('field.healed');
  });

  it('lists the new events in RUN_EVENT_NAMES', () => {
    expect(RUN_EVENT_NAMES).toEqual(['run.start', 'page.loaded', 'guard.raised', 'guard.cleared', 'guard.timeout', 'step.replayed', 'step.skipped', 'field.resolved', 'field.healed', 'repick.requested', 'repick.resolved', 'row.emitted', 'page.done', 'page.advanced', 'pagination.stopped', 'recipe.saved', 'run.done', 'run.failed']);
  });
});

describe('runner re-pick', () => {
  const broken = () => withField(fingerprintedRecipe(), 'price', { selectors: [css('.gone')], fingerprint: undefined });

  it('pauses in repicking, resumes with the picked selectors, and writes them back', async () => {
    const handler = vi.fn<RepickHandler>(async () => ({ kind: 'picked', selectors: [testid('price'), css('.product-price')] }));
    const t = setup(catalogSnapshot(0), broken(), { repick: handler });
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(t.runner.states).toEqual(['idle', 'opening', 'navigating', 'extracting', 'repicking', 'extracting', 'done']);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toMatchObject({ page: 1, name: 'price', oldSelector: css('.gone'), fingerprint: null, sample: null });
    expect(handler.mock.calls[0]![0].recipe.fields![1]!.selectors).toEqual([css('.gone')]);
    expect(result.ok && result.rows.every((r) => typeof r.price === 'number')).toBe(true);
    expect(t.log.of('repick.requested')).toEqual([{ page: 1, table: 'items', target: 'price', oldSelector: css('.gone'), fingerprint: null }]);
    expect(t.log.of('repick.resolved')).toEqual([{ page: 1, table: 'items', target: 'price', result: 'picked' }]);
    expect(t.log.of('field.healed').find((e) => e.target === 'price')?.outcome).toEqual({ kind: 'user' });
    expect(result.report.fields.find((f) => f.name === 'price')).toMatchObject({ status: 'healed', outcome: { kind: 'user' } });
    expect(t.saved[0]!.fields!.find((f) => f.name === 'price')!.selectors).toEqual([testid('price'), css('.product-price')]);
  });

  it('treats a skipped field as missing', async () => {
    const t = setup(catalogSnapshot(0), broken(), { repick: async () => ({ kind: 'skip' }) });
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'missing-required', fields: ['price'] });
    expect(t.runner.states).toEqual(['idle', 'opening', 'navigating', 'extracting', 'repicking', 'extracting', 'failed']);
    expect(t.log.of('repick.resolved')).toEqual([{ page: 1, table: 'items', target: 'price', result: 'skip' }]);
    expect(t.saveRecipe).not.toHaveBeenCalled();
  });

  it('fails the run as aborted when the user aborts', async () => {
    const t = setup(catalogSnapshot(0), broken(), { repick: async () => ({ kind: 'abort' }) });
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
    expect(t.runner.states).toEqual(['idle', 'opening', 'navigating', 'extracting', 'repicking', 'failed']);
    expect(t.browser.openSessions).toBe(0);
  });

  it('never asks about optional fields', async () => {
    const handler = vi.fn<RepickHandler>(async () => ({ kind: 'skip' }));
    const recipe = withField(broken(), 'price', { optional: true });
    const t = setup(catalogSnapshot(0), recipe, { repick: handler });
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('list parent healing', () => {
  const role = (value: string): SelectorCandidate => ({ strategy: 'role', value, stability: 'stable' });

  /** The reference recipe with a list parent recorded on tier 0. */
  function withinRecipe(within: SelectorCandidate[]): Recipe {
    const recipe = fingerprintedRecipe();
    const list = descendantsOf(annotate(catalogSnapshot(0))).find((n) => n.attrs.class === 'product-list')!;
    return { ...recipe, item: { ...recipe.item!, within, withinFingerprint: fingerprint(list) } };
  }

  it('heals a renamed list through its role candidate and writes the new list parent back', async () => {
    const t = setup(catalogSnapshot(1), withinRecipe([css('ul.product-list'), role('list')]));
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(24);
    expect(result.report.item!.within).toMatchObject({ candidateIndex: 1, outcome: { kind: 'candidate', index: 1 } });
    const healed = t.log.of('field.healed').find((e) => e.target === 'within')!;
    expect(healed.oldPrimary).toEqual(css('ul.product-list'));
    const written = t.saved[0]!;
    expect(written.item!.within![0]).toEqual(role('list'));
    expect(written.item!.withinFingerprint!.tag).toBe('ul');
  });

  it('heals a renamed list by fingerprint when no candidate resolves', async () => {
    const t = setup(catalogSnapshot(1), withinRecipe([css('ul.product-list')]));
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(24);
    expect(result.report.item!.within!.outcome.kind).toBe('fuzzy');
    expect(t.saved[0]!.item!.within!.map((c) => c.strategy)).toContain('role');
  });

  it('scores container matches only inside the list parent', async () => {
    const dom = catalog(cards(24));
    const body = dom.children.find((c) => c.type === 'element' && c.tag === 'body') as SerializedElement;
    // The sidebar repeats the first card exactly, so a document-wide match is ambiguous.
    body.children.push(h('aside', {}, h('ul', { class: 'sidebar' }, h('li', {}, card(cards(1)[0]!, 0)))));
    const first = descendantsOf(annotate(dom)).find((n) => n.tag === 'article')!;
    const base = loadRecipe(recipe({ url: CATALOG, vars: [], item: { selectors: [css('.gone')] } }));
    const broken: Recipe = { ...base, item: { ...base.item!, fingerprint: fingerprint(first) } };

    const unscoped = await setup(dom, broken).runner.run();
    expect(unscoped).toMatchObject({ ok: false, reason: 'missing-required' });

    const scoped: Recipe = { ...broken, item: { ...broken.item!, within: [role('list')] } };
    const result = await setup(dom, scoped).runner.run();
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(24);
    expect(result.report.item!.outcome.kind).toBe('fuzzy');
  });
});
