// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FocusGuard } from '../src/focus-guard';
import { mount, type Mounted } from '../src/mount';

let mounted: Mounted;
let guard: FocusGuard;
let panelInput: HTMLInputElement;
let q: HTMLInputElement;
let thief: (e: Event) => void;

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const key = (target: EventTarget, k: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, composed: true }));
const pointer = (target: EventTarget) => target.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
const panelFocused = () => mounted.shadows[0]!.activeElement === panelInput;

beforeEach(() => {
  q = document.createElement('input');
  q.id = 'q';
  document.body.appendChild(q);
  mounted = mount(document);
  panelInput = document.createElement('input');
  mounted.panel.appendChild(panelInput);
  guard = new FocusGuard(window, mounted.shadows);
  // A page that steals focus to its search box from a window capture listener.
  thief = () => {
    const tag = document.activeElement?.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') q.focus();
  };
  window.addEventListener('keydown', thief, true);
});

afterEach(() => {
  window.removeEventListener('keydown', thief, true);
  guard.dispose();
  mounted.unmount();
  q.remove();
});

describe('focus guard', () => {
  it('undoes a focus steal from a page keydown handler', async () => {
    panelInput.focus();
    expect(panelFocused()).toBe(true);
    key(panelInput, 'h');
    expect(document.activeElement).toBe(q);
    await tick();
    expect(panelFocused()).toBe(true);
    expect(document.activeElement).toBe(mounted.panelHost);
  });

  it('restores the panel input selection', async () => {
    panelInput.value = 'hello';
    panelInput.focus();
    panelInput.setSelectionRange(1, 3);
    key(panelInput, 'x');
    await tick();
    expect(panelFocused()).toBe(true);
    expect([panelInput.selectionStart, panelInput.selectionEnd]).toEqual([1, 3]);
  });

  it('lets the move stand after a pointer press on the page', async () => {
    panelInput.focus();
    pointer(q);
    q.focus();
    await tick();
    expect(document.activeElement).toBe(q);
  });

  it('lets the move stand after Tab in the panel', async () => {
    panelInput.focus();
    window.removeEventListener('keydown', thief, true);
    key(panelInput, 'Tab');
    q.focus();
    await tick();
    expect(document.activeElement).toBe(q);
  });

  it('takes focus back when the page blurs the panel to the body', async () => {
    panelInput.focus();
    window.removeEventListener('keydown', thief, true);
    const blurrer = () => (document.activeElement as HTMLElement | null)?.blur();
    window.addEventListener('keydown', blurrer, true);
    key(panelInput, 'h');
    await tick();
    window.removeEventListener('keydown', blurrer, true);
    expect(panelFocused()).toBe(true);
  });

  it('does nothing after dispose', async () => {
    panelInput.focus();
    guard.dispose();
    key(panelInput, 'h');
    await tick();
    expect(document.activeElement).toBe(q);
  });
});
