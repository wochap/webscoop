// @vitest-environment jsdom
import { cleanup, fireEvent } from '@testing-library/react';
import { dataset, render } from '@webscoop/playground';
import { draftFromRecipe, fingerprint, type RecorderState, type RepickContext } from '@webscoop/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintedRecipe, tier0Nodes } from '../../core/test/healing-helpers';
import { shortcutFor } from '../src/keyboard';
import { Overlay } from '../src/overlay';
import { Runtime } from '../src/runtime';
import { baseState, renderPanel } from './panel';

afterEach(cleanup);

function repickState(extra: Partial<RepickContext> = {}): RecorderState {
  const draft = draftFromRecipe(fingerprintedRecipe());
  const price = draft.tables[0]!.fields[1]!;
  return {
    ...baseState(draft),
    repick: 1,
    repickContext: {
      table: 'items',
      field: 'price',
      index: 1,
      oldSelector: { strategy: 'testid', value: 'price', stability: 'stable' },
      fingerprint: price.fingerprint!,
      sample: '$24.99',
      threshold: 0.7,
      reason: 'run',
      picked: null,
      ...extra,
    },
  };
}

describe('re-pick panel', () => {
  it('renders the field, its old selector, sample, and fingerprint, with a live score bar', () => {
    const p = renderPanel(repickState(), { hoverScore: 0.83 });
    expect(p.q('mode')!.dataset.mode).toBe('repick');
    expect(p.q('repick-prompt')!.textContent).toContain('Click the new location of price');
    expect(p.q('old-selector')!.textContent).toBe('testid=price');
    expect(p.q('old-sample')!.textContent).toBe('$24.99');
    expect(p.q('fp-tag')!.textContent).toBe('p · paragraph');
    expect(p.q('fp-text')!.textContent).toBe('$24.99');
    expect(p.q('fp-ancestors')!.textContent).toBe('html › body › main › list › listitem › article');
    expect(p.q('score-value')!.textContent).toBe('0.83');
    expect(p.q('score')!.dataset.likely).toBe('true');
    expect(p.q('likely')).not.toBeNull();
    expect(p.q('fields')).toBeNull();
    expect(p.q('save')).toBeNull();
    expect((p.q('repick-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not mark scores below the threshold as likely', () => {
    const p = renderPanel(repickState(), { hoverScore: 0.52 });
    expect(p.q('score')!.dataset.likely).toBe('false');
    expect(p.q('likely')).toBeNull();
  });

  it('shows the pick waiting for confirmation and confirms it', () => {
    const p = renderPanel(repickState({ picked: { score: 0.91, sample: '24.99', selector: { strategy: 'css', value: 'p.x1', stability: 'medium' } } }));
    expect(p.q('picked-selector')!.textContent).toBe('css=p.x1');
    expect(p.q('picked-sample')!.textContent).toBe('24.99');
    fireEvent.click(p.q('repick-confirm')!);
    expect(p.sent).toEqual([{ kind: 'repick.confirm' }]);
  });

  it('emits skip and abort from the buttons and from s and Esc', () => {
    const p = renderPanel(repickState());
    fireEvent.click(p.q('repick-skip')!);
    fireEvent.click(p.q('repick-abort')!);
    fireEvent.keyDown(p.q('body')!, { key: 's' });
    fireEvent.keyDown(p.q('body')!, { key: 'Escape' });
    expect(p.sent).toEqual([{ kind: 'repick.skip' }, { kind: 'repick.abort' }, { kind: 'repick.skip' }, { kind: 'repick.abort' }]);
  });

  it('says so when the field has no fingerprint', () => {
    const p = renderPanel(repickState({ fingerprint: null }));
    expect(p.q('no-fingerprint')).not.toBeNull();
    expect(p.q('score')).toBeNull();
  });

  it('maps s and Esc only while re-picking; Esc stops picking first', () => {
    const base = { typing: false, picking: false, menuOpen: false, hasProposal: false, hasSelection: false, focusedField: null };
    const key = (k: string) => ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false });
    expect(shortcutFor(key('s'), { ...base, repicking: true })).toBe('skip');
    expect(shortcutFor(key('s'), { ...base, repicking: true, picking: true })).toBe('skip');
    expect(shortcutFor(key('Escape'), { ...base, repicking: true })).toBe('abort');
    expect(shortcutFor(key('Escape'), { ...base, repicking: true, picking: true })).toBe('cancel');
    expect(shortcutFor(key('s'), base)).toBeNull();
    expect(shortcutFor(key('Escape'), base)).toBeNull();
    expect(shortcutFor(key('s'), { ...base, repicking: true, typing: true })).toBeNull();
  });
});

describe('hover score while re-picking', () => {
  beforeEach(() => {
    const html = render(dataset, { tier: 0, seed: 1 });
    document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/, '').replace(/<\/html>\s*$/, '');
  });

  it('appends the fingerprint score to the overlay tag and marks likely matches', () => {
    const layer = document.createElement('div');
    document.body.appendChild(layer);
    const overlay = new Overlay(layer);
    const runtime = new Runtime({ win: window, overlay });
    runtime.store.setHost(repickState({ fingerprint: fingerprint(tier0Nodes().price!) }));

    runtime.hover(document.querySelectorAll('p.product-price')[3]!);
    const score = runtime.store.get().ui.hoverScore!;
    expect(score).toBeGreaterThanOrEqual(0.7);
    expect(overlay.tagMarkup).toContain(`<em class="ws-score ws-likely">${score.toFixed(2)} likely</em>`);

    runtime.hover(document.querySelectorAll('h2.product-title')[0]!);
    expect(runtime.store.get().ui.hoverScore!).toBeLessThan(0.7);
    expect(overlay.tagMarkup).toMatch(/<em class="ws-score">0\.\d\d<\/em>$/);

    runtime.store.setHost({ ...repickState(), repick: null, repickContext: null });
    runtime.hover(document.querySelectorAll('p.product-price')[1]!);
    expect(overlay.tagMarkup).not.toContain('ws-score');
    runtime.dispose();
    overlay.dispose();
  });
});
