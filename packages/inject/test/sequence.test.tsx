// @vitest-environment jsdom
import { cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { validateDraft, type Draft, type DraftTable } from '@webscoop/core';
import { handleKey } from '../src/ui/App';
import { baseState, newDraft, renderPanel } from './panel';

afterEach(cleanup);

const css = (value: string) => ({ strategy: 'css' as const, value, stability: 'medium' as const, count: 1 });
const field = (name: string, scope: 'item' | 'page') => ({ name, type: 'text' as const, scope, selectors: [css(`.${name}`)], optional: false, key: false, count: 10, sample: name });
const tables: DraftTable[] = [
  { name: 'summary', item: null, fields: [field('total', 'page')] },
  { name: 'results', item: { selectors: [css('.card')], exclude: [], count: 10, total: 10 }, fields: [field('title', 'item')] },
];
const reach = { name: 'reach-report', steps: [{ kind: 'click' as const, target: { selectors: [css('button')] }, window: 'same' as const, optional: false, count: 1 }] };
const pagination = { kind: 'next' as const, target: { selectors: [css('a.next')] }, limit: 5, stopRules: ['no-new-items' as const], delayMs: 0, table: 'results' };

function draft(extra: Partial<Draft> = {}): Draft {
  return validateDraft({ ...newDraft(), tables, activeTable: 0, form: 'tables', flows: [reach], activeFlow: 0, ...extra });
}

const open = (d: Draft) => ({ ...baseState(d), panel: { collapsed: { recipe: false, flows: false, sequence: false } } });

/** Gives rows a vertical layout of 40px tall rows for drag tests. */
function stack(rows: HTMLElement[]) {
  rows.forEach((r, i) => (r.getBoundingClientRect = () => ({ left: 0, top: i * 40, width: 200, height: 40, right: 200, bottom: i * 40 + 40, x: 0, y: i * 40, toJSON: () => ({}) })));
}

describe('sequence section', () => {
  it('starts collapsed with its blocks in short form, and shows the default badge', () => {
    const p = renderPanel(baseState(draft()));
    expect(p.q('section-sequence')!.dataset.collapsed).toBe('true');
    expect(p.q('sequence-summary')!.textContent).toContain('flow: reach-report → extract: summary → extract: results');
    fireEvent.click(p.q('section-sequence')!.querySelector('[data-ws="section-toggle"]')!);
    expect(p.sent).toEqual([{ kind: 'panel.setCollapsed', section: 'sequence', collapsed: false }]);
    cleanup();
    expect(renderPanel(open(draft())).q('sequence-default')).not.toBeNull();
  });

  it('numbers the blocks and nests the paginate block with its settings', () => {
    const p = renderPanel(open(draft({ pagination })), { paginateOpen: true });
    expect(p.qa('block').map((b) => [b.dataset.path, b.dataset.kind])).toEqual([
      ['0', 'flow'],
      ['1', 'extract'],
      ['2', 'paginate'],
      ['2.0', 'extract'],
    ]);
    expect(p.q('paginate-kind-next')!.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(p.q('paginate-limit-all')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'paginate.update', patch: { limit: 'all' } });
    fireEvent.click(p.q('paginate-stop-first-item-repeats')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'paginate.update', patch: { stopRules: ['no-new-items', 'first-item-repeats'] } });
    fireEvent.change(p.q('paginate-table')!, { target: { value: '' } });
    expect(p.sent.at(-1)).toEqual({ kind: 'paginate.update', patch: { table: null } });
    fireEvent.click(p.q('paginate-remove')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.clearPagination' });
  });

  it('summarizes the paginate block by kind and limit', () => {
    const detail = (limit: 5 | 1 | 'all') => {
      const p = renderPanel(open(draft({ pagination: { ...pagination, limit } })));
      const text = p.qa('block').find((b) => b.dataset.kind === 'paginate')!.querySelector('[data-ws="block-detail"]')!.textContent;
      p.unmount();
      return text;
    };
    expect(detail(5)).toBe('next · 5 pages');
    expect(detail(1)).toBe('next · 1 page');
    expect(detail('all')).toBe('next · all pages');
  });

  it('shows errors on the offending blocks and disables Save and Test run with the reason', () => {
    const custom = draft({ pagination, sequence: { custom: true, blocks: [{ flow: 'reach-report' }, { extract: 'summary' }, { paginate: { do: [{ extract: 'results' }, { extract: 'summary' }] } }] } });
    const p = renderPanel(open(custom));
    // The duplicate shows on both blocks that extract summary.
    expect(p.qa('block').filter((b) => b.className.includes('ws-block-error')).map((b) => b.dataset.path)).toEqual(['1', '2.1']);
    expect(p.q('sequence-error-count')!.textContent).toBe('2 errors');
    expect(p.q('footer-blocker')!.textContent).toBe('Fix 2 sequence errors to save');
    expect((p.q('footer-save') as HTMLButtonElement).disabled).toBe(true);
    expect((p.q('footer-test') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(p.q('sequence-reset')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'sequence.reset' });
  });

  it('moves the focused block with Alt+Up and Alt+Down, into and out of the paginate block', () => {
    const p = renderPanel(open(draft({ pagination })));
    const key = (k: string) => handleKey({ key: k, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }, null, p.store.get(), p.actions);
    fireEvent.click(p.qa('block')[1]!);
    expect(p.store.get().ui.focusedBlock).toEqual([1]);
    expect(key('ArrowDown')).toBe(true);
    expect(p.sent.at(-1)).toEqual({ kind: 'sequence.move', from: [1], to: [2, 0] });
    p.store.setUi({ focusedBlock: [2, 0] });
    key('ArrowUp');
    expect(p.sent.at(-1)).toEqual({ kind: 'sequence.move', from: [2, 0], to: [2] });
  });
});

describe('sequence drag', () => {
  const nested = (inner: Draft['sequence']['blocks']) => draft({ pagination, sequence: { custom: true, blocks: [{ flow: 'reach-report' }, ...inner] } });

  it('drops a top-level block into the paginate block', () => {
    const p = renderPanel(open(nested([{ paginate: { do: [{ extract: 'results' }] } }])));
    const rows = p.qa('block');
    expect(rows.map((b) => b.dataset.path)).toEqual(['0', '1', '1.0']);
    stack(rows);
    fireEvent.dragStart(rows[0]!);
    fireEvent.dragOver(rows[2]!, { clientY: 110 });
    expect(rows[2]!.className).toContain('ws-drop-after');
    expect(p.container.querySelectorAll('.ws-drop-before, .ws-drop-after')).toHaveLength(1);
    fireEvent.drop(rows[2]!, { clientY: 110 });
    expect(p.sent.at(-1)).toEqual({ kind: 'sequence.move', from: [0], to: [1, 1] });
  });

  it('drops an inner block before the first top-level block', () => {
    const p = renderPanel(open(nested([{ paginate: { do: [{ extract: 'results' }] } }])));
    const rows = p.qa('block');
    stack(rows);
    fireEvent.dragStart(rows[2]!);
    fireEvent.dragOver(rows[0]!, { clientY: 10 });
    expect(rows[0]!.className).toContain('ws-drop-before');
    fireEvent.drop(rows[0]!, { clientY: 10 });
    expect(p.sent.at(-1)).toEqual({ kind: 'sequence.move', from: [1, 0], to: [0] });
  });

  it('drops into an empty paginate block', () => {
    const p = renderPanel(open(nested([{ extract: 'results' }, { paginate: { do: [] } }])));
    const rows = p.qa('block');
    fireEvent.dragStart(rows[1]!);
    const empty = p.q('paginate-empty')!;
    fireEvent.dragOver(empty, { clientY: 0 });
    expect(empty.className).toContain('ws-drop-before');
    fireEvent.drop(empty, { clientY: 0 });
    expect(p.sent.at(-1)).toEqual({ kind: 'sequence.move', from: [1], to: [2, 0] });
  });

  it('shows no line inside the paginate block while it is dragged', () => {
    const p = renderPanel(open(nested([{ paginate: { do: [{ extract: 'results' }, { extract: 'summary' }] } }])));
    const rows = p.qa('block');
    stack(rows);
    const before = p.sent.length;
    fireEvent.dragStart(rows[1]!);
    for (const [row, y] of [[rows[2]!, 85], [rows[2]!, 95], [rows[3]!, 125], [rows[3]!, 135]] as const) {
      fireEvent.dragOver(row, { clientY: y });
      expect(p.container.querySelectorAll('.ws-drop-before, .ws-drop-after')).toHaveLength(0);
    }
    fireEvent.drop(rows[3]!, { clientY: 135 });
    expect(p.sent).toHaveLength(before);
  });
});

describe('automation only', () => {
  it('shows the empty state in place of the tables, and the tabs after Add a table', () => {
    const d = validateDraft({ ...newDraft(), flows: [reach], activeFlow: 0 });
    const p = renderPanel(baseState(d));
    expect(p.q('flows-only')).not.toBeNull();
    expect(p.q('tabs')).toBeNull();
    expect(p.q('footer-count')!.textContent).toBe('No tables · 0 fields · 1 flow · 1 step');
    expect((p.q('footer-test') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(p.q('flows-only-add-table')!);
    expect(p.q('tabs')).not.toBeNull();
  });
});
