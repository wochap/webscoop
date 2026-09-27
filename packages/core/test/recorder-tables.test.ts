import { describe, expect, it } from 'vitest';
import {
  currentTable,
  defaultTableName,
  descendantsOf,
  draftErrors,
  draftFromRecipe,
  draftToRecipe,
  emptyDraft,
  loadRecipe,
  parseHostMessage,
  parsePageMessage,
  pathOf,
  RecorderController,
  reduceDraft,
  saveRecipe,
  tableMode,
  validateRecipe,
  type Draft,
  type DraftField,
  type HostMessage,
  type NewField,
  type RecipeInput,
} from '../src';
import { acceptList, byClass, cardPath, draftWith, harness, MemoryStorage, openList, referenceRecipe, type Harness } from './recorder-helpers';
import { tier0Snapshot } from './snapshot';

const MIXED = 'http://127.0.0.1:4777/catalog?mixed=1';
const css = (value: string) => ({ strategy: 'css' as const, value, stability: 'medium' as const });
const field = (name: string, value = `.${name}`): NewField => ({ name, type: 'text', scope: 'page', selectors: [css(value)] });
const draftField = (name: string, value = `.${name}`): DraftField => ({ ...field(name, value), optional: false, key: false, count: null, sample: null });

function newDraft(): Draft {
  return emptyDraft({ name: 'shop-catalog', url: MIXED, vars: [] });
}

describe('protocol: tables', () => {
  it('parses the table messages and the table target of a new field', () => {
    for (const msg of [
      { kind: 'draft.addTable' },
      { kind: 'draft.addTable', name: 'page' },
      { kind: 'draft.renameTable', name: 'products' },
      { kind: 'draft.removeTable' },
      { kind: 'draft.selectTable', index: 1 },
      { kind: 'draft.moveTable', from: 2, to: 0 },
      { kind: 'selection.retarget', table: 0 },
      { kind: 'selection.retarget', table: null },
      { kind: 'draft.addField', patch: { table: 1 } },
      { kind: 'draft.addField', patch: { table: { new: 'page' } } },
      { kind: 'draft.editField', index: 0, table: 1 },
    ]) {
      expect(parsePageMessage(JSON.parse(JSON.stringify(msg)))).toEqual(msg);
    }
    expect(() => parsePageMessage({ kind: 'draft.selectTable', index: -1 })).toThrow(/invalid page message/);
    expect(() => parsePageMessage({ kind: 'draft.addField', patch: { table: 'page' } })).toThrow(/invalid page message/);
  });

  it('parses a draft with tables and per table test results', () => {
    const draft = draftWith([{ name: 'page', fields: [draftField('heading')] }, { name: 'products', fields: [draftField('title')] }]);
    const results = {
      tables: [
        { name: 'page', rows: [{ _page: 1, _index: 0, heading: 'x' }], rowCount: 1, dropped: { count: 0, fields: [] }, fields: [{ name: 'heading', status: 'ok' }] },
        { name: 'products', rows: [], rowCount: 0, dropped: { count: 0, fields: [] }, fields: [{ name: 'title', status: 'missing' }], error: 'required field title matched no element' },
      ],
      durationMs: 3,
      warnings: [],
    };
    const state = { url: MIXED, draft, selected: null, proposal: null, repick: null, test: results, saved: null, busy: null, error: null };
    const parsed = parseHostMessage(JSON.parse(JSON.stringify({ kind: 'test.results', results, state }))) as HostMessage & { kind: 'test.results' };
    expect(parsed.results.tables.map((t) => t.name)).toEqual(['page', 'products']);
    expect(parsed.state.draft.tables.map((t) => t.name)).toEqual(['page', 'products']);
    expect(parsed.state.draft).toMatchObject({ activeTable: 0, form: 'tables' });
    expect(() => parseHostMessage({ kind: 'draft.state', state: { ...state, draft: { ...draft, tables: [] } } })).toThrow(/invalid host message/);
  });
});

