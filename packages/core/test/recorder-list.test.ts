import { dataset } from '@webscoop/playground';
import { describe, expect, it } from 'vitest';
import { emptyDraft, loadRecipe, nodeAt, pathOf, type Draft, type HostMessage, type AnnotatedNode, type RecorderState } from '../src';
import { h } from '../src/testing';
import { acceptList, byClass, cardPath, harness, manualList, openList } from './recorder-helpers';
import { tier0Snapshot } from './snapshot';

function newDraft(): Draft {
  return emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?tier={tier}', vars: [{ name: 'tier', value: '0' }] });
}describe('RecorderController', () => {
  it('proposes 24 items from one title with host counts on every candidate', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    expect(t.session.injected).toEqual(['/* recorder */']);
    await t.pick(byClass(t.page, 'product-title', 0));
    // The pick suggests a list; nothing is set up until the user asks.
    expect(t.controller.state.selected!.suggestion).toMatchObject({ count: 24, more: 21 });
    expect(t.controller.state.selected!.suggestion!.samples[0]).toContain(dataset[0]!.title);
    expect(t.controller.state.proposal).toBeNull();
    expect(t.controller.draft.tables[0]!.item).toBeNull();
    expect(t.events.map((e) => e.name)).toEqual(['recorder.navigated', 'recorder.selected']);
    await t.send({ kind: 'list.open', from: 'suggestion' });
    const state = t.controller.state;
    expect(state.proposal!.origin).toBe('pick');
    expect(state.proposal!.pick).toMatchObject({ selector: { strategy: 'role', value: 'heading' }, matched: 24, total: 24 });
    expect(state.selected!.selection.candidates.length).toBeGreaterThan(0);
    for (const c of state.selected!.selection.candidates) expect(c.count, `${c.strategy}=${c.value}`).toBeTypeOf('number');
    expect(state.selected!.selection.candidates.find((c) => c.strategy === 'role')?.count).toBe(1);
    expect(state.proposal!.proposed.count).toBe(24);
    expect(state.proposal!.proposed.paths).toHaveLength(24);
    expect(state.proposal!.proposed.selectors.slice(0, 2)).toMatchObject([
      { strategy: 'role', value: 'article', count: 24 },
      { strategy: 'testid', value: 'product-card', count: 24 },
    ]);
    expect(state.proposal!.within).toMatchObject({ tag: 'ul', count: 1 });
    expect(state.proposal!.within!.selectors[0]).toMatchObject({ strategy: 'role', value: 'list', count: 1 });
    expect(state.proposal!.within!.selectors.map((c) => c.value)).toContain('product-list');
    expect(state.proposal!.skipped).toBe(0);
    for (const c of state.proposal!.proposed.selectors) expect(c.count).toBeTypeOf('number');
    expect(state.proposal!.proposed.samples[0]).toContain(dataset[0]!.title);
    expect(t.events.map((e) => e.name)).toEqual(['recorder.navigated', 'recorder.selected', 'recorder.itemsProposed']);
  });

  it('chooses a broader item level from the ladder', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    const title = byClass(t.page, 'product-title', 0);
    await t.pick(title);
    await t.send({ kind: 'list.open', from: 'suggestion' });
    expect(t.controller.state.proposal!.itemLadder).toBeNull();
    await t.send({ kind: 'list.ladder', which: 'item' });
    const ladder = t.controller.state.proposal!.itemLadder!;
    expect(ladder[0]).toMatchObject({ distance: 0, path: pathOf(title), count: 24, likely: false });
    const likely = ladder.find((r) => r.likely)!;
    expect(likely).toMatchObject({ path: cardPath(title), count: 24 });
    const li = ladder.find((r) => r.distance === likely.distance + 1)!;
    expect(li).toMatchObject({ path: cardPath(title).slice(0, -1), count: 24 });
    // The ladder stops below the list parent.
    expect(ladder.at(-1)!.path).toEqual(cardPath(title).slice(0, -1));
    await t.send({ kind: 'draft.setLevel', level: 'item', by: 'path', path: li.path });
    const p = t.controller.state.proposal!;
    expect(p.proposed).toMatchObject({ tag: 'li', count: 24 });
    expect(p.proposed.paths).toHaveLength(24);
    // The open ladder follows the new level.
    expect(p.itemLadder!.find((r) => r.likely)!.path).toEqual(li.path);
    await t.send({ kind: 'list.ladder', which: 'parent' });
    const parents = t.controller.state.proposal!.parentLadder!;
    expect(parents[0]).toMatchObject({ distance: 1, children: 24, likely: true, selector: { strategy: 'role', value: 'list' } });
  });

  it('folds ladder levels that match the same elements', async () => {
    // Each item wraps its heading in two single-child divs: the two wrappers match the same elements through `div` selectors.
    const item = (i: number) => h('li', { class: 'row' }, h('div', { class: 'outer' }, h('div', { class: 'inner' }, h('h3', {}, `Item ${i}`))), h('p', {}, `Text ${i}`));
    const dom = h('html', {}, h('body', {}, h('ul', { class: 'rows' }, ...Array.from({ length: 5 }, (_, i) => item(i)))));
    const url = 'http://127.0.0.1:4777/rows';
    const t = await harness(dom, emptyDraft({ name: 'rows', url, vars: [] }), url);
    await t.pick(byClass(t.page, 'inner', 0).children[0] as AnnotatedNode);
    await t.send({ kind: 'list.open', from: 'suggestion' });
    await t.send({ kind: 'list.ladder', which: 'item' });
    const ladder = t.controller.state.proposal!.itemLadder!;
    expect(ladder.map((r) => [r.distance, r.count, r.likely, r.sameAs])).toEqual([
      [0, 5, false, null],
      // The inner wrapper is the only child of the outer one: both match the same 5 items.
      [1, 5, false, 2],
      [2, 5, false, null],
      [3, 5, true, null],
    ]);
  });

  it('confirms the container and turns the pick into an item field', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    const title = byClass(t.page, 'product-title', 0);
    await t.pick(title);
    await t.send({ kind: 'list.open', from: 'suggestion' });
    await t.send({ kind: 'draft.confirmItems' });
    // Accept returns to the pick, read inside its item, without adding it.
    expect(t.controller.draft.tables[0]!.fields).toHaveLength(0);
    expect(t.controller.state.proposal).toBeNull();
    expect(t.controller.state.selected).toMatchObject({ scope: 'item', suggestion: null, outside: null, selection: { containerPath: cardPath(title) } });
    expect(t.controller.state.selected!.selection.candidates[0]).toMatchObject({ count: 24, items: 24 });
    await t.send({ kind: 'draft.addField', patch: {} });
    const { draft } = t.controller;
    // A list's first field keeps the default name `items`.
    expect(draft.tables[0]!.name).toBe('items');
    expect(draft.tables[0]!.item).toMatchObject({ count: 24, total: 24 });
    expect(draft.tables[0]!.item!.selectors.slice(0, 2).map((c) => c.value)).toEqual(['article', 'product-card']);
    expect(draft.tables[0]!.item!.within![0]).toMatchObject({ strategy: 'role', value: 'list' });
    expect(draft.tables[0]!.fields).toHaveLength(1);
    expect(draft.tables[0]!.fields[0]).toMatchObject({ name: 'wireless_mouse', type: 'text', scope: 'item', count: 24, sample: dataset[0]!.title });
    expect(draft.tables[0]!.fields[0]!.selectors[0]).toMatchObject({ strategy: 'role', value: 'heading', count: 24 });

    // A later pick inside a card is item scoped and relative.
    const price = byClass(t.page, 'product-price', 3);
    await t.pick(price, cardPath(price));
    expect(t.controller.state.selected!.scope).toBe('item');
    expect(t.controller.state.selected!.defaults).toEqual({ name: 'f_1_299_00', type: 'number', table: 0 });
    await t.send({ kind: 'draft.addField', patch: { name: 'price' } });
    await t.send({ kind: 'draft.updateField', index: 0, patch: { name: 'title' } });
    expect(t.controller.draft.tables[0]!.fields.map((f) => [f.name, f.count, f.sample])).toEqual([
      ['title', 24, dataset[0]!.title],
      ['price', 24, String(dataset[0]!.price)],
    ]);

    const reply = (await t.send({ kind: 'test.run' })) as HostMessage & { kind: 'test.results' };
    expect(reply.results.tables[0]!.rowCount).toBe(24);
    expect(reply.results.tables[0]!.fields).toEqual([
      { name: 'title', status: 'ok' },
      { name: 'price', status: 'ok' },
    ]);
    expect(reply.results.tables[0]!.rows.map((r) => r.title)).toEqual(dataset.map((p) => p.title));
  });

  it('excludes sponsored cards from the item count', async () => {
    const t = await harness(tier0Snapshot({ sponsored: 2 }), newDraft());
    await openList(t, byClass(t.page, 'product-title', 5));
    await acceptList(t);
    expect(t.controller.draft.tables[0]!.item).toMatchObject({ count: 24, total: 24 });
    await t.send({ kind: 'draft.addExclusion', selector: '.sponsored' });
    expect(t.controller.draft.tables[0]!.item).toMatchObject({ count: 22, total: 24, exclude: [{ strategy: 'css', value: '.sponsored', count: 2 }] });
    expect(t.controller.draft.tables[0]!.fields[0]!.count).toBe(22);
    const results = await t.controller.testRun();
    expect(results.tables[0]!.rowCount).toBe(22);
    expect(results.tables[0]!.rows[0]!.wireless_mouse ?? results.tables[0]!.rows[0]![t.controller.draft.tables[0]!.fields[0]!.name]).toBe(dataset[2]!.title);
  });

  it('applies exclusions added while the proposal is shown', async () => {
    const t = await harness(tier0Snapshot({ sponsored: 2 }), newDraft());
    await openList(t, byClass(t.page, 'product-title', 5));
    await t.send({ kind: 'draft.addExclusion', selector: '.sponsored' });
    expect(t.controller.state.proposal!.proposed).toMatchObject({ count: 22, total: 24 });
    expect(t.controller.state.proposal!.exclude).toEqual([{ strategy: 'css', value: '.sponsored', stability: 'medium', count: 2 }]);
    await t.send({ kind: 'draft.confirmItems' });
    expect(t.controller.draft.tables[0]!.item).toMatchObject({ count: 22, total: 24, exclude: [{ value: '.sponsored' }] });
  });

  it('offers a page field when nothing repeats', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    await t.pick(byClass(t.page, 'category-heading'));
    expect(t.controller.state.proposal).toBeNull();
    expect(t.controller.state.selected).toMatchObject({ scope: 'page', suggestion: null });
    // A scope in the patch is ignored: the table's mode decides.
    await t.send({ kind: 'draft.addField', patch: { scope: 'item' } });
    expect(t.controller.draft.tables[0]!.fields[0]).toMatchObject({ name: 'electronics', scope: 'page', count: 1, sample: 'Electronics' });
    // The first field makes a page table, and the default name follows the mode.
    expect(t.controller.draft.tables[0]!.name).toBe('page');
    expect(t.controller.draft.tables[0]!.defaultName).toBeUndefined();
  });

  it('adds a single value without setting up a list after dismissing the suggestion', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    await t.pick(byClass(t.page, 'product-title', 0));
    expect(t.controller.state.selected!.suggestion!.count).toBe(24);
    await t.send({ kind: 'list.dismiss' });
    expect(t.controller.state.selected!.suggestion).toBeNull();
    await t.send({ kind: 'draft.addField', patch: {} });
    expect(t.controller.draft.tables[0]).toMatchObject({ name: 'page', item: null, fields: [{ scope: 'page' }] });
    // A page table cannot become a list.
    await t.pick(byClass(t.page, 'product-title', 1));
    expect(t.controller.state.selected!.suggestion!.count).toBe(24);
    await t.send({ kind: 'list.open', from: 'suggestion' });
    expect(t.controller.state.error).toMatch(/page table cannot become a list/);
    expect(t.controller.state.proposal).toBeNull();
  });

  it('keeps a name the user typed when the first field is added', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    await t.send({ kind: 'draft.renameTable', name: 'search-info' });
    await t.pick(byClass(t.page, 'category-heading'));
    await t.send({ kind: 'draft.addField', patch: {} });
    expect(t.controller.draft.tables[0]!.name).toBe('search-info');
  });

  it('cancels the list setup back to the pick and its suggestion', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    const title = byClass(t.page, 'product-title', 0);
    await t.pick(title);
    const selected = t.controller.state.selected;
    await t.send({ kind: 'list.open', from: 'suggestion' });
    await t.send({ kind: 'draft.setLevel', level: 'item', by: 'path', path: cardPath(title).slice(0, -1) });
    await t.send({ kind: 'draft.cancelItems' });
    expect(t.controller.state.proposal).toBeNull();
    expect(t.controller.draft.tables[0]!.item).toBeNull();
    expect(t.controller.state.selected).toEqual(selected);
    // Opening again starts from the inferred list, not the cancelled edit.
    await t.send({ kind: 'list.open', from: 'suggestion' });
    expect(t.controller.state.proposal!.proposed.tag).toBe('article');
  });

  it('returns to the empty state with a notice when the pick is the item itself', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    const title = byClass(t.page, 'product-title', 0);
    const card = nodeAt(t.page, cardPath(title))!;
    await t.pick(card);
    await t.send({ kind: 'list.open', from: 'suggestion' });
    // The inferred item holds the card; make the card itself the item.
    await t.send({ kind: 'draft.setLevel', level: 'item', by: 'path', path: cardPath(title) });
    expect(t.controller.state.proposal!.proposed.path).toEqual(cardPath(title));
    expect(t.controller.state.proposal!.pick).toBeNull();
    await t.send({ kind: 'draft.confirmItems' });
    expect(t.controller.draft.tables[0]).toMatchObject({ item: { count: 24 }, fields: [] });
    expect(t.controller.state).toMatchObject({ selected: null, notice: 'List ready — pick fields inside an item' });
    // The next pick clears the notice.
    await t.pick(title, cardPath(title));
    expect(t.controller.state.notice).toBeNull();
  });

  it('sets a list up manually when nothing repeats', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    await t.pick(byClass(t.page, 'category-heading'));
    await t.send({ kind: 'list.open', from: 'manual' });
    const p = t.controller.state.proposal!;
    expect(p).toMatchObject({ origin: 'manual', within: null, pick: null, proposed: { selectors: [], count: 0, paths: [] } });
    // Accept is refused while the item matches nothing.
    await t.send({ kind: 'draft.confirmItems' });
    expect(t.controller.state.error).toMatch(/matches nothing/);
    expect(t.controller.draft.tables[0]!.item).toBeNull();
    // A list parent that matches nothing is named, and the count stays 0.
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'selector', selector: 'css=.no-such-list' });
    expect(t.controller.state.proposal).toMatchObject({
      within: { count: 0, selectors: [{ strategy: 'css', value: '.no-such-list', count: 0 }] },
      proposed: { count: 0 },
      error: { level: 'within', message: 'list parent matches nothing' },
    });
    await t.send({ kind: 'draft.confirmItems' });
    expect(t.controller.draft.tables[0]!.item).toBeNull();
    // Also on a setup from a pick: 0 items, and Accept is refused.
    const picked = await harness(tier0Snapshot(), newDraft());
    await picked.pick(byClass(picked.page, 'product-title', 0));
    await picked.send({ kind: 'list.open', from: 'suggestion' });
    await picked.send({ kind: 'draft.setLevel', level: 'within', by: 'selector', selector: 'css=.no-such-list' });
    expect(picked.controller.state.proposal!.proposed.count).toBe(0);
    await picked.send({ kind: 'draft.confirmItems' });
    expect(picked.controller.draft.tables[0]!.item).toBeNull();
    // The next edit starts from the inferred list again.
    await picked.send({ kind: 'draft.setLevel', level: 'within', by: 'clear' });
    expect(picked.controller.state.proposal!.proposed.count).toBe(24);
    // Any element on the page may be the item: one product card.
    const title = byClass(t.page, 'product-title', 0);
    await t.send({ kind: 'draft.pickLevel', level: 'item' });
    expect(t.controller.state.levelPick).toMatchObject({ level: 'item', containing: null, descendantOf: null });
    await t.send({ kind: 'draft.setLevel', level: 'item', by: 'pick', path: cardPath(title) });
    expect(t.controller.state.proposal!.proposed).toMatchObject({ tag: 'article', count: 24 });
    expect(t.controller.state.proposal!.proposed.paths).toHaveLength(24);
    await t.send({ kind: 'draft.confirmItems' });
    expect(t.controller.draft.tables[0]!.item).toMatchObject({ count: 24 });
    // The heading is outside every card: the Pick section says the list is ready.
    expect(t.controller.state).toMatchObject({ selected: null, notice: 'List ready — pick fields inside an item' });
  });

  it('locks the list once it has a field and clears the table', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    await openList(t, byClass(t.page, 'product-title', 0));
    await acceptList(t);
    await t.send({ kind: 'draft.clearItem' });
    expect(t.controller.state.error).toMatch(/locked/);
    expect(t.controller.draft.tables[0]!.item).not.toBeNull();
    await t.send({ kind: 'draft.clearTable' });
    expect(t.controller.draft.tables[0]).toMatchObject({ name: 'items', item: null, fields: [] });
    // The next repeating pick shows the suggestion again.
    await t.pick(byClass(t.page, 'product-title', 2));
    expect(t.controller.state.selected!.suggestion!.count).toBe(24);
  });

  it('proposes url pagination for a numeric page link', async () => {
    const dom = h('html', {}, h('body', {}, h('main', {}, h('h1', {}, 'x')), h('nav', {}, h('a', { class: 'next', href: '/catalog?page=2' }, 'Next'))));
    const url = 'http://127.0.0.1:4777/catalog?page=1';
    const t = await harness(dom, emptyDraft({ name: 'paged', url, vars: [] }), url);
    await t.pick(byClass(t.page, 'next'));
    await t.send({ kind: 'draft.markPagination' });
    await t.send({ kind: 'paginate.update', patch: { limit: 3 } });
    expect(t.controller.draft.pagination).toMatchObject({
      kind: 'url',
      param: { name: 'page', start: 1, step: 1 },
      limit: 3,
    });
    expect(t.controller.draft.pagination!.target!.selectors[0]).toMatchObject({ strategy: 'role', value: 'link|Next' });
  });
});

