// @vitest-environment jsdom
import { act, cleanup, fireEvent } from '@testing-library/react';
import { emptyDraft, validateDraft, type Draft, type DraftField, type DraftTable, type RecorderState, type TestResults } from '@webscoop/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byClass, harness, type Harness } from '../../core/test/recorder-helpers';
import { tier0Snapshot } from '../../core/test/snapshot';
import { clippedTabs, dropIndex } from '../src/ui/tables';
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

/** Lists `results`, `ads`, and `summary`, each with containers, and `active` active. */
function threeLists(active = 0): Draft {
  return twoTables(active, [
    { name: 'results', item, fields: [field('title', { scope: 'item', count: 24 })] },
    { name: 'ads', item, fields: [field('ad', { scope: 'item', count: 24 })] },
    { name: 'summary', item, fields: [field('text', { scope: 'item', count: 24 })] },
  ]);
}

describe('table tab bar', () => {
  it('lists every table with its kind, row count, and the active one, and shows only the active table', () => {
    const p = renderPanel(baseState(twoTables()));
    const tabs = p.qa('table-tab');
    expect(tabs.map((t) => [t.dataset.table, t.getAttribute('aria-selected'), t.querySelector('[data-ws="table-count"]')?.textContent, t.querySelector('svg')!.dataset.icon])).toEqual([
      ['products', 'true', '24', 'rows'],
      ['page', 'false', '1', 'rectangle'],
    ]);
    expect(p.qa('field').map((f) => f.dataset.name)).toEqual(['title', 'price']);
    expect(p.q('table-card')).toBeNull();
    expect(p.q('table-kind')!.textContent).toBe('list · 24 rows');
    cleanup();
    expect(renderPanel(baseState(twoTables(1))).q('table-kind')!.textContent).toBe('page table · one row');
  });

  it('adds a table from the pinned + tab', () => {
    const p = renderPanel(baseState(twoTables()));
    expect(p.q('tables')!.contains(p.q('table-add'))).toBe(false);
    fireEvent.click(p.q('table-add')!);
    expect(p.sent).toEqual([{ kind: 'draft.addTable' }]);
  });

  it('activates a table from its tab', () => {
    const p = renderPanel(baseState(twoTables()));
    fireEvent.click(p.qa('table-tab')[1]!);
    fireEvent.click(p.qa('table-tab')[0]!);
    expect(p.sent).toEqual([{ kind: 'draft.selectTable', index: 1 }]);
  });

  it('renames on double-click and refuses a duplicate or non kebab-case name', () => {
    const p = renderPanel(baseState(twoTables(1)));
    fireEvent.doubleClick(p.qa('table-tab')[1]!);
    const name = p.q('table-name') as HTMLInputElement;
    expect(name.value).toBe('page');
    fireEvent.change(name, { target: { value: 'products' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(p.q('table-name-error')!.textContent).toMatch(/a table named products already exists/);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(name, { target: { value: 'Bad Name' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(p.q('table-name-error')!.textContent).toMatch(/kebab-case/);
    expect(p.sent).toEqual([]);
    fireEvent.change(name, { target: { value: 'header' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(p.q('table-name-error')).toBeNull();
    expect(p.q('table-name')).toBeNull();
    expect(p.sent).toEqual([{ kind: 'draft.renameTable', name: 'header' }]);
  });

  it('renames the focused tab with F2, and Esc cancels', () => {
    const p = renderPanel(baseState(twoTables(0)));
    fireEvent.focus(p.qa('table-tab')[0]!);
    fireEvent.keyDown(p.qa('table-tab')[0]!, { key: 'F2' });
    const name = p.q('table-name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'sponsored' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(p.sent).toEqual([{ kind: 'draft.renameTable', name: 'sponsored' }]);
    fireEvent.keyDown(p.qa('table-tab')[0]!, { key: 'F2' });
    fireEvent.keyDown(p.q('table-name')!, { key: 'Escape' });
    expect(p.q('table-name')).toBeNull();
    expect(p.sent).toHaveLength(1);
  });

  it('moves the focused tab with Alt+Left and Alt+Right', () => {
    const p = renderPanel(baseState(threeLists()));
    fireEvent.focus(p.qa('table-tab')[1]!);
    fireEvent.keyDown(p.qa('table-tab')[1]!, { key: 'ArrowLeft', altKey: true });
    expect(p.sent).toEqual([{ kind: 'draft.moveTable', from: 1, to: 0 }]);
    expect(p.store.get().ui.focusedTab).toBe(0);
    fireEvent.keyDown(p.qa('table-tab')[0]!, { key: 'ArrowLeft', altKey: true });
    expect(p.sent).toHaveLength(1);
    fireEvent.keyDown(p.qa('table-tab')[0]!, { key: 'ArrowRight', altKey: true });
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.moveTable', from: 0, to: 1 });
  });

  it('reorders by dragging a tab before another, and the + tab is no drop target', () => {
    const p = renderPanel(baseState(threeLists()));
    const tabs = p.qa('table-tab');
    fireEvent.dragStart(tabs[2]!, { dataTransfer: { setData: () => {}, getData: () => '2' } });
    fireEvent.dragOver(tabs[0]!, { clientX: 0 });
    expect(tabs[0]!.className).toContain('ws-tab-drop');
    fireEvent.drop(tabs[0]!, { dataTransfer: { getData: () => '2' } });
    expect(p.sent).toEqual([{ kind: 'draft.moveTable', from: 2, to: 0 }]);
    expect(p.q('table-add')!.getAttribute('draggable')).toBeNull();
    expect(dropIndex(0, 3)).toBe(2);
    expect(dropIndex(2, 0)).toBe(0);
  });

  it('locks switching and moving tabs while the item proposal is being edited', async () => {
    const { t } = await headingPicked();
    await t.send({ kind: 'draft.selectTable', index: 0 });
    await t.send({ kind: 'draft.editItem' });
    const p = renderPanel(t.controller.state);
    expect(p.qa('table-tab').map((x) => (x as HTMLButtonElement).disabled)).toEqual([false, true]);
    expect((p.q('table-add') as HTMLButtonElement).disabled).toBe(true);
    expect((p.q('tab-menu') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.focus(p.qa('table-tab')[0]!);
    fireEvent.keyDown(p.qa('table-tab')[0]!, { key: 'ArrowRight', altKey: true });
    expect(p.sent).toEqual([]);
  });

  it('offers Rename, Move, Use for pagination, and Remove in the table menu', () => {
    const p = renderPanel(baseState(threeLists(1)));
    fireEvent.click(p.q('tab-menu')!);
    const item = (ws: string) => p.q(ws) as HTMLButtonElement;
    expect(p.qa('tab-menu-list')[0]!.textContent).toBe('RenameMove leftMove rightUse for paginationRemove table');
    expect(item('menu-move-left').disabled).toBe(false);
    expect(item('menu-pagination').disabled).toBe(false);
    fireEvent.click(item('menu-pagination'));
    expect(p.sent).toEqual([{ kind: 'draft.moveTable', from: 1, to: 0 }]);
    expect(p.q('tab-menu-list')).toBeNull();
    fireEvent.click(p.q('tab-menu')!);
    fireEvent.click(item('menu-move-right'));
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.moveTable', from: 1, to: 2 });
    fireEvent.click(p.q('tab-menu')!);
    fireEvent.click(item('table-remove'));
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.removeTable' });
    fireEvent.click(p.q('tab-menu')!);
    fireEvent.click(item('menu-rename'));
    expect((p.q('table-name') as HTMLInputElement).value).toBe('ads');
  });

  it('disables Use for pagination for a page table and for the primary table, and Remove for the last table', () => {
    const page = renderPanel(baseState(twoTables(1)));
    fireEvent.click(page.q('tab-menu')!);
    expect((page.q('menu-pagination') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const primary = renderPanel(baseState(threeLists(0)));
    fireEvent.click(primary.q('tab-menu')!);
    expect((primary.q('menu-pagination') as HTMLButtonElement).disabled).toBe(true);
    expect((primary.q('menu-move-left') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const single = renderPanel(baseState(newDraft()));
    fireEvent.click(single.q('tab-menu')!);
    expect(single.q('table-remove')).toBeNull();
    fireEvent.keyDown(single.q('body')!, { key: 'Escape' });
    expect(single.q('tab-menu-list')).toBeNull();
  });

  it('marks the primary table as driving pagination only when pagination is on', () => {
    const on = renderPanel(baseState({ ...threeLists(), pagination: { kind: 'next', limit: 3, stopRules: [], delayMs: 0 } }));
    expect(on.qa('table-tab').map((t) => Boolean(t.querySelector('[data-ws="drives-pagination"]')))).toEqual([true, false, false]);
    cleanup();
    const none = renderPanel(baseState({ ...threeLists(), pagination: { kind: 'none', limit: 1, stopRules: [], delayMs: 0 } }));
    expect(none.q('drives-pagination')).toBeNull();
    cleanup();
    expect(renderPanel(baseState(threeLists())).q('drives-pagination')).toBeNull();
  });

  it('says which table now drives pagination after a reorder changes it, without undo', () => {
    const draft = { ...threeLists(), pagination: { kind: 'next' as const, limit: 3, stopRules: [], delayMs: 0 } };
    const p = renderPanel(baseState(draft));
    const [results, ads, summary] = draft.tables;
    act(() => p.store.setHost(baseState({ ...draft, tables: [ads!, results!, summary!] })));
    expect(p.toasts).toEqual(['ads now drives pagination']);
    act(() => p.store.setHost(baseState({ ...draft, tables: [ads!, summary!, results!] })));
    expect(p.toasts).toHaveLength(1);
  });

  it('lists the tabs the strip clips in a "N more" menu that activates the one chosen', () => {
    const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 28, width: right - left, height: 28, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.ws === 'tables') return rect(0, 200);
      const i = Array.from(this.parentElement?.children ?? []).indexOf(this);
      return rect(i * 90, i * 90 + 85);
    });
    try {
      const p = renderPanel(baseState(threeLists()));
      expect(p.q('tabs-more')!.textContent).toBe('1 more');
      fireEvent.click(p.q('tabs-more')!);
      expect(p.qa('tabs-more-item').map((i) => i.dataset.table)).toEqual(['summary']);
      fireEvent.click(p.q('tabs-more-item')!);
      expect(p.sent).toEqual([{ kind: 'draft.selectTable', index: 2 }]);
    } finally {
      spy.mockRestore();
    }
    expect(clippedTabs({ left: 0, right: 100 }, [{ left: 0, right: 50 }, { left: 50, right: 120 }, { left: -10, right: 20 }])).toEqual([1, 2]);
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

  it('shows field errors in their own table only', () => {
    const tables = [
      { name: 'page', fields: [field('title', { selectors: [css('h1')] })] },
      { name: 'products', item, fields: [field('title', { scope: 'item' as const }), field('title', { scope: 'item' as const, selectors: [css('h3')] })] },
    ];
    const inactive = renderPanel(baseState(twoTables(0, tables)));
    expect(inactive.qa('field-error')).toHaveLength(0);
    expect(inactive.qa('table-tab')[1]!.querySelector('[data-ws="table-error"]')).not.toBeNull();
    cleanup();
    const active = renderPanel(baseState(twoTables(1, tables)));
    const errors = active.qa('field').map((f) => f.querySelector('[data-ws="field-error"]')?.textContent ?? null);
    expect(errors[0]).toBeNull();
    expect(errors[1]).toMatch(/duplicate field name "title"/);
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

describe('pick section in the active tab', () => {
  it('moves a pick outside the list to the page tab, says so, and offers no table choice', async () => {
    const { state } = await headingPicked();
    expect(state.draft.activeTable).toBe(1);
    const p = renderPanel(state);
    expect(p.q('table-content')!.dataset.table).toBe('page');
    expect(p.q('moved-notice')!.textContent).toBe('Moved to page: outside the products list');
    expect(p.q('section-pick')!.contains(p.q('inspector'))).toBe(true);
    expect(p.q('form-table')).toBeNull();
    expect((p.q('form-scope') as HTMLSelectElement).value).toBe('page');
    fireEvent.click(p.q('add-field')!);
    expect(p.sent.at(-1)).toMatchObject({ kind: 'draft.addField', patch: { table: 1, scope: 'page' } });
  });

  it('keeps the selection when another tab or the + tab is chosen', async () => {
    const { t } = await headingPicked();
    await t.send({ kind: 'draft.selectTable', index: 0 });
    expect(t.controller.state.selected).toMatchObject({ table: 0, scope: 'page' });
    const p = renderPanel(t.controller.state);
    expect(p.q('inspector')).not.toBeNull();
    expect(p.q('moved-notice')).toBeNull();
    fireEvent.click(p.q('table-add')!);
    expect(p.sent).toEqual([{ kind: 'draft.addTable' }]);
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
