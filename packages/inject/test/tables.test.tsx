// @vitest-environment jsdom
import { cleanup, fireEvent } from '@testing-library/react';
import { emptyDraft, validateDraft, type Draft, type DraftField, type DraftTable, type RecorderState, type TestResults } from '@webscoop/core';
import { afterEach, describe, expect, it } from 'vitest';
import { byClass, harness, type Harness } from '../../core/test/recorder-helpers';
import { tier0Snapshot } from '../../core/test/snapshot';
import { baseState, newDraft, renderPanel } from './panel';

afterEach(cleanup);

const MIXED = 'http://127.0.0.1:4777/catalog?mixed=1';
const css = (value: string) => ({ strategy: 'css' as const, value, stability: 'medium' as const });
const field = (name: string, extra: Partial<DraftField> = {}): DraftField => ({
  name,
  type: 'text',
  scope: 'page',
  selectors: [css(`.${name}`)],
  optional: false,
  key: false,
  count: 1,
  sample: name,
  ...extra,
});
const item = { selectors: [css('.card')], exclude: [], count: 24, total: 24 };

/** A validated draft with tables `products` (24 containers) and `page`, and `active` active. */
function twoTables(active = 0, tables?: Partial<DraftTable>[]): Draft {
  const list = (tables ?? [
    { name: 'products', item, fields: [field('title', { scope: 'item', count: 24 }), field('price', { scope: 'item', count: 24 })] },
    { name: 'page', fields: [field('heading')] },
  ]).map((t) => ({ name: 'items', item: null, fields: [], ...t }));
  return validateDraft({ ...newDraft(), tables: list, activeTable: active, form: 'tables' });
}

