import { dataset } from '@webscoop/playground';
import { describe, expect, it } from 'vitest';
import { detach, draftFromRecipe, draftToRecipe, emptyDraft, nodeAt, reduceDraft, tablesOf, validateRecipe, type Draft } from '../src';
import { h } from '../src/testing';
import { byClass, cardPath, harness, referenceRecipe, type Harness } from './recorder-helpers';
import { tier0Snapshot } from './snapshot';

function newDraft(): Draft {
  return emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?tier={tier}', vars: [{ name: 'tier', value: '0' }] });
}

/** A catalog with the item container confirmed and the title added as a field. */
async function withItems(): Promise<Harness> {
  const t = await harness(tier0Snapshot(), newDraft());
  await t.pick(byClass(t.page, 'product-title', 0));
  await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
  return t;
}

/** Play the page answering `pendingSelect`: select the element at the asked path. */
async function answerPending(t: Harness): Promise<void> {
  const pending = t.controller.state.pendingSelect;
  if (!pending) throw new Error('no pending select');
  const node = nodeAt(t.page, pending.path)!;
  const inCard = t.controller.draft.tables[0]!.item ? cardPathOrNull(node) : null;
  await t.pick(node, inCard);
}

function cardPathOrNull(node: Parameters<typeof cardPath>[0]): number[] | null {
  for (let cur: typeof node | null | undefined = node; cur; cur = cur.parent) if (cur.attrs['data-testid'] === 'product-card') return cardPath(node);
  return null;
}

const snapshotOf = (t: Harness) => detach(t.page);

describe('draft replaceField', () => {
  it('keeps the position and recomputes name uniqueness errors', () => {
    const selectors = [{ strategy: 'css' as const, value: '.a', stability: 'medium' as const }];
    let draft = newDraft();
    for (const name of ['title', 'price', 'rating']) draft = reduceDraft(draft, { type: 'addField', field: { name, type: 'text', scope: 'page', selectors } });
    const replaced = reduceDraft(draft, {
      type: 'replaceField',
      index: 1,
      field: { name: 'title', type: 'number', scope: 'page', selectors: [{ strategy: 'css', value: '.b', stability: 'medium' }], optional: true },
    });
    expect(replaced.tables[0]!.fields.map((f) => f.name)).toEqual(['title', 'title', 'rating']);
    expect(replaced.tables[0]!.fields[1]).toMatchObject({ type: 'number', optional: true, selectors: [{ value: '.b' }] });
    expect(replaced.tables[0]!.fields[1]!.error).toMatch(/title/);
    const fixed = reduceDraft(replaced, { type: 'replaceField', index: 1, field: { name: 'amount', type: 'number', scope: 'page', selectors } });
    expect(fixed.tables[0]!.fields.map((f) => f.name)).toEqual(['title', 'amount', 'rating']);
    expect(fixed.tables[0]!.fields.every((f) => f.error === undefined)).toBe(true);
  });
});

describe('clearing the selection', () => {
  it('drops the pick and its proposal and leaves the draft unchanged', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    await t.pick(byClass(t.page, 'product-title', 0));
    expect(t.controller.state.proposal).not.toBeNull();
    const draft = t.controller.draft;
    await t.send({ kind: 'selection.clear' });
    expect(t.controller.state).toMatchObject({ selected: null, proposal: null, levelPick: null, editing: null, pendingSelect: null });
    expect(t.controller.draft).toBe(draft);
    // Nothing is left to confirm.
    await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
    expect(t.controller.draft.tables[0]!.item).toBeNull();
  });

  it('returns to the empty state after adding a field, also from confirming items', async () => {
    const t = await withItems();
    expect(t.controller.draft.tables[0]!.fields).toHaveLength(1);
    expect(t.controller.state.selected).toBeNull();
    const price = byClass(t.page, 'product-price', 0);
    await t.pick(price, cardPath(price));
    await t.send({ kind: 'draft.addField', patch: { name: 'amount', type: 'number', scope: 'item', attr: null, optional: true, key: false } });
    expect(t.controller.state.selected).toBeNull();
    expect(t.controller.draft.tables[0]!.fields[1]).toMatchObject({ name: 'amount', type: 'number', optional: true, key: false, count: 24 });
  });
});

