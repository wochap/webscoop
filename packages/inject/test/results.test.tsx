// @vitest-environment jsdom
import { cleanup, fireEvent } from '@testing-library/react';
import { validateDraft, type Draft, type DraftField, type DraftTable, type TestResults } from '@webscoop/core';
import { afterEach, describe, expect, it } from 'vitest';
import { baseState, newDraft, renderPanel, hostStates } from './panel';

afterEach(cleanup);

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

function twoTables(active = 0, tables?: Partial<DraftTable>[]): Draft {
  const list = (tables ?? [
    { name: 'products', item, fields: [field('title', { scope: 'item', count: 24 }), field('price', { scope: 'item', count: 24 })] },
    { name: 'page', fields: [field('heading')] },
  ]).map((t) => ({ name: 'items', item: null, fields: [], ...t }));
  return validateDraft({ ...newDraft(), tables: list, activeTable: active, form: 'tables' });
}

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
    expect(p.qa('results-tab').map((t) => [t.dataset.table, t.getAttribute('aria-selected'), t.textContent])).toEqual([
      ['products', 'false', 'products · 22'],
      ['page', 'true', 'page · 1'],
    ]);
    expect(p.q('results-rows')!.textContent).toBe('1 row');
    expect(p.q('results-dropped')).toBeNull();
    expect(p.qa('results-row')).toHaveLength(1);
    fireEvent.click(p.qa('results-tab')[0]!);
    expect(p.q('results-rows')!.textContent).toBe('22 rows');
    expect(p.q('results-dropped')!.textContent).toBe('2 rows dropped: url');
    expect(p.qa('results-row')).toHaveLength(22);
    expect(p.qa('results-field-status-item').map((f) => f.dataset.field)).toEqual(['title']);
  });

  it('badges the column of a hover field', () => {
    const table = { ...results.tables[0]!, fields: [{ name: 'title', status: 'ok' as const, hover: true }] };
    const p = renderPanel({ ...baseState(), test: { ...results, tables: [table] } }, { drawerOpen: true });
    const badges = p.qa('field-hover-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]!.closest('th')!.textContent).toContain('title');
  });

  it('shows no tabs for a single table', () => {
    const p = renderPanel({ ...baseState(), test: { ...results, tables: [results.tables[0]!] } }, { drawerOpen: true });
    expect(p.q('results-tabs')).toBeNull();
    expect(p.q('results-rows')!.textContent).toBe('22 rows');
  });

  it('renders 24 rows and per-field status, and a JSON view', async () => {
    const { t } = await hostStates();
    await t.send({ kind: 'draft.confirmItems' });
    await t.send({ kind: 'draft.addField', patch: { name: 'title' } });
    await t.controller.testRun();
    const p = renderPanel(t.controller.state, { drawerOpen: true });
    expect(p.q('panel-mode')!.dataset.mode).toBe('test');
    expect(p.qa('results-row')).toHaveLength(24);
    expect(p.q('results-rows')!.textContent).toBe('24 rows');
    expect(p.qa('results-field-status-item').map((el) => [el.dataset.field, el.dataset.status])).toEqual([['title', 'ok']]);
    fireEvent.click(p.q('results-view-json')!);
    expect(JSON.parse(p.q('results-json')!.textContent!)).toHaveLength(24);
    expect(p.q('results-table')).toBeNull();
    fireEvent.click(p.q('results-view-table')!);
    expect(p.q('results-view-table')!.getAttribute('aria-pressed')).toBe('true');
    expect(p.q('results-json')).toBeNull();
    expect(p.q('results-table')).not.toBeNull();
    expect(p.qa('results-row')).toHaveLength(24);
    fireEvent.click(p.q('results-close')!);
    expect(p.q('results')).toBeNull();
    expect(p.q('results-dropped')).toBeNull();
  });

  it('shows the rows dropped for missing required fields next to the row count', () => {
    const rows = Array.from({ length: 22 }, (_, i) => ({ _page: 1, _index: i, url: `/p/${i}` }));
    const test = {
      tables: [{ name: 'items', rows, rowCount: 22, dropped: { count: 2, fields: ['url'] }, fields: [{ name: 'url', status: 'partial' as const }] }],
      durationMs: 5,
      warnings: ['dropped 2 rows on page 1: required field "url" missing on rows 3, 9'],
    };
    const p = renderPanel({ ...baseState(), test }, { drawerOpen: true });
    expect(p.q('results-rows')!.textContent).toBe('22 rows');
    expect(p.q('results-dropped')!.textContent).toBe('2 rows dropped: url');
    expect(p.qa('results-field-status-item').map((el) => el.dataset.status)).toEqual(['partial']);
    expect(p.q('results-log')!.textContent).toContain('missing on rows 3, 9');
  });
});
