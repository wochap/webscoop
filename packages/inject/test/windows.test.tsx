// @vitest-environment jsdom
import { cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { validateDraft } from '@webscoop/core';
import { Overlay } from '../src/overlay';
import { layoutFor, Runtime } from '../src/runtime';
import { Store, initialUi } from '../src/store';
import { baseState, newDraft, renderPanel } from './panel';

afterEach(cleanup);

const flow = { name: 'login-wall', steps: [{ kind: 'click' as const, window: 'same' as const, optional: false, count: null }] };

describe('window modes', () => {
  it('shows the rail in a main window and the strip in a popup that do not own the panel; pressing them takes it', () => {
    const rail = renderPanel(baseState(), { panelMode: 'rail' });
    expect(rail.q('panel-rail')!.textContent).toContain('Panel active in another window');
    expect(rail.q('section-recipe')).toBeNull();
    fireEvent.click(rail.q('panel-rail')!);
    expect(rail.sent).toEqual([{ kind: 'window.activity' }]);
    cleanup();
    const strip = renderPanel(baseState(), { panelMode: 'strip', popup: true });
    expect(strip.q('panel-strip')!.textContent).toContain('Panel is active in the main window.');
    fireEvent.click(strip.q('panel-strip')!);
    expect(strip.sent).toEqual([{ kind: 'window.activity' }]);
  });

  it('shows the compact bar in a narrow owner window, and the sheet with the flows and Pick and Browse', () => {
    const draft = validateDraft({ ...newDraft(), flows: [flow], activeFlow: 0 });
    const p = renderPanel(baseState(draft), { narrow: true });
    expect(p.q('panel-bar')!.textContent).toContain('into login-wall · 1 step');
    expect(p.q('section-recipe')).toBeNull();
    fireEvent.click(p.q('bar-panel')!);
    expect(p.q('panel-sheet')).not.toBeNull();
    expect(p.q('section-flows')).not.toBeNull();
    fireEvent.click(p.q('sheet-browse')!);
    expect(p.store.get().ui.browsing).toBe(true);
    fireEvent.click(p.q('sheet-pick')!);
    expect(p.store.get().ui.picking).toBe(true);
  });

  it('lays the page out by mode: panel, rail, strip, bar, or nothing for a guard in a narrow window', () => {
    const host = baseState();
    expect(layoutFor({ host, ui: initialUi })).toBe('panel');
    expect(layoutFor({ host, ui: { ...initialUi, panelMode: 'rail' } })).toBe('rail');
    expect(layoutFor({ host, ui: { ...initialUi, panelMode: 'strip' } })).toBe('strip');
    expect(layoutFor({ host, ui: { ...initialUi, narrow: true } })).toBe('bar');
    expect(layoutFor({ host: { ...host, guardContext: { kind: 'await-user', reason: 'x', page: 1, url: 'u', deadline: 0 } }, ui: { ...initialUi, narrow: true } })).toBe('none');
  });

  it('applies panel.mode from the host, and asks to own the panel on a real press while it does not', () => {
    const win = window;
    const layouts: string[] = [];
    const sent: unknown[] = [];
    (win as unknown as Record<string, unknown>).__webscoopHost = async (msg: unknown) => {
      sent.push(msg);
      return { kind: 'panel.mode', mode: 'rail', popup: false };
    };
    const overlay = new Overlay(document.createElement('div'));
    const runtime = new Runtime({ win, store: new Store(), overlay, setLayout: (l) => layouts.push(l) });
    try {
      runtime.dispatch({ kind: 'panel.mode', mode: 'rail', popup: false });
      expect(runtime.store.get().ui.panelMode).toBe('rail');
      expect(layouts.at(-1)).toBe('rail');
      // jsdom events are untrusted, like synthetic page events: they never move the panel.
      win.dispatchEvent(new win.MouseEvent('pointerdown'));
      expect(sent).toEqual([]);
      runtime.dispatch({ kind: 'draft.state', state: baseState() });
      expect(runtime.store.get().ui.panelMode).toBe('owner');
      expect(layouts.at(-1)).toBe('panel');
    } finally {
      runtime.dispose();
      overlay.dispose();
      delete (win as unknown as Record<string, unknown>).__webscoopHost;
    }
  });
});
