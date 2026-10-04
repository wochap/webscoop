// @vitest-environment jsdom
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { validateDraft, type Draft, type DraftFlow, type DraftStep } from '@webscoop/core';
import { handleKey, recordAsStep } from '../src/ui/App';
import { flowsSummary, targetSummary } from '../src/ui/flows';
import { baseState, newDraft, renderPanel, withTable } from './panel';

afterEach(cleanup);

const field = { name: 'title', type: 'text' as const, scope: 'page' as const, selectors: [{ strategy: 'css' as const, value: 'h1', stability: 'medium' as const, count: 1 }], optional: false, key: false, count: 1, sample: 'x' };
const fp = (tag: string, extra: object = {}) => ({ tag, textSample: '', attrs: {}, ancestors: [], bbox: { x: 0, y: 0, w: 1, h: 1 }, ...extra });
const accept = { selectors: [{ strategy: 'role' as const, value: 'button|Accept all', stability: 'stable' as const, count: 1 }], fingerprint: fp('button', { role: 'button', name: 'Accept all' }) };

const step = (kind: DraftStep['kind'], extra: Partial<DraftStep> = {}): DraftStep => ({ kind, target: accept, window: 'same', optional: false, count: 1, ...extra });

function withFlows(flows: DraftFlow[], extra: Partial<Draft> = {}): Draft {
  return validateDraft({ ...withTable(newDraft(), { fields: [field] }), flows, activeFlow: flows.length > 0 ? 0 : null, ...extra });
}

const setup = (steps: DraftStep[] = [step('click')]): DraftFlow => ({ name: 'setup', steps });
const loginWall: DraftFlow = { name: 'login-wall', trigger: { selectors: [{ strategy: 'role', value: 'button|Log in', stability: 'stable', count: 1 }] }, steps: [step('click')] };

/** Gives rows a vertical layout of 40px tall rows for drag tests. */
function stack(rows: HTMLElement[]) {
  rows.forEach((r, i) => (r.getBoundingClientRect = () => ({ left: 0, top: i * 40, width: 200, height: 40, right: 200, bottom: i * 40 + 40, x: 0, y: i * 40, toJSON: () => ({}) })));
}