describe('draft reducer: tables', () => {
  it('adds a table and makes it active', () => {
    let draft = reduceDraft(draftWith({}), { type: 'addField', field: field('title') });
    expect(defaultTableName(draft)).toBe('table-2');
    draft = reduceDraft(draft, { type: 'addTable', name: 'page' });
    expect(draft.tables.map((t) => t.name)).toEqual(['items', 'page']);
    expect(draft.activeTable).toBe(1);
    expect(currentTable(draft)).toMatchObject({ name: 'page', item: null, fields: [] });
    expect(draft.dirty).toBe(true);
    // Fields go to the active table.
    draft = reduceDraft(draft, { type: 'addField', field: field('heading') });
    expect(draft.tables.map((t) => t.fields.map((f) => f.name))).toEqual([['title'], ['heading']]);
    expect(reduceDraft(draft, { type: 'addTable', name: 'page' })).toBe(draft);
    expect(reduceDraft(draft, { type: 'addTable', name: 'Bad Name' })).toBe(draft);
  });

  it('names a new table page when every table has containers', () => {
    const item = { selectors: [css('.card')], exclude: [], count: null, total: null };
    expect(defaultTableName(draftWith({ name: 'products', item }))).toBe('page');
    expect(defaultTableName(draftWith([{ name: 'products', item }, { name: 'page' }]))).toBe('table-3');
  });

  it('renames the active table and rejects a duplicate', () => {
    let draft = draftWith([{ name: 'products', fields: [draftField('title')] }, { name: 'page', fields: [draftField('heading')] }]);
    draft = reduceDraft(draft, { type: 'selectTable', index: 1 });
    expect(reduceDraft(draft, { type: 'renameTable', name: 'products' })).toBe(draft);
    const renamed = reduceDraft(draft, { type: 'renameTable', name: 'header' });
    expect(renamed.tables.map((t) => t.name)).toEqual(['products', 'header']);
  });

  it('removes the active table but never the last one', () => {
    let draft = draftWith([{ name: 'page', fields: [draftField('heading')] }, { name: 'products', fields: [draftField('title')] }]);
    draft = reduceDraft(draft, { type: 'removeTable' });
    expect(draft.tables.map((t) => t.name)).toEqual(['products']);
    expect(draft.activeTable).toBe(0);
    expect(draft.tables.flatMap((t) => t.fields.map((f) => f.name))).toEqual(['title']);
    expect(reduceDraft(draft, { type: 'removeTable' })).toBe(draft);
  });

  it('selects a table without making the draft dirty', () => {
    const draft = draftWith([{ name: 'page', fields: [draftField('heading')] }, { name: 'products', fields: [draftField('title')] }]);
    const selected = reduceDraft(draft, { type: 'selectTable', index: 1 });
    expect(selected.activeTable).toBe(1);
    expect(selected.dirty).toBe(false);
    expect(reduceDraft(draft, { type: 'selectTable', index: 5 })).toBe(draft);
  });

  it('moves a table, keeps the active table, and marks the draft dirty', () => {
    const draft = draftWith([
      { name: 'results', fields: [draftField('title')] },
      { name: 'summary', fields: [draftField('heading')] },
      { name: 'ads', fields: [draftField('ad')] },
    ]);
    const active = reduceDraft(draft, { type: 'selectTable', index: 1 });
    const moved = reduceDraft(active, { type: 'moveTable', from: 2, to: 0 });
    expect(moved.tables.map((t) => t.name)).toEqual(['ads', 'results', 'summary']);
    expect(currentTable(moved).name).toBe('summary');
    expect(moved.dirty).toBe(true);
    expect(draftToRecipe(moved).tables!.map((t) => t.name)).toEqual(['ads', 'results', 'summary']);
    expect(reduceDraft(active, { type: 'moveTable', from: 1, to: 1 })).toBe(active);
    expect(reduceDraft(active, { type: 'moveTable', from: 7, to: 0 })).toBe(active);
  });

  it('round-trips the shorthand form', () => {
    const recipe = referenceRecipe();
    const draft = draftFromRecipe(recipe);
    expect(draft.form).toBe('shorthand');
    const out = draftToRecipe(draft);
    expect(out.tables).toBeUndefined();
    expect(out.fields!.map((f) => f.name)).toEqual(recipe.fields!.map((f) => f.name));
    expect(out.item!.selectors).toEqual(recipe.item!.selectors);
  });

  it('round-trips the tables form', () => {
    const input: RecipeInput = {
      schemaVersion: 1,
      name: 'results',
      url: MIXED,
      tables: [
        { name: 'page', fields: [{ name: 'heading', type: 'text', selectors: [css('h1')] }] },
        { name: 'products', item: { selectors: [css('.card')] }, fields: [{ name: 'title', type: 'text', selectors: [css('h2')] }] },
      ],
    };
    const draft = draftFromRecipe(loadRecipe(input));
    expect(draft).toMatchObject({ form: 'tables', activeTable: 0 });
    expect(draft.tables.map((t) => [t.name, t.item !== null, t.fields.map((f) => f.name)])).toEqual([
      ['page', false, ['heading']],
      ['products', true, ['title']],
    ]);
    const out = draftToRecipe(draft);
    expect(out.fields).toBeUndefined();
    expect(out.item).toBeUndefined();
    expect(out.tables!.map((t) => t.name)).toEqual(['page', 'products']);
    const validated = validateRecipe(out);
    expect(validated.ok).toBe(true);
  });

  it('saves a single renamed table in the tables form', () => {
    let draft = reduceDraft(draftWith({}), { type: 'addField', field: field('title') });
    expect(draftToRecipe(draft).tables).toBeUndefined();
    draft = reduceDraft(draft, { type: 'renameTable', name: 'products' });
    const out = draftToRecipe(draft);
    expect(out.fields).toBeUndefined();
    expect(out.tables!.map((t) => t.name)).toEqual(['products']);
  });
});

