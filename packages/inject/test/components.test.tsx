// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { dataset } from '@webscoop/playground';
import { afterEach, describe, expect, it } from 'vitest';
import { MODE_TONE, ModePill } from '../src/ui/shell';
import { AncestorBreadcrumb } from '../src/ui/picking';
import { baseState, hostStates, newDraft, renderPanel } from './panel';
import type { Mode } from '../src/store';

afterEach(cleanup);

describe('shell', () => {
  it('renders every mode pill tone', () => {
    const modes: Mode[] = ['idle', 'picking', 'selected', 'items', 'editing', 'test'];
    for (const mode of modes) {
      const { container, unmount } = render(<ModePill mode={mode} />);
      const pill = container.querySelector('[data-ws="mode"]')!;
      expect(pill.className).toContain(`ws-tone-${MODE_TONE[mode]}`);
      expect(pill.getAttribute('data-mode')).toBe(mode);
      unmount();
    }
    expect(new Set(Object.values(MODE_TONE))).toEqual(new Set(['neutral', 'accent', 'ok', 'warn']));
  });

  it('shows the idle mode, the footer, and picking after p', () => {
    const p = renderPanel(baseState());
    expect(p.q('mode')!.dataset.mode).toBe('idle');
    expect(p.q('save')).not.toBeNull();
    fireEvent.keyDown(p.q('body')!, { key: 'p' });
    expect(p.q('mode')!.dataset.mode).toBe('picking');
    expect(p.q('pick-strip')!.dataset.picking).toBe('true');
  });
});

