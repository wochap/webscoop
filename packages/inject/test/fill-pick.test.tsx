// @vitest-environment jsdom
import { act, cleanup, fireEvent } from '@testing-library/react';
import type { FillPreview, RecorderState } from '@webscoop/core';
import { afterEach, describe, expect, it } from 'vitest';
import { fillPreview } from '../src/dom';
import { baseState, renderPanel } from './panel';

afterEach(cleanup);

const fp = (tag: string) => ({ tag, textSample: '', attrs: {}, ancestors: [], bbox: { x: 0, y: 0, w: 10, h: 10 } });

function picked(fill: FillPreview | null, tag = 'input'): RecorderState {
  const state = baseState();
  return {
    ...state,
    selected: {
      selection: {
        path: [1, 0],
        tag,
        text: '',
        attrs: {},
        candidates: [{ strategy: 'css', value: tag, stability: 'medium', count: 1 }],
        fingerprint: fp(tag),
        ancestors: [{ label: 'body', path: [1] }],
        containerPath: null,
        framePath: null,
        frame: null,
        fill,
      },
      scope: 'page',
      defaults: { name: 'email', type: 'text', table: 0 },
      primary: 0,
      table: 0,
      suggestion: null,
      outside: null,
      belongs: null,
      frameRefusal: null,
    },
  };
}

describe('fill picks', () => {
  it('prefills a text input and adds a literal fill, or a variable', () => {
    const p = renderPanel(picked({ kind: 'text', value: 'dev@example.test', hint: 'Work email', password: false }));
    expect((p.q('pick-fill-value') as HTMLInputElement).value).toBe('dev@example.test');
    expect(p.q('pick-fill-kinds')!.textContent).toContain('OTP boxes');
    act(() => fireEvent.click(p.q('pick-as-fill')!));
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.addStep', step: { kind: 'fill', value: 'dev@example.test' } });
    act(() => fireEvent.click(p.q('pick-fill-make-var')!));
    expect((p.q('pick-fill-var-name') as HTMLInputElement).value).toBe('work_email');
    act(() => fireEvent.click(p.q('pick-as-fill')!));
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.addStep', step: { kind: 'fill', value: 'dev@example.test', variable: { name: 'work_email' } } });
  });

  it('turns a password into a secret variable and a file input into a path variable', () => {
    const p = renderPanel(picked({ kind: 'text', value: 'hunter2', hint: 'Password', password: true }));
    expect(p.q('pick-fill-var')!.textContent).toBe('{password}');
    expect(p.q('pick-fill')!.textContent).not.toContain('hunter2');
    expect(p.q('pick-fill-note')!.textContent).toContain('never saved');
    act(() => fireEvent.click(p.q('pick-as-fill')!));
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.addStep', step: { kind: 'fill', value: 'hunter2', variable: { name: 'Password', secret: true } } });
    cleanup();
    const f = renderPanel(picked({ kind: 'file', value: '', hint: 'video', password: false }));
    expect(f.q('pick-fill-var')!.textContent).toBe('{video}');
    act(() => fireEvent.click(f.q('pick-as-fill')!));
    expect(f.sent.at(-1)).toEqual({ kind: 'draft.addStep', step: { kind: 'fill', variable: { name: 'video', type: 'path' } } });
  });

  it('offers no fill for an element a fill cannot set', () => {
    const p = renderPanel(picked(null, 'a'));
    expect(p.q('pick-fill')).toBeNull();
  });
});

describe('fillPreview', () => {
  it('reads kind, value, and a name hint from the live element', () => {
    document.body.innerHTML = `
      <label for="e">Work email</label><input id="e" type="email" value="dev@example.test">
      <input type="password" name="pass" value="x">
      <input type="checkbox" id="terms" checked>
      <input type="file" name="video">
      <a href="#">x</a>`;
    expect(fillPreview(document.getElementById('e')!)).toEqual({ kind: 'text', value: 'dev@example.test', hint: 'Work email', password: false });
    expect(fillPreview(document.querySelector('[type=password]')!)).toEqual({ kind: 'text', value: 'x', hint: 'pass', password: true });
    expect(fillPreview(document.getElementById('terms')!)).toMatchObject({ kind: 'toggle', value: 'true', hint: 'terms' });
    expect(fillPreview(document.querySelector('[type=file]')!)).toMatchObject({ kind: 'file', value: '', hint: 'video' });
    expect(fillPreview(document.querySelector('a')!)).toBeNull();
  });
});