describe('draft reducer: table modes', () => {
  const item = { selectors: [css('.card')], exclude: [], count: null, total: null };

  it('derives the mode from the item container and the fields', () => {
    expect(tableMode({ item: null, fields: [] })).toBe('none');
    expect(tableMode({ item: null, fields: [draftField('heading')] })).toBe('page');
    expect(tableMode({ item, fields: [] })).toBe('list');
    expect(tableMode({ item, fields: [{ ...draftField('title'), scope: 'item' }] })).toBe('list');
  });

  it('marks recorder chosen names and never saves the mark', () => {
    let draft = newDraft();
    expect(draft.tables[0]).toMatchObject({ name: 'items', defaultName: true });
    draft = reduceDraft(draft, { type: 'addTable', name: 'table-2', defaultName: true });
    draft = reduceDraft(draft, { type: 'addTable', name: 'summary' });
    expect(draft.tables.map((t) => t.defaultName ?? false)).toEqual([true, true, false]);
    expect(JSON.stringify(draftToRecipe(draft))).not.toMatch(/defaultName/);
    // A rename clears it; a loaded recipe has none.
    const renamed = reduceDraft({ ...draft, activeTable: 0 }, { type: 'renameTable', name: 'results' });
    expect(renamed.tables[0]!.defaultName).toBeUndefined();
    expect(draftFromRecipe(referenceRecipe()).tables[0]!.defaultName).toBeUndefined();
  });

  it('names a default named table after its mode on the first field', () => {
    const page = reduceDraft(newDraft(), { type: 'addField', field: field('heading') });
    expect(page.tables[0]).toMatchObject({ name: 'page', fields: [{ name: 'heading' }] });
    expect(page.tables[0]!.defaultName).toBeUndefined();
    const list = reduceDraft({ ...newDraft(), tables: [{ name: 'table-2', item, fields: [], defaultName: true }] }, { type: 'addField', field: { ...field('title'), scope: 'item' } });
    expect(list.tables[0]!.name).toBe('items');
    // The name is taken: the table keeps its own and loses the mark.
    const taken = reduceDraft(
      { ...newDraft(), tables: [{ name: 'page', item: null, fields: [draftField('a')] }, { name: 'table-2', item: null, fields: [], defaultName: true }], activeTable: 1 },
      { type: 'addField', field: field('heading') },
    );
    expect(taken.tables.map((t) => [t.name, t.defaultName])).toEqual([
      ['page', undefined],
      ['table-2', undefined],
    ]);
  });

  it('clears the active table and keeps its name and position', () => {
    const draft = draftWith([
      { name: 'results', item, fields: [{ ...draftField('title'), scope: 'item' }] },
      { name: 'summary', fields: [draftField('heading')] },
    ]);
    const cleared = reduceDraft(draft, { type: 'clearTable' });
    expect(cleared.tables.map((t) => [t.name, t.item, t.fields.length])).toEqual([
      ['results', null, 0],
      ['summary', null, 1],
    ]);
  });

  it('moves a page field of a list to a new page table and keeps the list active', () => {
    const draft = draftWith({ name: 'products', item, fields: [{ ...draftField('title'), scope: 'item' }, { ...draftField('category'), attr: 'title', optional: true, coverage: { matched: 0, total: 24 } }] });
    const moved = reduceDraft(draft, { type: 'moveFieldToPage', index: 1 });
    expect(moved.activeTable).toBe(0);
    expect(moved.tables.map((t) => [t.name, t.fields.map((f) => [f.name, f.scope])])).toEqual([
      ['products', [['title', 'item']]],
      ['page', [['category', 'page']]],
    ]);
    expect(moved.tables[1]!.fields[0]).toMatchObject({ selectors: [css('.category')], attr: 'title', optional: true });
    expect(moved.tables[1]!.fields[0]!.coverage).toBeUndefined();
    // An existing page table receives the next one.
    const again = reduceDraft({ ...moved, tables: [{ ...moved.tables[0]!, fields: [...moved.tables[0]!.fields, { ...draftField('crumb'), scope: 'page' }] }, moved.tables[1]!] }, { type: 'moveFieldToPage', index: 1 });
    expect(again.tables.map((t) => t.fields.map((f) => f.name))).toEqual([['title'], ['category', 'crumb']]);
  });
});

