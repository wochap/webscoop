// @vitest-environment jsdom
import { act, cleanup, fireEvent } from '@testing-library/react';
import { emptyDraft, validateDraft, type Draft, type DraftField, type DraftTable, type RecorderState } from '@webscoop/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptList, byClass, harness, openList, type Harness } from '../../core/test/recorder-helpers';
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
    const tabs = p.qa('tab');
    expect(tabs.map((t) => [t.dataset.table, t.getAttribute('aria-selected'), t.querySelector('[data-ws="tab-count"]')?.textContent, t.querySelector('svg')!.dataset.icon])).toEqual([
      ['products', 'true', '24', 'rows'],
      ['page', 'false', '1', 'rectangle'],
    ]);
    expect(p.qa('field').map((f) => f.dataset.name)).toEqual(['title', 'price']);
    expect(p.q('table-kind')!.textContent).toBe('List · 24 rows');
    cleanup();
    expect(renderPanel(baseState(twoTables(1))).q('table-kind')!.textContent).toBe('Page · 1 row');
    cleanup();
    const empty = renderPanel(baseState(newDraft()));
    expect(empty.q('table-kind')!.textContent).toBe('No mode yet');
    expect(empty.q('table-kind')!.dataset.kind).toBe('none');
  });

  it('shows the mode icon of each tab: list, page, and neutral', () => {
    const p = renderPanel(baseState(twoTables(0, [{ name: 'results', item, fields: [field('title', { scope: 'item' })] }, { name: 'summary', fields: [field('total')] }, { name: 'table-3' }])));
    expect(p.qa('tab').map((t) => [t.dataset.table, t.querySelector<HTMLElement>('[data-ws="tab-mode-icon"]')!.dataset.mode, t.querySelector('svg')!.dataset.icon])).toEqual([
      ['results', 'list', 'rows'],
      ['summary', 'page', 'rectangle'],
      ['table-3', 'none', 'circle'],
    ]);
  });

  it('adds a table from the pinned + tab', () => {
    const p = renderPanel(baseState(twoTables()));
    expect(p.q('tabs')!.contains(p.q('tab-add'))).toBe(false);
    fireEvent.click(p.q('tab-add')!);
    expect(p.sent).toEqual([{ kind: 'draft.addTable' }]);
  });

  it('activates a table from its tab', () => {
    const p = renderPanel(baseState(twoTables()));
    fireEvent.click(p.qa('tab')[1]!);
    fireEvent.click(p.qa('tab')[0]!);
    expect(p.sent).toEqual([{ kind: 'draft.selectTable', index: 1 }]);
  });

  it('renames on double-click and refuses a duplicate or non kebab-case name', () => {
    const p = renderPanel(baseState(twoTables(1)));
    fireEvent.doubleClick(p.qa('tab')[1]!);
    const name = p.q('tab-rename') as HTMLInputElement;
    expect(name.value).toBe('page');
    fireEvent.change(name, { target: { value: 'products' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(p.q('tab-rename-error')!.textContent).toMatch(/a table named products already exists/);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(name, { target: { value: 'Bad Name' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(p.q('tab-rename-error')!.textContent).toMatch(/kebab-case/);
    expect(p.sent).toEqual([]);
    fireEvent.change(name, { target: { value: 'header' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(p.q('tab-rename-error')).toBeNull();
    expect(p.q('tab-rename')).toBeNull();
    expect(p.sent).toEqual([{ kind: 'draft.renameTable', name: 'header' }]);
  });

  it('renames the focused tab with F2, and Esc cancels', () => {
    const p = renderPanel(baseState(twoTables(0)));
    fireEvent.focus(p.qa('tab')[0]!);
    fireEvent.keyDown(p.qa('tab')[0]!, { key: 'F2' });
    const name = p.q('tab-rename') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'sponsored' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(p.sent).toEqual([{ kind: 'draft.renameTable', name: 'sponsored' }]);
    fireEvent.keyDown(p.qa('tab')[0]!, { key: 'F2' });
    fireEvent.keyDown(p.q('tab-rename')!, { key: 'Escape' });
    expect(p.q('tab-rename')).toBeNull();
    expect(p.sent).toHaveLength(1);
  });

  it('moves the focused tab with Alt+Left and Alt+Right', () => {
    const p = renderPanel(baseState(threeLists()));
    fireEvent.focus(p.qa('tab')[1]!);
    fireEvent.keyDown(p.qa('tab')[1]!, { key: 'ArrowLeft', altKey: true });
    expect(p.sent).toEqual([{ kind: 'draft.moveTable', from: 1, to: 0 }]);
    expect(p.store.get().ui.focusedTab).toBe(0);
    fireEvent.keyDown(p.qa('tab')[0]!, { key: 'ArrowLeft', altKey: true });
    expect(p.sent).toHaveLength(1);
    fireEvent.keyDown(p.qa('tab')[0]!, { key: 'ArrowRight', altKey: true });
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.moveTable', from: 0, to: 1 });
  });

  it('reorders by dragging a tab before another, and the + tab is no drop target', () => {
    const p = renderPanel(baseState(threeLists()));
    const tabs = p.qa('tab');
    fireEvent.dragStart(tabs[2]!, { dataTransfer: { setData: () => {}, getData: () => '2' } });
    fireEvent.dragOver(tabs[0]!, { clientX: 0 });
    expect(tabs[0]!.className).toContain('ws-tab-drop');
    fireEvent.drop(tabs[0]!, { dataTransfer: { getData: () => '2' } });
    expect(p.sent).toEqual([{ kind: 'draft.moveTable', from: 2, to: 0 }]);
    expect(p.q('tab-add')!.getAttribute('draggable')).toBeNull();
    expect(dropIndex(0, 3)).toBe(2);
    expect(dropIndex(2, 0)).toBe(0);
  });

  it('locks switching and moving tabs while the list setup is open', async () => {
    const { t } = await headingPicked();
    await t.send({ kind: 'draft.selectTable', index: 0 });
    await t.send({ kind: 'draft.editItem' });
    const p = renderPanel(t.controller.state);
    // The list setup takes over the content: the tabs and the table menu are gone until it closes.
    expect(p.qa('tab')).toHaveLength(0);
    expect(p.q('tab-add')).toBeNull();
    expect(p.q('table-menu')).toBeNull();
    expect(p.q('list-setup')).not.toBeNull();
    fireEvent.keyDown(p.q('panel-body')!, { key: 'ArrowRight', altKey: true });
    expect(p.sent).toEqual([]);
  });

  it('offers Rename, Move, Use for pagination, and Remove in the table menu', () => {
    const p = renderPanel(baseState(threeLists(1)));
    fireEvent.click(p.q('table-menu')!);
    const item = (ws: string) => p.q(ws) as HTMLButtonElement;
    expect(p.qa('table-menu-list')[0]!.textContent).toBe('Mode locked — list. Clear table to change.Renamedbl-click tabMove leftAlt ←Move rightAlt →Use for paginationClear tablefields + listRemove table');
    expect(item('table-menu-move-left').disabled).toBe(false);
    expect(item('table-menu-pagination').disabled).toBe(false);
    fireEvent.click(item('table-menu-pagination'));
    expect(p.sent).toEqual([{ kind: 'draft.moveTable', from: 1, to: 0 }]);
    expect(p.q('table-menu-list')).toBeNull();
    fireEvent.click(p.q('table-menu')!);
    fireEvent.click(item('table-menu-move-right'));
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.moveTable', from: 1, to: 2 });
    fireEvent.click(p.q('table-menu')!);
    fireEvent.click(item('table-menu-remove'));
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.removeTable' });
    fireEvent.click(p.q('table-menu')!);
    fireEvent.click(item('table-menu-clear-table'));
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.clearTable' });
    fireEvent.click(p.q('table-menu')!);
    fireEvent.click(item('table-menu-rename'));
    expect((p.q('tab-rename') as HTMLInputElement).value).toBe('ads');
  });

  it('shows the page mode lock, and no lock or Clear table for an empty table', () => {
    const page = renderPanel(baseState(twoTables(1)));
    fireEvent.click(page.q('table-menu')!);
    expect(page.q('table-menu-locked')!.textContent).toBe('Mode locked — page. Clear table to change.');
    expect(page.q('table-menu-clear-table')).not.toBeNull();
    cleanup();
    const empty = renderPanel(baseState(newDraft()));
    fireEvent.click(empty.q('table-menu')!);
    expect(empty.q('table-menu-locked')).toBeNull();
    expect(empty.q('table-menu-clear-table')).toBeNull();
  });

  it('disables Use for pagination for a page table and for the primary table, and Remove for the last table', () => {
    const page = renderPanel(baseState(twoTables(1)));
    fireEvent.click(page.q('table-menu')!);
    expect((page.q('table-menu-pagination') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const primary = renderPanel(baseState(threeLists(0)));
    fireEvent.click(primary.q('table-menu')!);
    expect((primary.q('table-menu-pagination') as HTMLButtonElement).disabled).toBe(true);
    expect((primary.q('table-menu-move-left') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const single = renderPanel(baseState(newDraft()));
    fireEvent.click(single.q('table-menu')!);
    expect(single.q('table-menu-remove')).toBeNull();
    fireEvent.keyDown(single.q('panel-body')!, { key: 'Escape' });
    expect(single.q('table-menu-list')).toBeNull();
  });

  it('marks the primary table as driving pagination only when pagination is on', () => {
    const on = renderPanel(baseState({ ...threeLists(), pagination: { kind: 'next', limit: 3, stopRules: [], delayMs: 0 } }));
    expect(on.qa('tab').map((t) => Boolean(t.querySelector('[data-ws="tab-drives-pagination"]')))).toEqual([true, false, false]);
    cleanup();
    const none = renderPanel(baseState({ ...threeLists(), pagination: { kind: 'none', limit: 1, stopRules: [], delayMs: 0 } }));
    expect(none.q('tab-drives-pagination')).toBeNull();
    cleanup();
    expect(renderPanel(baseState(threeLists())).q('tab-drives-pagination')).toBeNull();
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
      if (this.dataset.ws === 'tabs') return rect(0, 200);
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
    const tab = p.qa('tab').find((t) => t.dataset.table === 'questions')!;
    expect(tab.querySelector('[data-ws="tab-error"]')).not.toBeNull();
    expect(tab.title).toMatch(/at least one field/);
    expect(p.qa('tab')[0]!.querySelector('[data-ws="tab-error"]')).toBeNull();
  });

  it('shows field errors in their own table only', () => {
    const tables = [
      { name: 'page', fields: [field('title', { selectors: [css('h1')] })] },
      { name: 'products', item, fields: [field('title', { scope: 'item' as const }), field('title', { scope: 'item' as const, selectors: [css('h3')] })] },
    ];
    const inactive = renderPanel(baseState(twoTables(0, tables)));
    expect(inactive.qa('field-error')).toHaveLength(0);
    expect(inactive.qa('tab')[1]!.querySelector('[data-ws="tab-error"]')).not.toBeNull();
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
  await openList(t, byClass(t.page, 'product-title', 0));
  await acceptList(t);
  await t.send({ kind: 'draft.renameTable', name: 'products' });
  await t.send({ kind: 'draft.addTable', name: 'page' });
  await t.send({ kind: 'draft.selectTable', index: 0 });
  await t.pick(byClass(t.page, 'category-heading'));
  return { t, state: t.controller.state };
}

describe('pick section in the active tab', () => {
  it('keeps a pick outside the list in the list tab with a banner, and offers no table choice', async () => {
    const { state } = await headingPicked();
    expect(state.draft.activeTable).toBe(0);
    const p = renderPanel(state);
    expect(p.q('table-content')!.dataset.table).toBe('products');
    expect(p.q('pick-outside-banner')!.textContent).toContain('Outside the products list');
    expect(p.q('section-pick')!.contains(p.q('pick-inspector'))).toBe(true);
    expect((p.q('pick-add-field') as HTMLButtonElement).disabled).toBe(true);
    expect(p.q('pick-add-hint')!.textContent).toBe('Pick inside an item of products to add here.');
    fireEvent.click(p.q('pick-outside-add-to')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.selectTable', index: 1 });
  });

  it('keeps the selection when another tab or the + tab is chosen', async () => {
    const { t } = await headingPicked();
    await t.send({ kind: 'draft.selectTable', index: 1 });
    expect(t.controller.state.selected).toMatchObject({ table: 1, scope: 'page', outside: null });
    const p = renderPanel(t.controller.state);
    expect(p.q('pick-inspector')).not.toBeNull();
    expect(p.q('pick-outside-banner')).toBeNull();
    expect((p.q('pick-add-field') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(p.q('tab-add')!);
    expect(p.sent).toEqual([{ kind: 'draft.addTable' }]);
  });
});
