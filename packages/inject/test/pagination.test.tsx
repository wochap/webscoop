// @vitest-environment jsdom
import { cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { baseState, newDraft, renderPanel } from './panel';
import type { RecorderState } from '@webscoop/core';

afterEach(cleanup);

const field = (name: string, extra: object = {}) => ({
  name,
  type: 'text' as const,
  scope: 'item' as const,
  selectors: [{ strategy: 'css' as const, value: `.${name}`, stability: 'medium' as const, count: 24 }],
  optional: false,
  key: false,
  count: 24,
  sample: `${name} sample`,
  ...extra,
});

const expanded = (state: RecorderState): RecorderState => ({ ...state, panel: { collapsed: { recipe: false, steps: false, pagination: false } } });

describe('pagination', () => {
  it('starts collapsed with its kind and limit, or off', () => {
    const off = renderPanel(baseState(newDraft()));
    expect(off.q('section-pagination')!.dataset.collapsed).toBe('true');
    expect(off.q('pagination-summary')!.textContent).toBe('off');
    expect(off.q('pagination-delay')).toBeNull();
    fireEvent.click(off.q('section-pagination')!.querySelector('[data-ws="section-toggle"]')!);
    expect(off.sent).toEqual([{ kind: 'panel.setCollapsed', section: 'pagination', collapsed: false }]);
    cleanup();
    const draft = { ...newDraft(), pagination: { kind: 'next' as const, limit: 5, stopRules: [], delayMs: 0 } };
    expect(renderPanel(baseState(draft)).q('pagination-summary')!.textContent).toBe('Next · 5 pages');
  });

  it('removes the pagination, and offers no Remove while it is off', () => {
    expect(renderPanel(expanded(baseState(newDraft()))).q('pagination-clear')).toBeNull();
    cleanup();
    const draft = { ...newDraft(), pagination: { kind: 'next' as const, limit: 5, stopRules: [], delayMs: 0 } };
    const p = renderPanel(expanded(baseState(draft)));
    fireEvent.click(p.q('pagination-clear')!);
    expect(p.sent).toEqual([{ kind: 'draft.clearPagination' }]);
  });

  it('selects "first 3 pages" and emits limit 3', () => {
    const draft = {
      ...newDraft(),
      fields: [field('title')],
      pagination: {
        kind: 'url' as const,
        param: { name: 'page', start: 1, step: 1 },
        target: { selectors: [{ strategy: 'css' as const, value: 'a.next', stability: 'medium' as const, count: 1 }] },
        limit: 1 as const,
        stopRules: [],
        delayMs: 0,
      },
    };
    const p = renderPanel(expanded(baseState(draft)));
    expect(p.q('pagination-param')!.textContent).toContain('page');
    expect(p.q('pagination-kind-url')!.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(p.q('pagination-limit-n')!);
    expect(p.sent).toEqual([{ kind: 'draft.updatePagination', patch: { limit: 3 } }]);
    fireEvent.click(p.q('pagination-stop-no-new-items')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updatePagination', patch: { stopRules: ['no-new-items'] } });
    fireEvent.click(p.q('pagination-kind-more')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updatePagination', patch: { kind: 'more' } });
  });

  it('edits delayMs with the stepper and the input', () => {
    const draft = {
      ...newDraft(),
      fields: [field('title')],
      pagination: { kind: 'next' as const, limit: 'all' as const, stopRules: [], delayMs: 200 },
    };
    const p = renderPanel(expanded(baseState(draft)));
    const delay = p.q('pagination-delay')!;
    expect(delay.querySelector('input')!.value).toBe('200');
    fireEvent.click(delay.querySelector('[aria-label^="Increase"]')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updatePagination', patch: { delayMs: 300 } });
    fireEvent.click(delay.querySelector('[aria-label^="Decrease"]')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updatePagination', patch: { delayMs: 100 } });
    fireEvent.change(delay.querySelector('input')!, { target: { value: '1500' } });
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updatePagination', patch: { delayMs: 1500 } });
    expect(p.q('section-pagination')!.textContent).not.toContain('later version');
  });
});