describe('draft errors: tables', () => {
  it('maps a duplicate field name in the second table to that table and field', () => {
    const draft = draftWith([
      { name: 'page', fields: [draftField('title', 'h1')] },
      { name: 'products', fields: [draftField('title', 'h2'), draftField('title', 'h3')] },
    ]);
    expect(draft.tables[0]!.fields[0]!.error).toBeUndefined();
    expect(draft.tables[1]!.fields[0]!.error).toBeUndefined();
    expect(draft.tables[1]!.fields[1]!.error).toMatch(/duplicate field name "title"/);
    const errors = draftErrors(draft);
    expect(errors).toEqual([expect.objectContaining({ table: 1, index: 1, message: expect.stringMatching(/duplicate field name/) })]);
  });

  it('maps shorthand field paths to the first table', () => {
    const draft = draftWith({ fields: [draftField('title'), draftField('title')] });
    expect(draftErrors(draft)).toEqual([expect.objectContaining({ path: '$.fields[1].name', table: 0, index: 1 })]);
  });

  it('puts an empty table error on the table', () => {
    const draft = draftWith([{ name: 'page', fields: [draftField('heading')] }, { name: 'questions' }]);
    expect(draft.tables[1]!.error).toMatch(/at least one field/);
    expect(draft.errors).toEqual([]);
  });
});

/** Products confirmed from the first product title on the mixed catalog, the table renamed `products`. */
async function products(): Promise<Harness> {
  const t = await harness(tier0Snapshot({ mixed: true }), newDraft(), MIXED);
  const title = byClass(t.page, 'product-title', 0);
  await openList(t, title);
  await acceptList(t);
  await t.send({ kind: 'draft.renameTable', name: 'products' });
  return t;
}