describe('typed selection selector', () => {
  it('selects the first match of a typed item selector with no prior selection', async () => {
    const t = await withItems();
    await t.send({ kind: 'selection.setSelector', selector: 'css=h2', snapshot: snapshotOf(t) });
    const pending = t.controller.state.pendingSelect!;
    expect(nodeAt(t.page, pending.path)).toBe(byClass(t.page, 'product-title', 0));
    await answerPending(t);
    const selected = t.controller.state.selected!;
    expect(selected.scope).toBe('item');
    expect(selected.primary).toBe(0);
    expect(selected.selection.candidates[0]).toMatchObject({ strategy: 'css', value: 'h2', count: 24, items: 24 });
    expect(t.controller.state.pendingSelect).toBeNull();
    expect(t.controller.state.proposal).toBeNull();
    await t.send({ kind: 'draft.addField', patch: { name: 'heading' } });
    expect(t.controller.draft.tables[0]!.fields[1]).toMatchObject({ name: 'heading', scope: 'item', count: 24, sample: dataset[0]!.title });
    expect(t.controller.draft.tables[0]!.fields[1]!.selectors[0]).toMatchObject({ strategy: 'css', value: 'h2' });
  });

  it('reports the covered containers for a partial match, 7 of 10', async () => {
    const card = (i: number) => h('li', { class: 'card' }, h('h3', {}, `Card ${i}`), ...(i < 7 ? [h('span', { class: 'badge' }, 'new')] : []));
    const dom = h('html', {}, h('body', {}, h('ul', { class: 'cards' }, ...Array.from({ length: 10 }, (_, i) => card(i)))));
    const url = 'http://127.0.0.1:4777/cards';
    const t = await harness(dom, emptyDraft({ name: 'cards', url, vars: [] }), url);
    await t.pick(byClass(t.page, 'card', 0));
    await t.send({ kind: 'draft.setItem' });
    await t.send({ kind: 'selection.clear' });
    expect(t.controller.draft.tables[0]!.item!.count).toBe(10);
    await t.send({ kind: 'selection.setSelector', selector: 'css=.badge', snapshot: snapshotOf(t) });
    const pending = t.controller.state.pendingSelect!;
    await t.pick(nodeAt(t.page, pending.path)!, [1, 0, 0]);
    expect(t.controller.state.selected!.selection.candidates[0]).toMatchObject({ value: '.badge', count: 7, items: 7 });
    await t.send({ kind: 'draft.addField', patch: { name: 'badge', optional: true } });
    expect(t.controller.draft.tables[0]!.fields[0]).toMatchObject({ name: 'badge', scope: 'item', optional: true, count: 7 });
  });

  it('refuses text that matches nothing or is invalid and keeps the previous selection', async () => {
    const t = await withItems();
    const price = byClass(t.page, 'product-price', 2);
    await t.pick(price, cardPath(price));
    const before = t.controller.state.selected;
    await t.send({ kind: 'selection.setSelector', selector: 'css=.no-such-class', snapshot: snapshotOf(t) });
    expect(t.controller.state.selectorError).toMatch(/matches nothing/);
    expect(t.controller.state.selected).toBe(before);
    expect(t.controller.state.pendingSelect).toBeNull();
    await t.send({ kind: 'selection.setSelector', selector: '   ' });
    expect(t.controller.state.selectorError).toBe('type a selector');
    expect(t.controller.state.selected).toBe(before);
  });

  it('resolves against the page for page scope', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    await t.send({ kind: 'selection.setSelector', selector: 'css=h1', snapshot: snapshotOf(t) });
    await answerPending(t);
    expect(t.controller.state.selected).toMatchObject({ scope: 'page', primary: 0 });
    expect(t.controller.state.selected!.selection.candidates[0]).toMatchObject({ strategy: 'css', value: 'h1', count: 1 });
    expect(t.controller.state.selected!.selection.candidates[0]!.items).toBeUndefined();
  });
});

