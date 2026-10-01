// @vitest-environment jsdom
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DraftStep, FrameTarget, RecorderState } from '@webscoop/core/page';
import { baseState, newDraft, renderPanel, withTable } from './panel';

afterEach(cleanup);

const fp = (tag: string) => ({ tag, textSample: '', attrs: {}, ancestors: [], bbox: { x: 0, y: 0, w: 1, h: 1 } });
const frame: FrameTarget = {
  selectors: [
    { strategy: 'id', value: 'app', stability: 'stable', count: 1 },
    { strategy: 'css', value: 'iframe.app-frame', stability: 'medium', count: 1 },
  ],
  fingerprint: fp('iframe'),
};
const field = { name: 'title', type: 'text' as const, scope: 'page' as const, selectors: [{ strategy: 'css' as const, value: 'h1', stability: 'medium' as const, count: 1 }], optional: false, key: false, count: 1, sample: 'x' };
const step: DraftStep = { kind: 'click', target: { selectors: [{ strategy: 'id', value: 'go', stability: 'stable', count: 1 }], frame }, when: 'first-page', optional: false, count: 1 };

function selectedIn(state: RecorderState, frameRefusal: string | null = null): RecorderState {
  return {
    ...state,
    selected: {
      selection: {
        path: [1, 0],
        tag: 'h2',
        text: 'Inner',
        attrs: {},
        candidates: [{ strategy: 'css', value: 'h2', stability: 'medium', count: 1 }],
        fingerprint: fp('h2'),
        ancestors: [{ label: 'body', path: [1] }],
        containerPath: null,
        framePath: [1, 2],
        frame,
      },
      scope: 'page',
      defaults: { name: 'title2', type: 'text', table: 0 },
      primary: 0,
      table: 0,
      suggestion: null,
      outside: null,
      belongs: null,
      frameRefusal,
    },
  };
}

describe('frames in the panel', () => {
  it('says a pick is inside an iframe, shows its frame target, and edits it in the frame editor', () => {
    const p = renderPanel(selectedIn(baseState()));
    expect(p.q('pick-frame')!.dataset.frame).toBe('iframe#app');
    expect(p.q('pick-frame')!.textContent).toContain('Inside iframe');
    expect(p.q('pick-frame-count')!.textContent).toBe('1');
    act(() => fireEvent.click(p.q('pick-frame-edit')!));
    const editor = p.q('frame-editor')!;
    expect(editor.textContent).toContain('Frame target');
    const rows = Array.from(editor.querySelectorAll('[data-ws="pick-candidate"]'));
    expect(rows).toHaveLength(2);
    act(() => fireEvent.click(rows[1]!));
    expect(p.sent.at(-1)).toEqual({ kind: 'frame.edit', key: { strategy: 'id', value: 'app', stability: 'stable' }, by: 'primary', index: 1 });
    act(() => fireEvent.click(p.q('frame-editor-cancel')!));
    expect(p.q('frame-editor')).toBeNull();
  });

  it('disables Add field with the reason when the table reads from another frame', () => {
    const p = renderPanel(selectedIn(baseState(withTable(newDraft(), { fields: [field] })), 'the items table reads from the page, not from an iframe'));
    expect((p.q('pick-add-field') as HTMLButtonElement).disabled).toBe(true);
    expect(p.q('pick-add-hint')!.textContent).toBe('The items table reads from the page, not from an iframe.');
  });

  it('marks fields of a framed table and framed steps with a frame badge that opens the editor', () => {
    const p = renderPanel(baseState({ ...withTable(newDraft(), { fields: [field], frame }), steps: [step] }));
    const badges = p.qa('frame-badge');
    expect(badges).toHaveLength(2);
    expect(badges.every((b) => b.textContent === 'iframe#app')).toBe(true);
    act(() => fireEvent.click(badges[0]!));
    expect(p.q('frame-editor')).not.toBeNull();
    const input = p.q('frame-selector') as HTMLInputElement;
    act(() => fireEvent.change(input, { target: { value: 'iframe[name=app]' } }));
    act(() => fireEvent.click(p.q('frame-selector-go')!));
    expect(p.sent.at(-1)).toMatchObject({ kind: 'frame.edit', key: { strategy: 'id', value: 'app' }, by: 'selector' });
  });
});