describe('RecorderController: tables', () => {
  it('adds a table, picks the heading, and adds it to the new table', async () => {
    const t = await products();
    expect(t.controller.draft.tables[0]!.item!.count).toBe(24);
    await t.send({ kind: 'draft.addTable' });
    expect(t.controller.draft.tables.map((x) => x.name)).toEqual(['products', 'page']);
    expect(t.controller.draft.activeTable).toBe(1);
    await t.pick(byClass(t.page, 'category-heading'));
    expect(t.controller.state.proposal).toBeNull();
    expect(t.controller.state.selected).toMatchObject({ scope: 'page', table: 1, defaults: { table: 1 } });
    await t.send({ kind: 'draft.addField', patch: { name: 'category' } });
    expect(t.controller.draft.tables[1]!.fields).toEqual([expect.objectContaining({ name: 'category', scope: 'page', count: 1 })]);
    expect(t.controller.draft.tables[0]!.fields.map((f) => f.name)).toHaveLength(1);
  });

  it('creates a table from the field form', async () => {
    const t = await products();
    await t.pick(byClass(t.page, 'category-heading'));
    // No table without containers: the active table stays, and the pick is flagged outside its list.
    expect(t.controller.state.selected).toMatchObject({ scope: 'page', defaults: { table: 0 }, outside: { table: 0, pageTable: null } });
    await t.send({ kind: 'draft.addField', patch: { name: 'category', table: { new: 'page' } } });
    expect(t.controller.draft.tables.map((x) => [x.name, x.fields.map((f) => f.name)])).toEqual([
      ['products', ['wireless_mouse']],
      ['page', ['category']],
    ]);
    expect(t.controller.draft.activeTable).toBe(1);
    expect(t.controller.state.selected).toBeNull();
  });

  it('edits a field of the inactive table by activating it', async () => {
    const t = await products();
    await t.send({ kind: 'draft.addTable' });
    await t.pick(byClass(t.page, 'category-heading'));
    await t.send({ kind: 'draft.addField', patch: {} });
    expect(t.controller.draft.activeTable).toBe(1);
    await t.send({ kind: 'draft.editField', index: 0, table: 0 });
    expect(t.controller.draft.activeTable).toBe(0);
    expect(t.controller.state.editing).toMatchObject({ index: 0, options: { name: 'wireless_mouse', scope: 'item' } });
  });

  it('flags a pick outside the list and adds it only after switching to the page table', async () => {
    const t = await products();
    await t.send({ kind: 'draft.addTable', name: 'page' });
    await t.send({ kind: 'draft.selectTable', index: 0 });
    await t.pick(byClass(t.page, 'category-heading'));
    const selected = t.controller.state.selected!;
    expect(selected).toMatchObject({ scope: 'page', table: 0, outside: { table: 0, repeats: null, pageTable: 1 }, belongs: null, suggestion: null });
    expect(t.controller.draft.activeTable).toBe(0);
    expect(t.controller.state.proposal).toBeNull();
    // No field is added silently, to either table.
    await t.send({ kind: 'draft.addField', patch: { name: 'category' } });
    expect(t.controller.state.error).toMatch(/outside the products list/);
    expect(t.controller.draft.tables.map((x) => x.fields.length)).toEqual([1, 0]);
    // "Add to page": the pick is kept and computed for the page table.
    await t.send({ kind: 'draft.selectTable', index: 1 });
    expect(t.controller.state.selected).toMatchObject({ scope: 'page', table: 1, outside: null });
    expect(t.controller.draft.tables[1]!.fields).toHaveLength(0);
    await t.send({ kind: 'draft.addField', patch: { name: 'category' } });
    expect(t.controller.draft.tables[1]!.fields.map((f) => [f.name, f.scope])).toEqual([['category', 'page']]);
    await t.pick(byClass(t.page, 'category-heading'));
    await t.send({ kind: 'selection.retarget', table: 0 });
    const retargeted = t.controller.state.selected!;
    expect(retargeted).toMatchObject({ scope: 'page', table: 0 });
    expect(retargeted.selection.containerPath).toBeNull();
    expect(retargeted.selection.candidates[0]!.count).toBe(1);
    expect(retargeted.selection.candidates.every((c) => c.items === undefined)).toBe(true);
  });

  it('keeps the selection and computes it for the tab the user activates', async () => {
    const t = await products();
    await t.send({ kind: 'draft.addTable', name: 'page' });
    const price = byClass(t.page, 'product-price', 0);
    await t.pick(price);
    expect(t.controller.state.selected).toMatchObject({ scope: 'page', table: 1 });
    await t.send({ kind: 'draft.selectTable', index: 0 });
    expect(t.controller.draft.activeTable).toBe(0);
    expect(t.controller.state.selected).toMatchObject({ scope: 'item', table: 0, outside: null, belongs: null });
  });

  it('offers a new page table for a pick outside the only list', async () => {
    const t = await products();
    await t.pick(byClass(t.page, 'category-heading'));
    expect(t.controller.state.selected!.outside).toEqual({ table: 0, repeats: null, pageTable: null });
    // "New page table" with the default name.
    await t.send({ kind: 'draft.addTable', name: defaultTableName(t.controller.draft) });
    expect(t.controller.draft.tables.map((x) => x.name)).toEqual(['products', 'page']);
    expect(t.controller.state.selected).toMatchObject({ scope: 'page', table: 1, outside: null });
    expect(t.controller.draft.tables[1]!.fields).toHaveLength(0);
  });

  it('says how often a pick outside the list repeats and starts a list table for it', async () => {
    const t = await products();
    const question = byClass(t.page, 'questions-title', 0);
    await t.pick(question);
    const outside = t.controller.state.selected!.outside!;
    expect(outside).toMatchObject({ table: 0, pageTable: null });
    expect(outside.repeats).toBeGreaterThan(1);
    await t.send({ kind: 'list.open', from: 'newTable' });
    expect(t.controller.draft.tables.map((x) => x.name)).toEqual(['products', 'page']);
    expect(t.controller.draft.activeTable).toBe(1);
    const proposal = t.controller.state.proposal!;
    expect(proposal).toMatchObject({ origin: 'pick' });
    expect(proposal.proposed.count).toBeGreaterThan(0);
    expect(t.controller.state.selected).toMatchObject({ table: 1 });
    // A page table does not start a list in place.
    await t.send({ kind: 'draft.cancelItems' });
    expect(t.controller.state.selected!.suggestion!.count).toBe(outside.repeats);
  });

  it('says a pick belongs to another list, switches to it, and lists the other containers', async () => {
    const t = await products();
    await t.send({ kind: 'draft.addTable', name: 'questions' });
    await openList(t, byClass(t.page, 'questions-title', 0));
    const own = t.controller.state.proposal!.proposed.selectors.findIndex((c) => c.value === 'article.mixed-questions');
    await t.send({ kind: 'draft.setPrimary', level: 'item', index: own });
    await acceptList(t);
    expect(t.controller.draft.tables[1]!.item!.count).toBe(6);
    await t.send({ kind: 'draft.selectTable', index: 0 });
    // The questions containers, for muted outlines while the products list is active.
    const other = t.controller.state.otherLists;
    expect(other).toHaveLength(1);
    expect(other[0]!.table).toBe(1);
    expect(other[0]!.paths).toHaveLength(6);
    const blocks = descendantsOf(t.page).filter((n) => (n.attrs.class ?? '').split(' ').includes('mixed-questions'));
    expect(other[0]!.paths).toEqual(blocks.map(pathOf));

    await t.pick(byClass(t.page, 'questions-title', 1));
    const belongs = t.controller.state.selected!.belongs!;
    expect(belongs).toMatchObject({ table: 1, index: 1, of: 6, stack: { item: { value: 'article.mixed-questions' } } });
    expect(t.controller.state.selected!.outside).toBeNull();
    await t.send({ kind: 'draft.addField', patch: {} });
    expect(t.controller.state.error).toMatch(/belongs to the questions list/);
    await t.send({ kind: 'draft.selectTable', index: 1 });
    expect(t.controller.state.selected).toMatchObject({ scope: 'item', table: 1, belongs: null });
    expect(t.controller.state.otherLists.map((x) => x.table)).toEqual([0]);
  });

  it('shows a page table the repeating pick without setting up a list there', async () => {
    const t = await harness(tier0Snapshot({ mixed: true }), newDraft(), MIXED);
    await t.pick(byClass(t.page, 'category-heading'));
    await t.send({ kind: 'draft.addField', patch: {} });
    expect(t.controller.draft.tables[0]!.name).toBe('page');
    await t.pick(byClass(t.page, 'product-title', 0));
    expect(t.controller.state.selected!.suggestion!.count).toBe(24);
    await t.send({ kind: 'list.open', from: 'newTable' });
    expect(t.controller.draft.tables.map((x) => x.name)).toEqual(['page', 'table-2']);
    expect(t.controller.state.proposal!.proposed.count).toBe(24);
    await acceptList(t);
    // The new list takes the default name `items` with its first field.
    expect(t.controller.draft.tables.map((x) => [x.name, x.item !== null, x.fields.length])).toEqual([
      ['page', false, 1],
      ['items', true, 1],
    ]);
  });

  it('moves a misplaced page field of a loaded mixed table and saves an untouched one unchanged', async () => {
    const recipe = loadRecipe({
      schemaVersion: 1,
      name: 'mixed',
      url: MIXED,
      tables: [
        {
          name: 'products',
          item: { selectors: [{ strategy: 'testid', value: 'product-card', stability: 'stable' }], exclude: [] },
          fields: [
            { name: 'title', type: 'text', scope: 'item', selectors: [css('h2')] },
            { name: 'category', type: 'text', scope: 'page', selectors: [css('.category-heading')] },
          ],
        },
      ],
    });
    const untouched = await harness(tier0Snapshot({ mixed: true }), draftFromRecipe(recipe), MIXED);
    await untouched.send({ kind: 'save.request' });
    expect(untouched.storage.files.get('mixed')).toBe(saveRecipe(recipe));
    const results = await untouched.controller.testRun();
    expect(results.tables[0]!.rows.every((r) => r.category === 'Electronics')).toBe(true);

    const t = await harness(tier0Snapshot({ mixed: true }), draftFromRecipe(recipe), MIXED);
    await t.send({ kind: 'draft.moveFieldToPage', index: 1 });
    expect(t.controller.draft.activeTable).toBe(0);
    expect(t.controller.draft.tables.map((x) => [x.name, x.fields.map((f) => [f.name, f.scope])])).toEqual([
      ['products', [['title', 'item']]],
      ['page', [['category', 'page']]],
    ]);
    expect(t.controller.draft.tables[1]!.fields[0]).toMatchObject({ count: 1, selectors: [css('.category-heading')] });
  });

  it('creates, activates, and targets a new tab while an element is selected', async () => {
    const t = await products();
    await t.pick(byClass(t.page, 'category-heading'));
    expect(t.controller.state.selected).toMatchObject({ scope: 'page', table: 0 });
    await t.send({ kind: 'draft.addTable' });
    expect(t.controller.draft.tables.map((x) => x.name)).toEqual(['products', 'page']);
    expect(t.controller.draft.activeTable).toBe(1);
    expect(t.controller.state.selected).toMatchObject({ scope: 'page', table: 1 });
    await t.send({ kind: 'draft.addField', patch: { name: 'category' } });
    expect(t.controller.draft.tables[1]!.fields.map((f) => f.name)).toEqual(['category']);
  });

  it('moves tables, following the active table and the selection target', async () => {
    const t = await products();
    await t.send({ kind: 'draft.addTable', name: 'page' });
    await t.pick(byClass(t.page, 'category-heading'));
    expect(t.controller.state.selected).toMatchObject({ table: 1 });
    await t.send({ kind: 'draft.moveTable', from: 1, to: 0 });
    expect(t.controller.draft.tables.map((x) => x.name)).toEqual(['page', 'products']);
    expect(t.controller.draft.activeTable).toBe(0);
    expect(t.controller.state.selected).toMatchObject({ table: 0, defaults: { table: 0 } });
    expect(t.controller.draft.dirty).toBe(true);
  });

  it('keeps section collapse state for the session, outside the draft', async () => {
    const t = await products();
    expect(t.controller.state.panel.collapsed).toEqual({ recipe: false, steps: false, pagination: true });
    const dirty = t.controller.draft.dirty;
    await t.send({ kind: 'panel.setCollapsed', section: 'steps', collapsed: true });
    expect(t.controller.draft.dirty).toBe(dirty);
    // The page is injected again after a navigation and announces itself.
    await t.send({ kind: 'session.ready', url: MIXED });
    expect(t.controller.state.panel.collapsed).toEqual({ recipe: false, steps: true, pagination: true });
    const reply = (await t.send({ kind: 'save.request' })) as HostMessage & { kind: 'save.result' };
    expect(reply.ok).toBe(true);
    expect(JSON.stringify(await t.storage.load('shop-catalog'))).not.toMatch(/collapsed/);
  });

  it('retargets a pick inside the list to the item scope of its table', async () => {
    const t = await products();
    await t.send({ kind: 'draft.addTable', name: 'page' });
    const price = byClass(t.page, 'product-price', 0);
    await t.pick(price);
    expect(t.controller.state.selected).toMatchObject({ scope: 'page', table: 1 });
    await t.send({ kind: 'selection.retarget', table: 0 });
    const selected = t.controller.state.selected!;
    expect(selected).toMatchObject({ scope: 'item', table: 0 });
    expect(selected.selection.containerPath).toEqual(cardPath(price));
    expect(selected.selection.candidates[0]).toMatchObject({ count: 24, items: 24 });
    await t.send({ kind: 'draft.addField', patch: { name: 'price', table: 0 } });
    expect(t.controller.draft.activeTable).toBe(0);
    expect(t.controller.draft.tables[0]!.fields.at(-1)).toMatchObject({ name: 'price', scope: 'item', count: 24 });
  });

  it('proposes a second list in a new table and leaves the first unchanged', async () => {
    const t = await products();
    const before = t.controller.draft.tables[0]!;
    await t.send({ kind: 'draft.addTable', name: 'questions' });
    await openList(t, byClass(t.page, 'questions-title', 0));
    const proposal = t.controller.state.proposal!;
    expect(proposal.proposed.label).toBe('article.mixed-questions');
    // The questions blocks' own class picks them out of the shared list.
    const own = proposal.proposed.selectors.findIndex((c) => c.value === 'article.mixed-questions');
    expect(proposal.proposed.selectors[own]!.count).toBe(6);
    await t.send({ kind: 'draft.setPrimary', level: 'item', index: own });
    await acceptList(t);
    const [productsTable, questions] = t.controller.draft.tables;
    expect(productsTable!.item!.selectors).toEqual(before.item!.selectors);
    expect(productsTable!.fields.map((f) => f.name)).toEqual(before.fields.map((f) => f.name));
    expect(questions!.item!.count).toBe(6);
    expect(questions!.fields).toEqual([expect.objectContaining({ scope: 'item', count: 6 })]);
  });

  it('reports every table in a test run', async () => {
    const t = await products();
    await t.send({ kind: 'draft.addTable', name: 'page' });
    await t.pick(byClass(t.page, 'category-heading'));
    await t.send({ kind: 'draft.addField', patch: { name: 'category' } });
    const reply = (await t.send({ kind: 'test.run' })) as HostMessage & { kind: 'test.results' };
    expect(reply.results.tables.map((x) => [x.name, x.rowCount])).toEqual([
      ['products', 24],
      ['page', 1],
    ]);
    expect(reply.results.tables[1]!.rows[0]).toMatchObject({ category: 'Electronics' });
  });

  it('saves two tables in strip order', async () => {
    const t = await products();
    await t.send({ kind: 'draft.addTable', name: 'page' });
    await t.pick(byClass(t.page, 'category-heading'));
    await t.send({ kind: 'draft.addField', patch: { name: 'category' } });
    const reply = (await t.send({ kind: 'save.request' })) as HostMessage & { kind: 'save.result' };
    expect(reply.ok).toBe(true);
    const saved = await t.storage.load('shop-catalog');
    expect(saved.fields).toBeUndefined();
    expect(saved.tables!.map((x) => x.name)).toEqual(['products', 'page']);
  });

  it('starts a re-pick of a field in the second table with that table active', () => {
    const recipe = loadRecipe({
      schemaVersion: 1,
      name: 'results',
      url: MIXED,
      tables: [
        { name: 'page', fields: [{ name: 'title', type: 'text', selectors: [css('h1')] }] },
        { name: 'questions', item: { selectors: [css('.mixed-questions')] }, fields: [{ name: 'title', type: 'text', selectors: [css('.gone')] }] },
      ],
    });
    const controller = new RecorderController({
      session: {} as never,
      storage: new MemoryStorage(),
      bundle: '',
      draft: draftFromRecipe(recipe),
      mode: { kind: 'repick', fieldIndex: 0, reason: 'run', table: 'questions' },
    });
    expect(controller.draft.activeTable).toBe(1);
    expect(controller.state.repickContext).toMatchObject({ table: 'questions', field: 'title', oldSelector: css('.gone') });
    expect(
      () => new RecorderController({ session: {} as never, storage: new MemoryStorage(), bundle: '', draft: draftFromRecipe(recipe), mode: { kind: 'repick', fieldIndex: 0, reason: 'run', table: 'nope' } }),
    ).toThrow(/no table named nope/);
  });
});