describe('flows section', () => {
  it('drags a step into the gap the line shows, and ignores a step of another flow', () => {
    const steps = [step('click'), step('fill', { value: 'x' }), step('press', { value: 'Enter' })];
    const p = renderPanel(baseState(withFlows([setup(steps), { ...loginWall, steps: [step('click')] }])), { openFlows: ['login-wall'] });
    const rows = p.qa('step');
    expect(rows.map((r) => r.dataset.kind)).toEqual(['click', 'fill', 'press', 'click']);
    stack(rows);
    fireEvent.dragStart(rows[2]!);
    fireEvent.dragOver(rows[0]!, { clientY: 10 });
    expect(rows[0]!.className).toContain('ws-drop-before');
    fireEvent.drop(rows[0]!, { clientY: 10 });
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.moveStep', flow: 0, from: 2, to: 0 });

    const before = p.sent.length;
    fireEvent.dragStart(rows[3]!);
    fireEvent.dragOver(rows[0]!, { clientY: 10 });
    expect(p.container.querySelectorAll('.ws-drop-before, .ws-drop-after')).toHaveLength(0);
    fireEvent.drop(rows[0]!, { clientY: 10 });
    expect(p.sent).toHaveLength(before);
    fireEvent.dragEnd(rows[3]!);
  });

  it('groups called and reactive flows, marks the active one, and counts flows and steps in the footer', () => {
    const p = renderPanel(baseState(withFlows([setup([step('click'), step('fill', { value: 'mouse', target: { selectors: [{ strategy: 'css', value: 'input', stability: 'medium' }] } })]), loginWall])));
    expect(p.qa('flow').map((f) => [f.dataset.name, f.dataset.kind, f.dataset.active ?? ''])).toEqual([
      ['setup', 'called', 'true'],
      ['login-wall', 'reactive', ''],
    ]);
    expect(p.q('flows-called')).not.toBeNull();
    expect(p.q('flows-reactive')).not.toBeNull();
    expect(p.q('flow-trigger')).not.toBeNull();
    expect(p.q('flows-into')!.textContent).toContain('setup');
    expect(p.qa('step').map((r) => r.dataset.kind)).toEqual(['click', 'fill']);
    expect(p.qa('step-target').map((t) => t.title)).toEqual(['button "Accept all"', 'css=input']);
    expect(p.q('footer-count')!.textContent).toBe('1 table · 1 field · 2 flows · 3 steps');
    expect(p.q('section-flows')!.querySelector('[data-ws="section-count"]')!.textContent).toBe('2');
  });

  it('collapses to the active flow and the counts of each kind', () => {
    const draft = withFlows([setup(), loginWall]);
    expect(flowsSummary(draft)).toBe('into setup · 1 called · 1 reactive');
    const p = renderPanel({ ...baseState(draft), panel: { collapsed: { recipe: false, flows: true, sequence: true } } });
    expect(p.q('flows-summary')!.textContent).toBe('into setup · 1 called · 1 reactive');
    fireEvent.click(p.q('section-flows')!.querySelector('[data-ws="section-toggle"]')!);
    expect(p.sent).toEqual([{ kind: 'panel.setCollapsed', section: 'flows', collapsed: false }]);
  });

  it('shows the value, the popup window badge, the frame badge, and the optional marker on step rows', () => {
    const frame = { selectors: [{ strategy: 'id' as const, value: 'address-frame', stability: 'stable' as const }] };
    const p = renderPanel(
      baseState(withFlows([setup([step('fill', { value: '{category}', window: 'popup' }), step('press', { value: 'Enter', optional: true, target: { ...accept, frame } })])])),
    );
    expect(p.q('step-value-text')!.textContent).toBe('{category}');
    expect(p.qa('step-window-badge')).toHaveLength(1);
    expect(p.qa('frame-badge')).toHaveLength(1);
    expect(p.qa('step-optional-marker')).toHaveLength(1);
  });

  it('edits a step: value with a variable chip, window, optional, and re-pick', () => {
    const p = renderPanel(baseState(withFlows([setup([step('fill', { value: 'mo' })])])));
    fireEvent.click(p.q('step-edit-toggle')!);
    expect(p.q('step-edit')).not.toBeNull();
    const value = p.q('step-value') as HTMLInputElement;
    fireEvent.change(value, { target: { value: 'mouse' } });
    fireEvent.blur(value);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateStep', flow: 0, index: 0, patch: { value: 'mouse' } });
    value.setSelectionRange(0, 5);
    fireEvent.click(p.q('step-var-category')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateStep', flow: 0, index: 0, patch: { value: '{category}' } });
    fireEvent.click(p.q('step-window-popup')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateStep', flow: 0, index: 0, patch: { window: 'popup' } });
    fireEvent.click(p.q('step-optional')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateStep', flow: 0, index: 0, patch: { optional: true } });
    fireEvent.click(p.q('step-target-edit-repick')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'target.edit.start', ref: { kind: 'step', flow: 0, index: 0 }, mode: 'pick' });
  });

  it('shows download steps like click steps, with the file name as the editable value', () => {
    const p = renderPanel(baseState(withFlows([setup([step('download', { value: 'report.pdf' }), step('download', { target: undefined })])])));
    expect(p.qa('step').map((r) => r.dataset.kind)).toEqual(['download', 'download']);
    expect(p.qa('step-target').map((t) => t.title)).toEqual(['button "Accept all"', 'next download']);
    expect(p.q('step-value-text')!.textContent).toBe('report.pdf');
    fireEvent.click(p.qa('step-edit-toggle')[0]!);
    const value = p.q('step-value') as HTMLInputElement;
    expect(value.placeholder).toContain('File name');
    fireEvent.change(value, { target: { value: '{category}.pdf' } });
    fireEvent.blur(value);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateStep', flow: 0, index: 0, patch: { value: '{category}.pdf' } });
    expect(p.q('step-var-category')).not.toBeNull();
    fireEvent.click(p.q('step-target-edit-repick')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'target.edit.start', ref: { kind: 'step', flow: 0, index: 0 }, mode: 'pick' });
  });

  it('turns a literal fill value into a variable', async () => {
    const p = renderPanel(baseState(withFlows([setup([step('fill', { value: 'Example GmbH', label: 'company' })])])));
    fireEvent.click(p.q('step-edit-toggle')!);
    fireEvent.click(p.q('step-make-variable')!);
    await Promise.resolve();
    await Promise.resolve();
    expect(p.sent.slice(-2)).toEqual([
      { kind: 'draft.updateStep', flow: 0, index: 0, patch: { value: '{company}' } },
      { kind: 'draft.setVar', name: 'company', value: 'Example GmbH' },
    ]);
  });

  it('edits an await-user step: label, until, and a timeout override shown as the guard budget by default', () => {
    const p = renderPanel(baseState(withFlows([setup([step('await-user', { until: 'disappears' })])])));
    expect(p.q('step-until')!.textContent).toContain('until disappears');
    fireEvent.click(p.q('step-edit-toggle')!);
    expect(p.q('step-timeout-budget')!.textContent).toBe('guard budget');
    const label = p.q('step-label') as HTMLInputElement;
    fireEvent.change(label, { target: { value: 'Log in to the portal' } });
    fireEvent.blur(label);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateStep', flow: 0, index: 0, patch: { label: 'Log in to the portal' } });
    fireEvent.click(p.q('step-until-appears')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateStep', flow: 0, index: 0, patch: { until: 'appears' } });
    fireEvent.click(p.q('step-timeout-override')!);
    const timeout = p.q('step-timeout') as HTMLInputElement;
    fireEvent.change(timeout, { target: { value: '90' } });
    fireEvent.blur(timeout);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateStep', flow: 0, index: 0, patch: { timeoutMs: 90_000 } });
  });

  it('replays and removes a step, and replays a flow', () => {
    const p = renderPanel(baseState(withFlows([setup([step('click'), step('click')])])));
    fireEvent.click(p.qa('step-replay')[1]!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.replayStep', flow: 0, index: 1 });
    fireEvent.click(p.qa('step-remove')[0]!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.removeStep', flow: 0, index: 0 });
    fireEvent.click(p.q('flow-replay')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.replayFlow', index: 0 });
  });

  it('reorders steps by Alt+Up on the focused step', () => {
    const p = renderPanel(baseState(withFlows([setup([step('click'), step('press', { value: 'Enter' })])])));
    fireEvent.click(p.qa('step')[1]!);
    expect(p.store.get().ui.focusedStep).toEqual({ flow: 0, index: 1 });
    expect(handleKey({ key: 'ArrowUp', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }, null, p.store.get(), p.actions)).toBe(true);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.moveStep', flow: 0, from: 1, to: 0 });
  });

  it('opens the flow menu: rename, make reactive, duplicate, retries and recover, delete', () => {
    const p = renderPanel(baseState(withFlows([setup(), loginWall])));
    fireEvent.click(p.qa('flow-menu-toggle')[1]!);
    expect(p.q('flow-retries')!.textContent).toBe('2');
    fireEvent.click(p.q('flow-menu-retries')!.querySelector('[aria-label="More retries"]')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateFlow', index: 1, patch: { maxRetries: 3 } });
    fireEvent.click(p.q('flow-recover')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateFlow', index: 1, patch: { recover: true } });
    fireEvent.click(p.q('flow-menu-called')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateFlow', index: 1, patch: { trigger: null } });
    fireEvent.click(p.qa('flow-menu-toggle')[0]!);
    expect(p.q('flow-menu-retries')).toBeNull();
    fireEvent.click(p.q('flow-menu-duplicate')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.duplicateFlow', index: 0 });
    fireEvent.click(p.qa('flow-menu-toggle')[0]!);
    fireEvent.click(p.q('flow-menu-reactive')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.pickTrigger', index: 0 });
    expect(p.q('trigger-editor')!.textContent).toContain('before each step, before extraction, and every second while waiting');
    fireEvent.click(p.qa('flow-menu-toggle')[0]!);
    fireEvent.click(p.q('flow-menu-delete')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.removeFlow', index: 0 });
  });

  it('renames a flow inline', () => {
    const p = renderPanel(baseState(withFlows([setup()])));
    fireEvent.click(p.q('flow-menu-toggle')!);
    fireEvent.click(p.q('flow-menu-rename')!);
    const input = p.q('flow-rename') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'consent' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateFlow', index: 0, patch: { name: 'consent' } });
  });

  it('switches the active flow with Alt+F and a digit, and creates one from the switcher', () => {
    const p = renderPanel(baseState(withFlows([setup(), { name: 'search', steps: [step('click')] }, loginWall])));
    const key = (k: string, alt = false) => {
      let ran = false;
      act(() => void (ran = handleKey({ key: k, altKey: alt, ctrlKey: false, metaKey: false, shiftKey: false }, null, p.store.get(), p.actions)));
      return ran;
    };
    expect(key('f', true)).toBe(true);
    expect(p.qa('flow-switcher-item').map((i) => i.dataset.name)).toEqual(['setup', 'search', 'login-wall']);
    expect(key('2')).toBe(true);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.selectFlow', index: 1 });
    expect(p.q('flow-switcher')).toBeNull();
    key('f', true);
    fireEvent.click(p.q('flow-switcher-new')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.addFlow' });
  });

  it('adds a flow, and activates a flow from its dot', () => {
    const p = renderPanel(baseState(withFlows([setup(), loginWall])));
    fireEvent.click(p.q('flows-add')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.addFlow' });
    fireEvent.click(p.qa('flow-activate')[1]!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.selectFlow', index: 1 });
  });

  it('describes targets for the step list', () => {
    expect(targetSummary(step('click'))).toBe('button "Accept all"');
    expect(targetSummary({ kind: 'press', target: undefined })).toBe('focused element');
  });

  it('records a picked form field as a fill with its value, anything else as a click', () => {
    expect(recordAsStep('input', { type: 'text', value: 'mouse' })).toEqual({ kind: 'fill', value: 'mouse' });
    expect(recordAsStep('select', {})).toEqual({ kind: 'fill', value: '' });
    expect(recordAsStep('div', { contenteditable: 'true' })).toEqual({ kind: 'fill', value: '' });
    expect(recordAsStep('button', {})).toEqual({ kind: 'click' });
  });
});
