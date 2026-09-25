import { dataset } from '@webscoop/playground';
import { describe, expect, it } from 'vitest';
import { annotate, detach, emptyDraft, extractPage, loadRecipe, pathOf, selectionOf, type Draft, type LevelView, type RecorderState } from '../src';
import { FakeBrowser, h } from '../src/testing';
import { byClass, harness, RESULTS } from './recorder-helpers';
import { resultsSnapshot, tier0Snapshot } from './snapshot';

function resultsDraft(): Draft {
  return emptyDraft({ name: 'search-results', url: RESULTS, vars: [] });
}

const proposal = (t: { controller: { state: RecorderState } }) => t.controller.state.proposal!;

/** Tokens of the elements at and above `div#rso`, which no item candidate relative to it may mention. */
const ABOVE_LIST = /\bmain\b|rso|GyAeWb|s6JM6d|center_col|dURPMd|html|body/;

const levels = (t: { controller: { state: RecorderState } }): LevelView[] =>
  [proposal(t).proposed, proposal(t).broader, proposal(t).narrower].filter((l): l is LevelView => l !== null);

describe('item containers relative to the list parent', () => {
  it('proposes the results under div#rso with a count that agrees with the samples', async () => {
    const t = await harness(resultsSnapshot(), resultsDraft(), RESULTS);
    await t.pick(byClass(t.page, 'LC20lb', 2));
    const p = proposal(t);
    expect(p.within!.selectors[0]).toMatchObject({ strategy: 'id', value: 'rso', count: 1 });
    expect(p.proposed.count).toBeGreaterThan(0);
    expect(p.proposed.count).toBe(p.proposed.paths.length);
    expect(p.proposed.count).toBe(8);
    expect(p.skipped).toBe(1);
    expect(p.proposed.samples[0]).toContain(dataset[0]!.title);
    for (const level of levels(t)) {
      for (const c of level.selectors) expect(`${c.strategy}=${c.value}`).not.toMatch(ABOVE_LIST);
    }
    expect(p.proposed.selectors.find((c) => c.strategy === 'xpath')?.value).toMatch(/^\.\//);
  });

  it('falls back to document relative candidates with an item level error when none matches inside the list parent', async () => {
    const card = (i: number) => h('div', { class: 'card' }, h('h3', {}, `Card ${i}`), h('p', {}, `About ${i}`));
    const cards = Array.from({ length: 4 }, (_, i) => card(i + 1));
    // The page changed after the snapshot: a new first section now sits where the list was.
    const live = h('html', {}, h('body', {}, h('main', {}, h('section', {}, h('p', {}, 'New banner')), h('section', { class: 'list' }, cards))));
    const snap = h('html', {}, h('body', {}, h('main', {}, h('section', { class: 'list' }, cards))));
    const t = await harness(live, resultsDraft(), RESULTS);
    const page = annotate(snap);
    const title = page.children[0]!.type === 'element' ? byClass(page, 'card', 0).children.find((c) => c.type === 'element')! : null;
    await t.send({ kind: 'picker.select', url: RESULTS, selection: selectionOf(title as never, { containerPath: null }), snapshot: detach(page) });
    const p = proposal(t);
    expect(p.within!.label).toBe('section.list');
    expect(p.error).toMatchObject({ level: 'item', message: expect.stringContaining('whole page') });
    expect(p.proposed.selectors[0]).toMatchObject({ strategy: 'css', value: 'div.card', count: 4 });
    expect(p.proposed.selectors.find((c) => c.strategy === 'xpath')?.value).toMatch(/^\/html/);
    expect(p.proposed.count).toBe(4);
  });

  it('drops the old list parent from the item candidates when a wider one is picked', async () => {
    const t = await harness(resultsSnapshot(), resultsDraft(), RESULTS);
    const title = byClass(t.page, 'LC20lb', 5);
    await t.pick(title);
    const group = title.parent!.parent!.parent!.parent!;
    expect(group.attrs.class).toBe('hlcw0c');
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'pick', path: pathOf(group) });
    expect(proposal(t).proposed.count).toBe(4);
    for (const level of levels(t)) for (const c of level.selectors) expect(c.value).not.toMatch(ABOVE_LIST);
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'pick', path: pathOf(byClass(t.page, 'dURPMd')) });
    expect(proposal(t).within!.selectors[0]).toMatchObject({ strategy: 'id', value: 'rso' });
    expect(proposal(t).proposed.count).toBe(8);
    for (const c of proposal(t).proposed.selectors) expect(c.value).not.toMatch(/hlcw0c|rso/);

    const rows = await harness(tier0Snapshot({ rows: 4 }), resultsDraft(), RESULTS);
    await rows.pick(byClass(rows.page, 'product-title', 5));
    await rows.send({ kind: 'draft.setLevel', level: 'within', by: 'pick', path: pathOf(byClass(rows.page, 'product-row', 1)) });
    expect(proposal(rows).proposed.count).toBe(4);
    await rows.send({ kind: 'draft.setLevel', level: 'within', by: 'pick', path: pathOf(byClass(rows.page, 'product-list')) });
    expect(proposal(rows).proposed.count).toBe(24);
    for (const c of proposal(rows).proposed.selectors) expect(c.value).not.toContain('product-row');
  });

  it('makes the item candidates document relative, counted on the page, when the list parent is cleared', async () => {
    const t = await harness(resultsSnapshot(), resultsDraft(), RESULTS);
    await t.pick(byClass(t.page, 'LC20lb', 0));
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'clear' });
    const p = proposal(t);
    expect(p.within).toBeNull();
    expect(p.error).toBeNull();
    expect(p.proposed.count).toBe(8);
    expect(p.proposed.selectors[0]).toMatchObject({ strategy: 'class', value: 'div.main div.Mjj4Yd', count: 8 });
    expect(p.proposed.selectors.find((c) => c.strategy === 'css')?.value).toMatch(/^div\.main > /);
    expect(p.proposed.selectors.find((c) => c.strategy === 'xpath')?.value).toMatch(/^\/\/div\[@id='rso'\]/);
  });

  it('rewrites the selectors of a confirmed item relative to a list parent set afterwards, and back when it is cleared', async () => {
    const t = await harness(resultsSnapshot(), resultsDraft(), RESULTS);
    await t.pick(byClass(t.page, 'Mjj4Yd', 1));
    const cls = t.controller.state.selected!.selection.candidates.findIndex((c) => c.strategy === 'class');
    await t.send({ kind: 'inspect.primary', index: cls });
    await t.send({ kind: 'draft.setItem' });
    expect(t.controller.draft.item!.selectors[0]).toMatchObject({ strategy: 'class', value: 'div.main div.Mjj4Yd' });
    expect(t.controller.draft.item).toMatchObject({ count: 8 });
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'pick', path: pathOf(byClass(t.page, 'dURPMd')), snapshot: t.snapshot });
    expect(t.controller.state.error).toBeNull();
    const item = t.controller.draft.item!;
    expect(item.within![0]).toMatchObject({ strategy: 'id', value: 'rso' });
    expect(item.selectors[0]).toMatchObject({ strategy: 'class', value: 'div.Mjj4Yd', count: 8 });
    for (const c of item.selectors) expect(c.value).not.toMatch(ABOVE_LIST);
    expect(item).toMatchObject({ count: 8, total: 8 });
    const [rso] = await t.session.resolve({ strategy: 'id', value: 'rso', stability: 'stable' });
    for (const c of item.selectors) expect((await t.session.resolve(c, rso)).length, `${c.strategy}=${c.value}`).toBeGreaterThan(0);

    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'clear' });
    expect(t.controller.draft.item!.within).toBeUndefined();
    // The old primary finds the same 8 results in the whole document, so it stays first.
    expect(t.controller.draft.item!.selectors[0]).toMatchObject({ strategy: 'class', value: 'div.Mjj4Yd', count: 8 });
    expect(t.controller.draft.item!.selectors.map((c) => c.value)).toContain('div.main div.Mjj4Yd');
    expect(t.controller.draft.item).toMatchObject({ count: 8 });
  });

  it('keeps a tier 0 item count when the product list is set as list parent after confirming', async () => {
    const t = await harness(tier0Snapshot(), resultsDraft(), RESULTS);
    const card = byClass(t.page, 'product-card', 3);
    await t.pick(card);
    await t.send({ kind: 'draft.setItem' });
    const before = t.controller.draft.item!;
    expect(before.count).toBe(24);
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'pick', path: pathOf(byClass(t.page, 'product-list')), snapshot: t.snapshot });
    const after = t.controller.draft.item!;
    expect(after.selectors[0]).toMatchObject({ strategy: before.selectors[0]!.strategy, value: before.selectors[0]!.value });
    expect(after).toMatchObject({ count: 24, withinCount: 1 });
  });

  it('runs a recipe recorded on the results page with one row per result', async () => {
    const t = await harness(resultsSnapshot(), resultsDraft(), RESULTS);
    await t.pick(byClass(t.page, 'LC20lb', 0));
    await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
    expect(t.controller.draft.fields[0]).toMatchObject({ scope: 'item', count: 8 });
    await t.send({ kind: 'save.request' });
    const recipe = loadRecipe(t.storage.files.get('search-results')!);
    expect(recipe.item!.within![0]).toMatchObject({ strategy: 'id', value: 'rso' });
    for (const c of recipe.item!.selectors) expect(c.value).not.toMatch(ABOVE_LIST);

    const session = await new FakeBrowser({ [RESULTS]: resultsSnapshot() }).open('/run');
    await session.goto(RESULTS, { timeoutMs: 1000 });
    const out = await extractPage(session, recipe, { pageUrl: RESULTS, page: 1 });
    expect(out.missingRequired).toEqual([]);
    expect(out.rows).toHaveLength(8);
    const name = recipe.fields[0]!.name;
    expect(out.rows.map((r) => r[name])).toEqual(dataset.slice(0, 8).map((p) => p.title));
  });
});
