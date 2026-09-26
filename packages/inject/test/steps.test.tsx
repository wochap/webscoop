// @vitest-environment jsdom
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DraftStep } from '@webscoop/core/page';
import { recordAsStep } from '../src/ui/App';
import { targetSummary } from '../src/ui/steps';
import { baseState, hostStates, newDraft, renderPanel, withTable } from './panel';

afterEach(cleanup);

const field = { name: 'title', type: 'text' as const, scope: 'page' as const, selectors: [{ strategy: 'css' as const, value: 'h1', stability: 'medium' as const, count: 1 }], optional: false, key: false, count: 1, sample: 'x' };
const fp = (tag: string, extra: object = {}) => ({ tag, textSample: '', attrs: {}, ancestors: [], bbox: { x: 0, y: 0, w: 1, h: 1 }, ...extra });

const step = (kind: DraftStep['kind'], extra: Partial<DraftStep> = {}): DraftStep => ({
  kind,
  target: { selectors: [{ strategy: 'role', value: 'button|Accept all', stability: 'stable', count: 1 }], fingerprint: fp('button', { role: 'button', name: 'Accept all' }) },
  when: 'first-page',
  optional: false,
  count: 1,
  ...extra,
});

function withSteps(steps: DraftStep[]) {
  return baseState({ ...withTable(newDraft(), { fields: [field] }), steps });
}

describe('steps list', () => {
  it('lists steps with kind, target, and count, and counts them in the footer', () => {
    const p = renderPanel(withSteps([step('click'), step('type', { value: 'mouse', target: { selectors: [{ strategy: 'css', value: 'input', stability: 'medium' }] }, count: 1 })]));
    expect(p.qa('step').map((r) => r.dataset.kind)).toEqual(['click', 'type']);
    expect(p.qa('step-target').map((t) => t.textContent)).toEqual(['button "Accept all"', 'css=input']);
    expect(p.q('footer-count')!.textContent).toBe('1 field · 2 steps');
    expect(p.q('steps')!.textContent).toContain('Steps · 2');
  });

  it('edits the value, inserts a variable chip, and toggles every page and optional', () => {
    const p = renderPanel(withSteps([step('type', { value: 'mo' })]));
    const value = p.q('step-value') as HTMLInputElement;
    fireEvent.change(value, { target: { value: 'mouse' } });
    fireEvent.blur(value);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateStep', index: 0, patch: { value: 'mouse' } });
    value.setSelectionRange(0, 5);
    fireEvent.click(p.q('step-var-category')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateStep', index: 0, patch: { value: '{category}' } });
    fireEvent.click(p.q('step-every-page')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateStep', index: 0, patch: { when: 'every-page' } });
    fireEvent.click(p.q('step-optional')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateStep', index: 0, patch: { optional: true } });
    fireEvent.change(p.q('step-kind')!, { target: { value: 'select' } });
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateStep', index: 0, patch: { kind: 'select' } });
  });

  it('shows no value input for a click and the step error inline', () => {
    const p = renderPanel(withSteps([step('click'), step('select', { error: 'step 1 (select) needs a value' })]));
    expect(p.qa('step-value')).toHaveLength(1);
    expect(p.q('step-error')!.textContent).toBe('step 1 (select) needs a value');
  });

  it('replays and removes a step', () => {
    const p = renderPanel(withSteps([step('click'), step('click')]));
    fireEvent.click(p.qa('step-replay')[1]!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.replayStep', index: 1 });
    fireEvent.click(p.qa('step-remove')[0]!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.removeStep', index: 0 });
  });

  it('reorders by drag and by Alt+Up on the focused step', () => {
    const p = renderPanel(withSteps([step('click'), step('wait', { value: '500', target: undefined as never }), step('press', { value: 'Enter' })]));
    const rows = p.qa('step');
    fireEvent.dragStart(rows[2]!);
    fireEvent.dragOver(rows[0]!);
    fireEvent.drop(rows[0]!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.moveStep', from: 2, to: 0 });
    fireEvent.click(rows[1]!);
    expect(p.store.get().ui.focusedStep).toBe(1);
    fireEvent.keyDown(rows[1]!, { key: 'ArrowUp', altKey: true });
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.moveStep', from: 1, to: 0 });
    expect(p.store.get().ui.focusedStep).toBe(0);
  });

  it('warns about a target that matches nothing and re-picks it', () => {
    const p = renderPanel(withSteps([step('click', { count: 0 })]));
    expect(p.q('zero-match')!.textContent).toContain('Matches nothing');
    fireEvent.click(p.q('make-optional')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateStep', index: 0, patch: { optional: true } });
    fireEvent.click(p.q('repick')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.repickTarget', target: 'step', index: 0 });
    expect(p.store.get().ui.picking).toBe(true);
  });

  it('toggles browse mode from the list and with b', () => {
    const p = renderPanel(withSteps([]));
    fireEvent.click(p.q('browse')!);
    expect(p.q('mode')!.dataset.mode).toBe('browsing');
    expect(p.q('steps')!.dataset.browsing).toBe('true');
    fireEvent.click(p.q('browse-stop')!);
    expect(p.q('mode')!.dataset.mode).toBe('idle');
    fireEvent.keyDown(p.q('body')!, { key: 'b' });
    expect(p.store.get().ui.browsing).toBe(true);
    fireEvent.keyDown(p.q('body')!, { key: 'Escape' });
    expect(p.store.get().ui.browsing).toBe(false);
  });
});

describe('record as step', () => {
  it('turns the picked element into a step without acting on it', async () => {
    const { proposed } = await hostStates();
    const p = renderPanel({ ...proposed, proposal: null });
    await act(async () => fireEvent.click(p.q('record-step')!));
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.addStep', step: { kind: 'click' } });
  });

  it('types into text boxes and clicks anything else', () => {
    expect(recordAsStep('input', { type: 'search' })).toEqual({ kind: 'type', value: '' });
    expect(recordAsStep('textarea', {})).toEqual({ kind: 'type', value: '' });
    expect(recordAsStep('input', { type: 'checkbox' })).toEqual({ kind: 'click' });
    expect(recordAsStep('button', {})).toEqual({ kind: 'click' });
  });

  it('summarises a target without a fingerprint by its selector', () => {
    expect(targetSummary(step('press', { target: undefined as never }))).toBe('focused element');
    expect(targetSummary(step('click', { target: { selectors: [{ strategy: 'id', value: 'go', stability: 'stable' }] } }))).toBe('id=go');
  });
});
