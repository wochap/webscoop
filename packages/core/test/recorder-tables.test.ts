import { describe, expect, it } from 'vitest';
import {
  currentTable,
  defaultTableName,
  draftErrors,
  draftFromRecipe,
  draftToRecipe,
  emptyDraft,
  loadRecipe,
  parseHostMessage,
  parsePageMessage,
  RecorderController,
  reduceDraft,
  validateRecipe,
  type Draft,
  type DraftField,
  type HostMessage,
  type NewField,
  type RecipeInput,
} from '../src';
import { byClass, cardPath, draftWith, harness, MemoryStorage, referenceRecipe, type Harness } from './recorder-helpers';
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
    let draft = reduceDraft(newDraft(), { type: 'addField', field: field('title') });
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
    let draft = reduceDraft(newDraft(), { type: 'addField', field: field('title') });
    expect(draftToRecipe(draft).tables).toBeUndefined();
    draft = reduceDraft(draft, { type: 'renameTable', name: 'products' });
    const out = draftToRecipe(draft);
    expect(out.fields).toBeUndefined();
    expect(out.tables!.map((t) => t.name)).toEqual(['products']);
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
  await t.pick(title);
  await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
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
    // No table without containers: the active table stays the default, with page scope.
    expect(t.controller.state.selected).toMatchObject({ scope: 'page', defaults: { table: 0 } });
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

  it('defaults a pick outside the list to the page table and retargets it', async () => {
    const t = await products();
    await t.send({ kind: 'draft.addTable', name: 'page' });
    await t.send({ kind: 'draft.selectTable', index: 0 });
    await t.pick(byClass(t.page, 'category-heading'));
    const selected = t.controller.state.selected!;
    expect(selected).toMatchObject({ scope: 'page', table: 1, defaults: { table: 1 } });
    await t.send({ kind: 'selection.retarget', table: 0 });
    const retargeted = t.controller.state.selected!;
    expect(retargeted).toMatchObject({ scope: 'page', table: 0 });
    expect(retargeted.selection.containerPath).toBeNull();
    expect(retargeted.selection.candidates[0]!.count).toBe(1);
    expect(retargeted.selection.candidates.every((c) => c.items === undefined)).toBe(true);
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
    await t.pick(byClass(t.page, 'questions-title', 0));
    const proposal = t.controller.state.proposal!;
    expect(proposal.proposed.label).toBe('article.mixed-questions');
    // The questions blocks' own class picks them out of the shared list.
    const own = proposal.proposed.selectors.findIndex((c) => c.value === 'article.mixed-questions');
    expect(proposal.proposed.selectors[own]!.count).toBe(6);
    await t.send({ kind: 'draft.setPrimary', level: 'item', index: own });
    await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
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