describe('RecorderController proposal fields', () => {
  const title = (t: { page: AnnotatedNode }, nth = 0) => byClass(t.page, 'product-title', nth);
  const proposal = (t: { controller: { state: RecorderState } }) => t.controller.state.proposal!;

  it('reports skipped dissimilar siblings on the mixed catalog', async () => {
    const t = await harness(tier0Snapshot({ mixed: true }), newDraft());
    await openList(t, title(t, 1));
    expect(proposal(t)).toMatchObject({ skipped: 6, includeAll: false, error: null });
    expect(proposal(t).within!.label).toBe('ul.product-list');
    expect(proposal(t).proposed).toMatchObject({ tag: 'article', count: 24 });
    expect(proposal(t).proposed.paths).toHaveLength(24);
    expect(t.events.find((e) => e.name === 'recorder.itemsProposed')!.payload).toMatchObject({ count: 24, within: 'list', skipped: 6 });
  });

  it('toggles include all siblings', async () => {
    const t = await harness(tier0Snapshot({ mixed: true }), newDraft());
    await openList(t, title(t, 1));
    await t.send({ kind: 'draft.toggleIncludeAll' });
    expect(proposal(t)).toMatchObject({ skipped: 0, includeAll: true });
    expect(proposal(t).proposed).toMatchObject({ count: 30 });
    expect(proposal(t).proposed.paths).toHaveLength(30);
    expect(proposal(t).proposed.selectors[0]).toMatchObject({ strategy: 'role', value: 'article', count: 30 });
    await t.send({ kind: 'draft.toggleIncludeAll' });
    expect(proposal(t)).toMatchObject({ skipped: 6, includeAll: false });
    expect(proposal(t).proposed.count).toBe(24);
  });

  it('narrows and widens the list parent by picking', async () => {
    const t = await harness(tier0Snapshot({ rows: 4 }), newDraft());
    await openList(t, title(t, 5));
    expect(proposal(t).proposed.count).toBe(24);
    const row = byClass(t.page, 'product-row', 1);
    await t.send({ kind: 'draft.pickLevel', level: 'within' });
    expect(t.controller.state.levelPick).toEqual({ level: 'within', ancestorOf: [proposal(t).proposed.path], ofContainers: false, descendantOf: null, containing: null });
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'pick', path: pathOf(row) });
    expect(t.controller.state.levelPick).toBeNull();
    expect(proposal(t).within!.path).toEqual(pathOf(row));
    expect(proposal(t).proposed.count).toBe(4);
    expect(proposal(t).proposed.paths).toHaveLength(4);
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'pick', path: pathOf(byClass(t.page, 'product-list')) });
    expect(proposal(t).proposed.count).toBe(24);
    expect(proposal(t).proposed.paths).toHaveLength(24);
    // An element that is not an ancestor of the item is refused and nothing changes.
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'pick', path: pathOf(byClass(t.page, 'category-heading')) });
    expect(proposal(t).error).toMatchObject({ level: 'within', message: expect.stringContaining('outside the list') });
    expect(proposal(t).proposed.count).toBe(24);
  });

  it('sets the item level by typed selector and refuses one that matches nothing', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    await openList(t, title(t, 2));
    await t.send({ kind: 'draft.setLevel', level: 'item', by: 'selector', selector: 'role=listitem' });
    expect(proposal(t).error).toBeNull();
    expect(proposal(t).proposed).toMatchObject({ tag: 'li', count: 24 });
    expect(proposal(t).proposed.selectors[0]).toMatchObject({ strategy: 'role', value: 'listitem', count: 24 });
    expect(proposal(t).proposed.paths).toHaveLength(24);
    await t.send({ kind: 'draft.setLevel', level: 'item', by: 'selector', selector: '.no-such-card' });
    expect(proposal(t).error).toEqual({ level: 'item', message: '".no-such-card" matches nothing inside the list parent' });
    expect(proposal(t).proposed.selectors[0]).toMatchObject({ strategy: 'role', value: 'listitem', count: 24 });
    await acceptList(t);
    expect(t.controller.draft.tables[0]!.item!.selectors[0]).toMatchObject({ strategy: 'role', value: 'listitem' });
    expect(t.controller.draft.tables[0]!.item!.count).toBe(24);
    expect(t.controller.draft.tables[0]!.fields[0]).toMatchObject({ scope: 'item', count: 24 });
  });

  it('picks the item level inside the list parent only', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    const pick = title(t, 2);
    await openList(t, pick);
    await t.send({ kind: 'draft.pickLevel', level: 'item' });
    expect(t.controller.state.levelPick).toMatchObject({ level: 'item', descendantOf: proposal(t).within!.path, containing: pathOf(pick) });
    await t.send({ kind: 'draft.setLevel', level: 'item', by: 'pick', path: pathOf(pick.parent!.parent!) });
    expect(proposal(t).proposed).toMatchObject({ tag: 'li', count: 24 });
    await t.send({ kind: 'draft.setLevel', level: 'item', by: 'pick', path: pathOf(title(t, 3)) });
    expect(proposal(t).error?.message).toContain('holds the selected element');
  });

  it('saves the list parent with the chosen primaries, and leaves it out when cleared', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    await openList(t, title(t, 0));
    await t.send({ kind: 'draft.setLevel', level: 'item', by: 'path', path: cardPath(title(t, 0)).slice(0, -1) });
    const broader = proposal(t).proposed;
    expect(broader.tag).toBe('li');
    const role = broader.selectors.findIndex((c) => c.strategy === 'role');
    const css = broader.selectors.findIndex((c) => c.strategy === 'css');
    await t.send({ kind: 'draft.setPrimary', level: 'item', index: css });
    expect(proposal(t).proposed.primary).toBe(css);
    await t.send({ kind: 'draft.setPrimary', level: 'item', index: role });
    const withinCss = proposal(t).within!.selectors.findIndex((c) => c.strategy === 'css');
    await t.send({ kind: 'draft.setPrimary', level: 'within', index: withinCss });
    await acceptList(t);
    const item = t.controller.draft.tables[0]!.item!;
    expect(item.selectors[0]).toMatchObject({ strategy: 'role', value: 'listitem' });
    expect(item.within![0]).toMatchObject({ strategy: 'css', value: 'ul.product-list' });
    expect(item.withinFingerprint?.tag).toBe('ul');
    expect(item.withinCount).toBe(1);
    await t.send({ kind: 'draft.setName', name: 'shop-within' });
    await t.send({ kind: 'save.request' });
    const saved = loadRecipe(t.storage.files.get('shop-within')!);
    expect(saved.item!.selectors[0]).toEqual({ strategy: 'role', value: 'listitem', stability: 'stable' });
    expect(saved.item!.within![0]).toEqual({ strategy: 'css', value: 'ul.product-list', stability: 'medium' });

    const cleared = await harness(tier0Snapshot(), newDraft());
    await openList(cleared, title(cleared, 0));
    await cleared.send({ kind: 'draft.setLevel', level: 'within', by: 'clear' });
    expect(proposal(cleared).within).toBeNull();
    expect(proposal(cleared).proposed.count).toBe(24);
    await acceptList(cleared);
    expect(cleared.controller.draft.tables[0]!.item!.within).toBeUndefined();
    await cleared.send({ kind: 'save.request' });
    expect(loadRecipe(cleared.storage.files.get('shop-catalog')!).item).not.toHaveProperty('within');
  });

  it('re-picks and clears the list parent from the confirmed item', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    await manualList(t, nodeAt(t.page, cardPath(title(t, 0)))!, { clearWithin: true });
    expect(t.controller.draft.tables[0]!.item!.within).toBeUndefined();
    await t.send({ kind: 'draft.pickLevel', level: 'within' });
    expect(t.controller.state.levelPick).toMatchObject({ level: 'within', ofContainers: true });
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'pick', path: pathOf(byClass(t.page, 'product-list')), snapshot: t.snapshot });
    expect(t.controller.draft.tables[0]!.item!.within![0]).toMatchObject({ strategy: 'role', value: 'list' });
    expect(t.controller.draft.tables[0]!.item).toMatchObject({ withinCount: 1 });
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'pick', path: pathOf(byClass(t.page, 'category-heading')), snapshot: t.snapshot });
    expect(t.controller.state.error).toContain('outside the list');
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'clear' });
    expect(t.controller.draft.tables[0]!.item!.within).toBeUndefined();
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'selector', selector: 'css=ul.product-list' });
    expect(t.controller.draft.tables[0]!.item!.within![0]).toMatchObject({ strategy: 'css', value: 'ul.product-list', count: 1 });
  });

  it('relativizes item fields at a bare div container', async () => {
    const item = (i: number) =>
      h('div', { class: 'asEBEc' }, h('div', {}, h('div', {}, h('span', {}, 'Price')), h('div', {}, h('span', { class: 'price kXeqYt' }, `$${i}.00`))), h('h3', {}, `Item ${i}`));
    const dom = h('html', {}, h('body', {}, h('main', { class: 'results' }, Array.from({ length: 5 }, (_, i) => item(i + 1)))));
    const t = await harness(dom, newDraft());
    const price = byClass(t.page, 'price', 1);
    await openList(t, price);
    expect(proposal(t).proposed.count).toBe(5);
    expect(proposal(t).within!.label).toBe('main.results');
    await acceptList(t);
    const field = t.controller.draft.tables[0]!.fields[0]!;
    expect(field.selectors[0]).toMatchObject({ strategy: 'css', value: 'span.price', count: 5 });
    expect(field.selectors.map((c) => [c.strategy, c.value])).toContainEqual(['class', 'span.price.kXeqYt']);
    expect(field.selectors.map((c) => [c.strategy, c.value])).toContainEqual(['xpath', './div[1]/div[2]/span[1]']);
    // A later pick inside a container is relative to that container too.
    const other = byClass(t.page, 'price', 3);
    await t.pick(other, pathOf(other.parent!.parent!.parent!));
    expect(t.controller.state.selected!.selection.candidates[0]).toMatchObject({ strategy: 'css', value: 'span.price', count: 5 });
  });
});
