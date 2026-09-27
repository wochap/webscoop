// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AncestorBreadcrumb, shownCrumbs } from '../src/ui/picking';
import { hostStates, renderPanel } from './panel';
import type { Crumb } from '@webscoop/core';

afterEach(cleanup);
describe('inspector and candidates', () => {
  it('flags attributes stable or hashed and walks two levels up the breadcrumb', async () => {
    const { suggested: proposed } = await hostStates();
    const selection = proposed.selected!.selection;
    const p = renderPanel({ ...proposed, selected: { ...proposed.selected!, selection: { ...selection, attrs: { class: 'product-title sc-bdfBwQ', id: 'item-48213' } } } });
    const flags = p.qa('pick-attr-value').map((el) => [el.textContent, el.dataset.stable]);
    expect(flags).toEqual([
      ['product-title', 'true'],
      ['sc-bdfBwQ', 'false'],
      ['item-48213', 'false'],
    ]);

    const trail = selection.ancestors;
    const onSelect: number[][] = [];
    const crumbs = render(<AncestorBreadcrumb trail={trail} current={selection.path} onSelect={(path) => onSelect.push(path)} />);
    const bar = crumbs.container.querySelector('[data-ws="pick-breadcrumb"]')!;
    fireEvent.keyDown(bar, { key: 'ArrowLeft' });
    crumbs.rerender(<AncestorBreadcrumb trail={trail} current={onSelect[0]!} onSelect={(path) => onSelect.push(path)} />);
    fireEvent.keyDown(bar, { key: 'ArrowLeft' });
    expect(onSelect).toEqual([trail.at(-2)!.path, trail.at(-3)!.path]);
    expect(onSelect[1]).toEqual(selection.path.slice(0, -2));
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(onSelect[2]).toEqual(trail.at(-1)!.path);
    crumbs.unmount();

    // The same walk from the panel shortcut.
    fireEvent.keyDown(p.q('panel-body')!, { key: 'ArrowLeft' });
    expect(p.selected).toEqual([selection.path.slice(0, -1)]);
  });

  it('shows host counts and lets the user change the primary candidate', async () => {
    const { suggested: proposed } = await hostStates();
    const p = renderPanel({ ...proposed, proposal: null });
    const rows = p.qa('pick-candidate');
    const counts = p.qa('pick-candidate-count').map((el) => el.textContent);
    expect(counts).toEqual(proposed.selected!.selection.candidates.map((c) => String(c.count)));
    expect(rows[0]!.dataset.primary).toBe('true');
    expect(p.qa('pick-candidate-stability').map((b) => b.dataset.stability)).toContain('stable');
    fireEvent.click(rows[2]!);
    expect(p.sent).toEqual([{ kind: 'inspect.primary', index: 2 }]);
    act(() => p.store.setHost({ ...proposed, proposal: null, selected: { ...proposed.selected!, primary: 2 } }));
    expect(p.qa('pick-candidate')[2]!.dataset.primary).toBe('true');
    fireEvent.click(p.q('pick-add-field')!);
    const { defaults } = proposed.selected!;
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.addField', patch: { name: defaults.name, type: defaults.type, attr: defaults.attr ?? null, optional: false, key: false } });
  });
});

describe('picking from a selection', () => {
  it('keeps the selection when Esc stops picking', async () => {
    const { suggested } = await hostStates();
    const p = renderPanel(suggested);
    expect(p.q('pick-inspector')).not.toBeNull();
    fireEvent.keyDown(p.q('panel-body')!, { key: 'p' });
    expect(p.store.get().ui.picking).toBe(true);
    fireEvent.keyDown(p.q('panel-body')!, { key: 'Escape' });
    expect(p.store.get().ui.picking).toBe(false);
    expect(p.sent.some((m) => m.kind === 'selection.clear')).toBe(false);
    expect(p.q('pick-inspector')).not.toBeNull();
    expect(p.q('panel-mode')!.dataset.mode).toBe('selected');
  });
});

describe('candidate verification', () => {
  it('shows the miss badge only on a candidate verified as a miss', async () => {
    const { proposed } = await hostStates();
    const selection = proposed.selected!.selection;
    const marks = [true, false, undefined];
    const candidates = selection.candidates.slice(0, 3).map((c, i) => {
      const { hit: _hit, ...rest } = c;
      return marks[i] === undefined ? rest : { ...rest, hit: marks[i] };
    });
    const p = renderPanel({ ...proposed, proposal: null, selected: { ...proposed.selected!, selection: { ...selection, candidates } } });
    const rows = p.qa('pick-candidate');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.querySelector('[data-ws="pick-candidate-miss"]') !== null)).toEqual([false, true, false]);
    expect(p.qa('pick-candidate-miss')[0]!.textContent).toBe('reads another element');
    expect(rows.map((r) => r.dataset.hit)).toEqual(['true', 'false', undefined]);
  });
});

describe('ancestor breadcrumb', () => {
  const trail: Crumb[] = Array.from({ length: 23 }, (_, i) => ({ label: i === 22 ? 'h3' : `div${i}`, path: Array.from({ length: i + 1 }, () => 0) }));

  it('shows the last three crumbs ending in the selection, and every crumb after the expander', () => {
    const selected: number[][] = [];
    const r = render(<AncestorBreadcrumb trail={trail} current={trail[22]!.path} onSelect={(p) => selected.push(p)} />);
    const labels = () => Array.from(r.container.querySelectorAll('[data-ws="pick-crumb"]')).map((c) => c.textContent);
    expect(labels()).toEqual(['div20', 'div21', 'h3']);
    expect(r.container.querySelector('[data-ws="pick-crumb-expand"]')).not.toBeNull();
    fireEvent.click(r.container.querySelector('[data-ws="pick-crumb-expand"]')!);
    expect(labels()).toHaveLength(23);
    expect(r.container.querySelector('[data-ws="pick-crumb-expand"]')).toBeNull();
  });

  it('follows the selection as it walks up', () => {
    expect(shownCrumbs(trail, trail[20]!.path, false).crumbs.map((c) => c.label)).toEqual(['div18', 'div19', 'div20']);
    expect(shownCrumbs(trail.slice(0, 2), trail[1]!.path, false)).toEqual({ crumbs: trail.slice(0, 2), hidden: 0 });
  });
});
