// @vitest-environment jsdom
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateDraft, type Draft, type DraftFlow, type DraftStep, type RecorderState, type TargetEdit } from '@webscoop/core';
import { baseState, newDraft, renderPanel, withTable } from './panel';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const field = { name: 'title', type: 'text' as const, scope: 'page' as const, selectors: [{ strategy: 'css' as const, value: 'h1', stability: 'medium' as const, count: 1 }], optional: false, key: false, count: 1, sample: 'x' };
const fp = (tag: string) => ({ tag, textSample: '', attrs: {}, ancestors: [], bbox: { x: 0, y: 0, w: 1, h: 1 } });
const tab = { selectors: [{ strategy: 'css' as const, value: 'nav a.tab', stability: 'medium' as const, count: 1 }, { strategy: 'xpath' as const, value: '/html/body/nav/a[2]', stability: 'fragile' as const, count: 1 }], fingerprint: fp('a') };
const step = (kind: DraftStep['kind'], extra: Partial<DraftStep> = {}): DraftStep => ({ kind, target: tab, window: 'same', optional: false, count: 1, ...extra });

function withFlows(flows: DraftFlow[], extra: Partial<Draft> = {}): Draft {
  return validateDraft({ ...withTable(newDraft(), { fields: [field] }), flows, activeFlow: flows.length > 0 ? 0 : null, ...extra });
}

const stepRef = { kind: 'step' as const, flow: 0, index: 0 };
const edit = (patch: Partial<TargetEdit> = {}): TargetEdit => ({ ref: stepRef, phase: 'typing', title: 'flow-2 · step 1', strip: 'Picking target for flow-2 · step 1', use: 'Use for step', frame: null, selection: null, primary: 0, ...patch });
const picked = (frame: TargetEdit['frame'] = null): NonNullable<TargetEdit['selection']> => ({
  path: [0, 1],
  tag: 'a',
  name: 'Images',
  text: 'Images',
  attrs: { class: 'tab' },
  candidates: [
    { strategy: 'role', value: 'link|Images', stability: 'stable', count: 1, hit: true },
    { strategy: 'css', value: 'nav a', stability: 'medium', count: 3, hit: false },
  ],
  fingerprint: fp('a'),
  ancestors: [{ label: 'nav', path: [0] }, { label: 'a', path: [0, 1] }],
  containerPath: null,
  framePath: frame ? [3] : null,
  frame,
  fill: null,
});

function state(flows: DraftFlow[], patch: Partial<RecorderState> = {}): RecorderState {
  return { ...baseState(withFlows(flows)), ...patch };
}