describe('table strip', () => {
  it('lists every table with its row count and marks the active one', () => {
    const p = renderPanel(baseState(twoTables()));
    const tabs = p.qa('table-tab');
    expect(tabs.map((t) => [t.dataset.table, t.getAttribute('aria-selected'), t.querySelector('[data-ws="table-count"]')?.textContent])).toEqual([
      ['products', 'true', '24'],
      ['page', 'false', '1'],
    ]);
    // The active table is expanded; the other is collapsed to its fields.
    expect(p.qa('field').map((f) => f.dataset.name)).toEqual(['title', 'price']);
    expect(p.qa('table-card').map((c) => c.dataset.table)).toEqual(['page']);
    expect(p.qa('collapsed-field').map((f) => f.dataset.name)).toEqual(['heading']);
  });

  it('adds a table', () => {
    const p = renderPanel(baseState(twoTables()));
    fireEvent.click(p.q('table-add')!);
    expect(p.sent).toEqual([{ kind: 'draft.addTable' }]);
  });

  it('shows a rename error and keeps the name', () => {
    const p = renderPanel(baseState(twoTables(1)));
    const name = p.q('table-name') as HTMLInputElement;
    expect(name.value).toBe('page');
    fireEvent.change(name, { target: { value: 'products' } });
    fireEvent.blur(name);
    expect(p.q('table-name-error')!.textContent).toMatch(/a table named products already exists/);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(name, { target: { value: 'Bad Name' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(p.q('table-name-error')!.textContent).toMatch(/kebab-case/);
    expect(p.sent).toEqual([]);
    fireEvent.change(name, { target: { value: 'header' } });
    fireEvent.blur(name);
    expect(p.q('table-name-error')).toBeNull();
    expect(p.sent).toEqual([{ kind: 'draft.renameTable', name: 'header' }]);
  });

  it('removes the active table, but offers no removal for the last one', () => {
    const p = renderPanel(baseState(twoTables(1)));
    fireEvent.click(p.q('table-remove')!);
    expect(p.sent).toEqual([{ kind: 'draft.removeTable' }]);
    cleanup();
    expect(renderPanel(baseState(newDraft())).q('table-remove')).toBeNull();
  });

  it('activates a table from its tab and its collapsed card', () => {
    const p = renderPanel(baseState(twoTables()));
    fireEvent.click(p.qa('table-tab')[1]!);
    fireEvent.click(p.q('table-card')!);
    fireEvent.click(p.qa('table-tab')[0]!);
    expect(p.sent).toEqual([
      { kind: 'draft.selectTable', index: 1 },
      { kind: 'draft.selectTable', index: 1 },
    ]);
  });

  it('activates a table and opens the field by clicking a field of another table', () => {
    const p = renderPanel(baseState(twoTables(1)));
    const title = p.qa('collapsed-field').find((f) => f.dataset.name === 'title')!;
    fireEvent.click(title);
    expect(p.sent).toEqual([{ kind: 'draft.editField', index: 0, table: 0 }]);
  });
});

describe('table errors', () => {
  it('shows a table level error on the tab', () => {
    const draft = twoTables(0, [{ name: 'products', item, fields: [field('title')] }, { name: 'questions' }]);
    expect(draft.tables[1]!.error).toMatch(/at least one field/);
    const p = renderPanel(baseState(draft));
    const tab = p.qa('table-tab').find((t) => t.dataset.table === 'questions')!;
    expect(tab.querySelector('[data-ws="table-error"]')).not.toBeNull();
    expect(tab.title).toMatch(/at least one field/);
    expect(p.qa('table-tab')[0]!.querySelector('[data-ws="table-error"]')).toBeNull();
  });

  it('shows field errors in their own table', () => {
    const tables = [
      { name: 'page', fields: [field('title', { selectors: [css('h1')] })] },
      { name: 'products', item, fields: [field('title', { scope: 'item' as const }), field('title', { scope: 'item' as const, selectors: [css('h3')] })] },
    ];
    const inactive = renderPanel(baseState(twoTables(0, tables)));
    expect(inactive.qa('field-error')).toHaveLength(0);
    const bad = inactive.qa('collapsed-field').filter((f) => f.className.includes('ws-invalid'));
    expect(bad).toHaveLength(1);
    expect(bad[0]!.title).toMatch(/duplicate field name "title"/);
    cleanup();
    const active = renderPanel(baseState(twoTables(1, tables)));
    const errors = active.qa('field').map((f) => f.querySelector('[data-ws="field-error"]')?.textContent ?? null);
    expect(errors[0]).toBeNull();
    expect(errors[1]).toMatch(/duplicate field name "title"/);
    expect(active.qa('collapsed-field').filter((f) => f.className.includes('ws-invalid'))).toHaveLength(0);
  });
});

/** Products confirmed on the mixed catalog, a `page` table added, `products` active again, and the heading picked. */
async function headingPicked(): Promise<{ t: Harness; state: RecorderState }> {
  const t = await harness(tier0Snapshot({ mixed: true }), emptyDraft({ name: 'shop-catalog', url: MIXED, vars: [] }), MIXED);
  await t.pick(byClass(t.page, 'product-title', 0));
  await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
  await t.send({ kind: 'draft.renameTable', name: 'products' });
  await t.send({ kind: 'draft.addTable', name: 'page' });
  await t.send({ kind: 'draft.selectTable', index: 0 });
  await t.pick(byClass(t.page, 'category-heading'));
  return { t, state: t.controller.state };
}

describe('table select in the field form', () => {
  it('defaults to the page table, retargets on change, and sends the table on add', async () => {
    const { t, state } = await headingPicked();
    const p = renderPanel(state);
    const select = p.q('form-table') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['products', 'page', 'New table…']);
    expect(select.value).toBe('1');
    expect((p.q('form-scope') as HTMLSelectElement).value).toBe('page');
    fireEvent.change(select, { target: { value: '0' } });
    expect(p.sent.at(-1)).toEqual({ kind: 'selection.retarget', table: 0 });
    fireEvent.click(p.q('add-field')!);
    expect(p.sent.at(-1)).toMatchObject({ kind: 'draft.addField', patch: { table: 1, scope: 'page' } });

    // A new table: the host computes the selection for no table, and the form names it inline.
    await t.send({ kind: 'selection.retarget', table: null });
    cleanup();
    const q = renderPanel(t.controller.state);
    expect((q.q('form-table') as HTMLSelectElement).value).toBe('new');
    const name = q.q('form-table-name') as HTMLInputElement;
    expect(name.value).toBe('table-3');
    fireEvent.change(name, { target: { value: 'products' } });
    expect(q.q('form-table-error')!.textContent).toMatch(/already exists/);
    expect((q.q('add-field') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'header' } });
    fireEvent.click(q.q('add-field')!);
    expect(q.sent.at(-1)).toMatchObject({ kind: 'draft.addField', patch: { table: { new: 'header' } } });
  });
});

describe('results drawer', () => {
  const results: TestResults = {
    tables: [
      { name: 'products', rows: Array.from({ length: 22 }, (_, i) => ({ _page: 1, _index: i, title: `t${i}` })), rowCount: 22, dropped: { count: 2, fields: ['url'] }, fields: [{ name: 'title', status: 'ok' }] },
      { name: 'page', rows: [{ _page: 1, _index: 0, heading: 'Electronics' }], rowCount: 1, dropped: { count: 0, fields: [] }, fields: [{ name: 'heading', status: 'ok' }] },
    ],
    durationMs: 4,
    warnings: [],
  };

  it('shows one tab per table, opened on the active table', () => {
    const p = renderPanel({ ...baseState(twoTables(1)), test: results }, { drawerOpen: true });
    expect(p.qa('result-tab').map((t) => [t.dataset.table, t.getAttribute('aria-selected'), t.textContent])).toEqual([
      ['products', 'false', 'products · 22'],
      ['page', 'true', 'page · 1'],
    ]);
    expect(p.q('test-rows')!.textContent).toBe('1 row');
    expect(p.q('test-dropped')).toBeNull();
    expect(p.qa('result-row')).toHaveLength(1);
    fireEvent.click(p.qa('result-tab')[0]!);
    expect(p.q('test-rows')!.textContent).toBe('22 rows');
    expect(p.q('test-dropped')!.textContent).toBe('2 rows dropped: url');
    expect(p.qa('result-row')).toHaveLength(22);
    expect(p.qa('field-status-item').map((f) => f.dataset.field)).toEqual(['title']);
  });

  it('shows no tabs for a single table', () => {
    const p = renderPanel({ ...baseState(), test: { ...results, tables: [results.tables[0]!] } }, { drawerOpen: true });
    expect(p.q('result-tabs')).toBeNull();
    expect(p.q('test-rows')!.textContent).toBe('22 rows');
  });
});