describe('recipe bar', () => {
  it('renders {category} as a chip and edits its value', () => {
    const p = renderPanel(baseState());
    const chip = p.q('var-category')!;
    expect(chip.textContent).toBe('{category}shoes');
    fireEvent.click(chip);
    const input = p.q('var-input-category') as HTMLInputElement;
    expect(input.value).toBe('shoes');
    fireEvent.change(input, { target: { value: 'boots' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.sent).toContainEqual({ kind: 'draft.setVar', name: 'category', value: 'boots' });
    fireEvent.click(p.q('reopen')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.reopen' });
  });
});

describe('inspector and candidates', () => {
  it('flags attributes stable or hashed and walks two levels up the breadcrumb', async () => {
    const { proposed } = await hostStates();
    const selection = proposed.selected!.selection;
    const p = renderPanel({ ...proposed, selected: { ...proposed.selected!, selection: { ...selection, attrs: { class: 'product-title sc-bdfBwQ', id: 'item-48213' } } } });
    const flags = p.qa('attr-value').map((el) => [el.textContent, el.dataset.stable]);
    expect(flags).toEqual([
      ['product-title', 'true'],
      ['sc-bdfBwQ', 'false'],
      ['item-48213', 'false'],
    ]);

    const trail = selection.ancestors;
    const onSelect: number[][] = [];
    const crumbs = render(<AncestorBreadcrumb trail={trail} current={selection.path} onSelect={(path) => onSelect.push(path)} />);
    const bar = crumbs.container.querySelector('[data-ws="breadcrumb"]')!;
    fireEvent.keyDown(bar, { key: 'ArrowLeft' });
    crumbs.rerender(<AncestorBreadcrumb trail={trail} current={onSelect[0]!} onSelect={(path) => onSelect.push(path)} />);
    fireEvent.keyDown(bar, { key: 'ArrowLeft' });
    expect(onSelect).toEqual([trail.at(-2)!.path, trail.at(-3)!.path]);
    expect(onSelect[1]).toEqual(selection.path.slice(0, -2));
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(onSelect[2]).toEqual(trail.at(-1)!.path);
    crumbs.unmount();

    // The same walk from the panel shortcut.
    fireEvent.keyDown(p.q('body')!, { key: 'ArrowLeft' });
    expect(p.selected).toEqual([selection.path.slice(0, -1)]);
  });

  it('shows host counts and lets the user change the primary candidate', async () => {
    const { proposed } = await hostStates();
    const p = renderPanel({ ...proposed, proposal: null });
    const rows = p.qa('candidate');
    const counts = p.qa('candidate-count').map((el) => el.textContent);
    expect(counts).toEqual(proposed.selected!.selection.candidates.map((c) => String(c.count)));
    expect(rows[0]!.dataset.primary).toBe('true');
    expect(p.qa('stability').map((b) => b.dataset.stability)).toContain('stable');
    fireEvent.click(rows[2]!);
    expect(p.sent).toEqual([{ kind: 'inspect.primary', index: 2 }]);
    act(() => p.store.setHost({ ...proposed, proposal: null, selected: { ...proposed.selected!, primary: 2 } }));
    expect(p.qa('candidate')[2]!.dataset.primary).toBe('true');
    fireEvent.click(p.q('add-field')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.addField' });
  });
});

describe('item detection', () => {
  it('confirms with Enter and updates the count on exclusion', async () => {
    const { proposed } = await hostStates({ sponsored: 2 });
    const p = renderPanel(proposed);
    expect(p.q('mode')!.dataset.mode).toBe('items');
    expect(p.q('items-count')!.textContent).toBe('24');
    expect(p.q('samples')!.textContent).toContain(dataset[0]!.title);
    expect(p.q('level-broader')!.textContent).toContain('24 matches');

    fireEvent.change(p.q('exclude-input')!, { target: { value: '.sponsored' } });
    fireEvent.submit(p.q('exclude-input')!.closest('form')!);
    expect(p.sent).toEqual([{ kind: 'draft.addExclusion', selector: '.sponsored' }]);
    const proposal = proposed.proposal!;
    act(() =>
      p.store.setHost({
        ...proposed,
        proposal: { ...proposal, proposed: { ...proposal.proposed, count: 22, total: 24 }, exclude: [{ strategy: 'css', value: '.sponsored', stability: 'medium', count: 2 }] },
      }),
    );
    expect(p.q('items-count')!.textContent).toBe('22');
    expect(p.q('exclusion')!.textContent).toContain('.sponsored');

    fireEvent.keyDown(p.q('body')!, { key: 'Enter' });
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.confirmItems', level: 'proposed' });
    fireEvent.click(p.q('level-broader')!);
    fireEvent.keyDown(p.q('body')!, { key: 'Enter' });
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.confirmItems', level: 'broader' });
  });

  it('does not confirm while typing in the exclusion input', async () => {
    const { proposed } = await hostStates();
    const p = renderPanel(proposed);
    fireEvent.keyDown(p.q('exclude-input')!, { key: 'Enter' });
    expect(p.sent.filter((m) => m.kind === 'draft.confirmItems')).toEqual([]);
  });
});

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

describe('fields', () => {
  it('reorders with Alt+Up and Alt+Down and by drag', () => {
    const draft = { ...newDraft(), fields: [field('title'), field('price'), field('url')] };
    const p = renderPanel(baseState(draft));
    const rows = p.qa('field');
    expect(rows.map((r) => r.dataset.name)).toEqual(['title', 'price', 'url']);
    fireEvent.click(rows[0]!);
    expect(p.store.get().ui.focusedField).toBe(0);
    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown', altKey: true });
    expect(p.sent).toEqual([{ kind: 'draft.moveField', from: 0, to: 1 }]);
    expect(p.store.get().ui.focusedField).toBe(1);
    fireEvent.keyDown(rows[0]!, { key: 'ArrowUp', altKey: true });
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.moveField', from: 1, to: 0 });

    fireEvent.dragStart(rows[2]!);
    fireEvent.dragOver(rows[0]!);
    fireEvent.drop(rows[0]!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.moveField', from: 2, to: 0 });
  });

  it('shows the duplicate-name error inline and a zero-match warning', () => {
    const draft = {
      ...newDraft(),
      fields: [field('price'), field('price', { error: 'duplicate field name "price" (first declared at $.fields[0])' }), field('badge', { count: 0, sample: null })],
    };
    const p = renderPanel(baseState(draft));
    const names = p.qa('field-name') as HTMLInputElement[];
    expect(names[1]!.getAttribute('aria-invalid')).toBe('true');
    expect(p.q('field-error')!.textContent).toMatch(/duplicate field name "price"/);
    fireEvent.change(names[1]!, { target: { value: 'amount' } });
    fireEvent.blur(names[1]!);
    expect(p.sent).toEqual([{ kind: 'draft.updateField', index: 1, patch: { name: 'amount' } }]);
    const warning = p.q('zero-match')!;
    expect(warning.textContent).toContain('Matches nothing');
    fireEvent.click(p.q('make-optional')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateField', index: 2, patch: { optional: true } });
    fireEvent.click(p.q('repick')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.repickField', index: 2 });
    expect(p.store.get().ui.picking).toBe(true);
  });
});

describe('pagination', () => {
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
    const p = renderPanel(baseState(draft));
    expect(p.q('pagination-param')!.textContent).toContain('page');
    expect(p.q('kind-url')!.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(p.q('seg-n')!);
    expect(p.sent).toEqual([{ kind: 'draft.updatePagination', patch: { limit: 3 } }]);
    fireEvent.click(p.q('stop-no-new-items')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updatePagination', patch: { stopRules: ['no-new-items'] } });
    fireEvent.click(p.q('kind-more')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updatePagination', patch: { kind: 'more' } });
  });

  it('edits delayMs with the stepper and the input', () => {
    const draft = {
      ...newDraft(),
      fields: [field('title')],
      pagination: { kind: 'next' as const, limit: 'all' as const, stopRules: [], delayMs: 200 },
    };
    const p = renderPanel(baseState(draft));
    const delay = p.q('pagination-delay')!;
    expect(delay.querySelector('input')!.value).toBe('200');
    fireEvent.click(delay.querySelector('[aria-label^="Increase"]')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updatePagination', patch: { delayMs: 300 } });
    fireEvent.click(delay.querySelector('[aria-label^="Decrease"]')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updatePagination', patch: { delayMs: 100 } });
    fireEvent.change(delay.querySelector('input')!, { target: { value: '1500' } });
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updatePagination', patch: { delayMs: 1500 } });
    expect(p.q('pagination')!.textContent).not.toContain('later version');
  });
});

describe('results drawer', () => {
  it('renders 24 rows and per-field status, and a JSON view', async () => {
    const { t } = await hostStates();
    await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
    await t.send({ kind: 'draft.updateField', index: 0, patch: { name: 'title' } });
    await t.controller.testRun();
    const p = renderPanel(t.controller.state, { drawerOpen: true });
    expect(p.q('mode')!.dataset.mode).toBe('test');
    expect(p.qa('result-row')).toHaveLength(24);
    expect(p.q('test-rows')!.textContent).toBe('24 rows');
    expect(p.qa('field-status-item').map((el) => [el.dataset.field, el.dataset.status])).toEqual([['title', 'ok']]);
    fireEvent.click(p.q('view-json')!);
    expect(JSON.parse(p.q('results-json')!.textContent!)).toHaveLength(24);
    fireEvent.click(p.q('drawer-close')!);
    expect(p.q('drawer')).toBeNull();
  });
});