/** Let the selector input's 250 ms count delay run and its count settle. */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('target editor', () => {
  it('shows the chip, the candidate count, Re-pick, and Edit selector on the step edit form', () => {
    const p = renderPanel(state([{ name: 'flow-2', steps: [step('click')] }]));
    fireEvent.click(p.q('step-edit-toggle')!);
    expect(p.q('step-target-edit-chip')!.textContent).toContain('nav a.tab');
    expect(p.q('step-target-edit-candidates')!.textContent).toBe('2 candidates, first used');
    fireEvent.click(p.q('step-target-edit-type')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'target.edit.start', ref: stepRef, mode: 'type' });
    fireEvent.click(p.q('step-target-edit-repick')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'target.edit.start', ref: stepRef, mode: 'pick' });
  });

  it('counts typed text live: 1, several with the first outlined, 0 with a warning, and invalid with Use disabled', async () => {
    vi.useFakeTimers();
    const p = renderPanel(state([{ name: 'flow-2', steps: [step('click')] }], { targetEdit: edit() }), { editingStep: { flow: 0, index: 0 } });
    const counts: Record<string, { count: number; error: string | null }> = {
      'css=nav a.tab': { count: 1, error: null },
      'css=nav a': { count: 3, error: null },
      'css=.later': { count: 0, error: null },
      'css=[[[': { count: 0, error: 'invalid selector: bad' },
    };
    const previews: (string | null)[] = [];
    p.actions.countTarget = async (_ref, text) => counts[text] ?? null;
    p.actions.previewSelector = (text) => void previews.push(text);
    const input = p.q('step-target-edit-selector') as HTMLInputElement;
    expect(input.value).toBe('nav a.tab');
    await settle();
    expect(p.q('step-target-edit-status')!.textContent).toBe('1 match');
    const type = async (value: string) => {
      fireEvent.change(input, { target: { value } });
      await settle();
    };
    await type('nav a');
    expect(p.q('step-target-edit-status')!.textContent).toBe('3 matches. The first match is used.');
    expect(previews.at(-1)).toBe('css=nav a');
    await type('.later');
    expect(p.q('step-target-edit-status')!.textContent).toBe('Matches nothing on this page. Use still saves it.');
    expect((p.q('step-target-edit-use') as HTMLButtonElement).disabled).toBe(false);
    await type('[[[');
    expect(p.q('step-target-edit-selector-error')!.textContent).toBe('invalid selector: bad');
    expect((p.q('step-target-edit-use') as HTMLButtonElement).disabled).toBe(true);
    await type('nav a.tab');
    fireEvent.click(p.q('step-target-edit-use')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'target.edit.apply', ref: stepRef, by: 'selector', selector: 'css=nav a.tab' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(p.sent.at(-1)).toEqual({ kind: 'target.edit.cancel' });
  });

  it('disables Re-pick of a popup step while no popup is open', () => {
    const p = renderPanel(state([{ name: 'flow-2', steps: [step('click'), step('click'), step('fill', { value: 'u', window: 'popup' })] }], { popups: 0 }), { editingStep: { flow: 0, index: 2 } });
    expect((p.q('step-target-edit-repick') as HTMLButtonElement).disabled).toBe(true);
    expect(p.q('step-target-edit-disabled')!.textContent).toBe('popup not open — replay steps 1–2 first');
  });

  it('shows the request while picking: the strip header, a back link, and re-picking… on the row', () => {
    const p = renderPanel(state([{ name: 'flow-2', steps: [step('click')] }], { targetEdit: edit({ phase: 'picking' }) }));
    expect(p.q('pick-target-title')!.textContent).toBe('Target for flow-2 · step 1');
    expect(p.q('pick-target-waiting')).not.toBeNull();
    expect(p.q('step-repicking')!.textContent).toBe('re-picking…');
    expect((p.q('pick-target-use') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(p.q('pick-target-back')!);
    expect(p.store.get().ui.editingStep).toEqual({ flow: 0, index: 0 });
    fireEvent.click(p.q('pick-target-cancel')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'target.edit.cancel' });
  });

  it('shows the selection details after the pick and uses the highlighted candidate for the step', () => {
    const p = renderPanel(state([{ name: 'flow-2', steps: [step('click')] }], { targetEdit: edit({ phase: 'picked', selection: picked() }) }));
    expect(p.q('pick-inspector-tag')!.textContent).toBe('a');
    expect(p.qa('pick-candidate')).toHaveLength(2);
    expect(p.qa('pick-candidate-miss')).toHaveLength(1);
    expect(p.q('pick-target-typed-selector')).not.toBeNull();
    fireEvent.click(p.qa('pick-candidate')[1]!);
    expect(p.sent.at(-1)).toEqual({ kind: 'inspect.primary', index: 1 });
    expect(p.q('pick-target-use')!.textContent).toBe('Use for step');
    fireEvent.click(p.q('pick-target-use')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'target.edit.apply', ref: stepRef, by: 'selection' });
  });

  it('shows the iframe card for a pick inside an iframe', () => {
    const frame = { selectors: [{ strategy: 'id' as const, value: 'checkout', stability: 'stable' as const, count: 1 }] };
    const p = renderPanel(state([{ name: 'flow-2', steps: [step('click')] }], { targetEdit: edit({ phase: 'picked', frame, selection: picked(frame) }) }));
    expect(p.q('pick-frame')!.dataset.frame).toBe('iframe#checkout');
  });

  it('shows the details in the compact sheet of a popup', () => {
    const p = renderPanel(state([{ name: 'flow-2', steps: [step('fill', { value: 'u', window: 'popup' })] }], { popup: true, popups: 1, targetEdit: edit({ phase: 'picked', selection: picked() }) }), { narrow: true });
    expect(p.q('panel-sheet')!.querySelector('[data-ws="pick-target"]')).not.toBeNull();
  });

  it('edits a reactive trigger and the paginate target with the same editor', () => {
    const trigger: DraftFlow = { name: 'login-wall', trigger: tab, steps: [step('click')] };
    const p = renderPanel(state([trigger]));
    fireEvent.click(p.q('trigger-target-edit-repick')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'target.edit.start', ref: { kind: 'trigger', flow: 0 }, mode: 'pick' });
    p.unmount();
    const draft = withFlows([{ name: 'setup', steps: [step('click')] }], { pagination: { kind: 'next', target: tab, limit: 'all', stopRules: [], delayMs: 0 } });
    const q = renderPanel({ ...baseState(draft), panel: { collapsed: { recipe: false, flows: false, sequence: false } } }, { paginateOpen: true });
    fireEvent.click(q.q('paginate-target-edit-type')!);
    expect(q.sent.at(-1)).toEqual({ kind: 'target.edit.start', ref: { kind: 'pagination' }, mode: 'type' });
  });
});