describe('editing a saved field', () => {
  async function withPrice(): Promise<Harness> {
    const t = await withItems();
    const price = byClass(t.page, 'product-price', 0);
    await t.pick(price, cardPath(price));
    await t.send({ kind: 'draft.addField', patch: { name: 'price', type: 'number', optional: true } });
    return t;
  }

  it('opens the field with its options, saved candidates, and element', async () => {
    const t = await withPrice();
    const field = t.controller.draft.tables[0]!.fields[1]!;
    await t.send({ kind: 'draft.editField', index: 1, snapshot: snapshotOf(t) });
    const { editing, pendingSelect } = t.controller.state;
    expect(editing).toMatchObject({ index: 1, options: { name: 'price', type: 'number', scope: 'item', optional: true, key: false }, primary: 0 });
    expect(editing!.candidates.map((c) => c.value)).toEqual(field.selectors.map((c) => c.value));
    expect(editing!.candidates[0]).toMatchObject({ count: 24, items: 24 });
    expect(nodeAt(t.page, pendingSelect!.path)).toBe(byClass(t.page, 'product-price', 0));
    await answerPending(t);
    const selected = t.controller.state.selected!;
    expect(selected.primary).toBe(0);
    expect(selected.selection.candidates.slice(0, field.selectors.length).map((c) => c.value)).toEqual(field.selectors.map((c) => c.value));
    expect(t.controller.state.editing).not.toBeNull();
    expect(t.controller.state.proposal).toBeNull();
  });

  it('changes the primary and updates the field in place', async () => {
    const t = await withPrice();
    await t.send({ kind: 'draft.editField', index: 1, snapshot: snapshotOf(t) });
    await answerPending(t);
    const candidates = t.controller.state.selected!.selection.candidates;
    const css = candidates.findIndex((c) => c.strategy === 'css' && (c.count ?? 0) > 0);
    expect(css).toBeGreaterThan(0);
    await t.send({ kind: 'inspect.primary', index: css });
    await t.send({ kind: 'draft.updateEditedField', patch: { name: 'price', type: 'number', scope: 'item', attr: null, optional: true, key: false } });
    const fields = t.controller.draft.tables[0]!.fields;
    expect(fields.map((f) => f.name)).toEqual(['wireless_mouse', 'price']);
    expect(fields[1]!.selectors[0]).toMatchObject({ strategy: 'css', value: candidates[css]!.value });
    expect(fields[1]).toMatchObject({ count: 24, sample: String(dataset[0]!.price) });
    expect(t.controller.state).toMatchObject({ editing: null, selected: null });
  });

  it('re-picks while editing and keeps the name and options', async () => {
    const t = await withPrice();
    await t.send({ kind: 'draft.editField', index: 0, snapshot: snapshotOf(t) });
    await answerPending(t);
    const rating = byClass(t.page, 'product-rating', 0);
    await t.pick(rating, cardPath(rating));
    expect(t.controller.state.editing).toMatchObject({ index: 0 });
    expect(t.controller.state.proposal).toBeNull();
    await t.send({ kind: 'draft.updateEditedField', patch: { name: 'wireless_mouse', type: 'text', scope: 'item', attr: null, optional: false, key: false } });
    const fields = t.controller.draft.tables[0]!.fields;
    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatchObject({ name: 'wireless_mouse', type: 'text', sample: String(dataset[0]!.rating) });
    expect(fields[0]!.fingerprint!.textSample).toBe(String(dataset[0]!.rating));
  });

  it('cancels an edit without changing the field', async () => {
    const t = await withPrice();
    const draft = t.controller.draft;
    await t.send({ kind: 'draft.editField', index: 0, snapshot: snapshotOf(t) });
    await answerPending(t);
    await t.send({ kind: 'draft.cancelEdit' });
    expect(t.controller.draft).toBe(draft);
    expect(t.controller.state).toMatchObject({ editing: null, selected: null, pendingSelect: null });
  });

  it('refuses other selection actions while editing', async () => {
    const t = await withPrice();
    await t.send({ kind: 'draft.editField', index: 0, snapshot: snapshotOf(t) });
    await answerPending(t);
    await t.send({ kind: 'draft.addField' });
    expect(t.controller.state.error).toMatch(/finish editing/);
    expect(t.controller.draft.tables[0]!.fields).toHaveLength(2);
  });

  it('shows a field that matches nothing with zero counts and no element', async () => {
    const t = await withPrice();
    await t.send({ kind: 'draft.updateField', index: 1, patch: { name: 'price' } });
    const selectors = [{ strategy: 'css' as const, value: '.gone', stability: 'medium' as const }];
    t.controller['apply']({ type: 'replaceSelectors', index: 1, selectors, count: null, sample: null });
    await t.send({ kind: 'draft.editField', index: 1, snapshot: snapshotOf(t) });
    expect(t.controller.state).toMatchObject({ pendingSelect: null, selected: null });
    expect(t.controller.state.editing!.candidates).toEqual([{ ...selectors[0], count: 0, items: 0 }]);
    await t.send({ kind: 'draft.updateEditedField', patch: { name: 'price', type: 'text', optional: true } });
    expect(t.controller.draft.tables[0]!.fields[1]).toMatchObject({ name: 'price', type: 'text', selectors: [{ value: '.gone' }] });
  });
});

describe('editing a one entry tables recipe', () => {
  const recipe = () => {
    const { item, fields, ...rest } = referenceRecipe();
    return { ...rest, tables: [{ name: 'products', ...(item ? { item } : {}), fields: fields! }] };
  };

  it('loads like the shorthand and saves back in the tables form', () => {
    const tables = recipe();
    const draft = draftFromRecipe(tables);
    const shorthand = draftFromRecipe(referenceRecipe());
    expect(draft.form).toBe('tables');
    expect(shorthand.form).toBe('shorthand');
    expect(draft.tables.map((t) => t.name)).toEqual(['products']);
    const { form: _form, tables: t1, ...rest } = draft;
    const { form: _form2, tables: t2, ...restShorthand } = shorthand;
    expect(rest).toEqual(restShorthand);
    expect(t1[0]!.fields).toEqual(t2[0]!.fields);
    const validated = validateRecipe(draftToRecipe(draft));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const saved = validated.recipe;
    expect(saved.fields).toBeUndefined();
    expect(tablesOf(saved).map((t) => t.name)).toEqual(['products']);
    expect(tablesOf(saved)[0]!.fields.map((f) => f.name)).toEqual(tablesOf(tables)[0]!.fields.map((f) => f.name));
    const again = validateRecipe(draftToRecipe(shorthand));
    expect(again.ok && again.recipe.tables).toBeUndefined();
  });
});
