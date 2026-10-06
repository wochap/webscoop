// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { GuardContextView, RecorderState } from '@webscoop/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleKey } from '../src/ui/App';
import { Countdown, formatCountdown, WARN_UNDER_MS } from '../src/ui/guard';
import { baseState, renderPanel } from './panel';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = 1_700_000_000_000;
const ctx = (extra: Partial<GuardContextView> = {}): GuardContextView => ({
  kind: 'login',
  reason: 'redirected to a login page (/login)',
  page: 2,
  url: 'http://127.0.0.1:4777/login?next=%2Fcatalog',
  deadline: NOW + 5 * 60_000,
  ...extra,
});
const guardState = (extra: Partial<GuardContextView> = {}): RecorderState => ({ ...baseState(), guardContext: ctx(extra) });

describe('guard banner', () => {
  it('formats the countdown as m:ss and never below zero', () => {
    expect(formatCountdown(600_000)).toBe('10:00');
    expect(formatCountdown(89_001)).toBe('1:30');
    expect(formatCountdown(-5)).toBe('0:00');
  });

  it('renders the kind, reason, page, and countdown outside the sidebar body', () => {
    vi.useFakeTimers({ now: NOW });
    const p = renderPanel(guardState());
    expect(p.q('panel-mode')!.dataset.mode).toBe('guard');
    const banner = p.q('guard-banner')!;
    expect(banner.id).toBe('ws-guard');
    expect(p.q('panel-body')!.contains(banner)).toBe(false);
    expect(banner.dataset.kind).toBe('login');
    expect(p.q('guard-kind')!.textContent).toBe('Login required');
    expect(p.q('guard-reason')!.textContent).toBe('Page 2: redirected to a login page (/login)');
    expect(p.q('guard-countdown')!.textContent).toBe('5:00');
    expect(p.q('guard-countdown')!.dataset.tone).toBe('neutral');
    expect(p.q('guard-panel')).not.toBeNull();
    expect(p.q('fields')).toBeNull();
    expect(p.q('footer-save')).toBeNull();
  });

  it('switches the countdown to the warning tone under 90 seconds as time passes', () => {
    vi.useFakeTimers({ now: NOW });
    const { container } = render(<Countdown deadline={NOW + WARN_UNDER_MS + 2_000} />);
    const el = () => container.querySelector('[data-ws="guard-countdown"]') as HTMLElement;
    expect(el().dataset.tone).toBe('neutral');
    expect(el().textContent).toBe('1:32');
    act(() => void vi.advanceTimersByTime(3_000));
    expect(el().dataset.tone).toBe('warn');
    expect(el().className).toContain('ws-tone-warn');
    expect(el().textContent).toBe('1:29');
  });

  it('emits guard.continue and guard.abort from its buttons', () => {
    const p = renderPanel(guardState());
    fireEvent.click(p.q('guard-continue')!);
    fireEvent.click(p.q('guard-abort')!);
    expect(p.sent).toEqual([{ kind: 'guard.continue' }, { kind: 'guard.abort' }]);
  });

  it('leaves every key to the page while paused', () => {
    const p = renderPanel(guardState());
    expect(handleKey({ key: 'p' } as KeyboardEvent, null, p.store.get(), p.actions)).toBe(false);
    expect(p.store.get().ui.picking).toBe(false);
  });
});

describe('await-user banner', () => {
  it("shows the step's label and the await-user badge, with Continue and Abort", () => {
    vi.useFakeTimers({ now: NOW });
    const p = renderPanel(guardState({ kind: 'await-user', label: 'Log in to SOL', reason: 'waiting for you: Log in to SOL' }));
    expect(p.q('guard-banner')!.dataset.kind).toBe('await-user');
    expect(p.q('guard-kind')!.textContent).toBe('await-user');
    expect(p.q('guard-reason')!.textContent).toBe('Log in to SOL');
    expect(p.q('guard-panel')!.textContent).toContain('Waiting for you');
    fireEvent.click(p.q('guard-continue')!);
    expect(p.sent).toEqual([{ kind: 'guard.continue' }]);
  });

  it('shows only the banner, across the top, in a narrow window', () => {
    vi.useFakeTimers({ now: NOW });
    const p = renderPanel(guardState({ kind: 'await-user', label: 'Log in to SOL' }), { narrow: true });
    expect(p.q('guard-banner')).not.toBeNull();
    expect(p.q('guard-panel')).toBeNull();
  });

  it('names the condition with the target as the selector chip writes it', () => {
    const disappears = renderPanel(guardState({ kind: 'await-user', label: 'Log in to SOL', until: 'disappears', target: { strategy: 'role', value: 'button|Log in' } }));
    expect(disappears.q('guard-hint')!.textContent).toBe('Continues when button "Log in" disappears.');
    expect(disappears.q('guard-hint')!.title).toBe('Continues when button "Log in" disappears.');
    cleanup();
    const appears = renderPanel(guardState({ kind: 'await-user', label: 'Wait', until: 'appears', target: { strategy: 'css', value: '#dashboard' } }));
    expect(appears.q('guard-hint')!.textContent).toBe('Continues when #dashboard appears.');
  });

  it('keeps the generic hint without a target', () => {
    const p = renderPanel(guardState({ kind: 'await-user', label: 'Log in to SOL' }));
    expect(p.q('guard-hint')!.textContent).toBe('Do this in the browser; the run continues by itself once it is done.');
  });
});
