// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Overlay } from '../src/overlay';
import { Runtime } from '../src/runtime';
import { revealInBody } from '../src/ui/reveal';
import { baseState } from './panel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function bodyWithCard(cardTop: number, cardHeight: number, scrollTop = 500) {
  const body = document.createElement('div');
  body.className = 'ws-body';
  const card = document.createElement('section');
  body.appendChild(card);
  document.body.appendChild(body);
  body.scrollTop = scrollTop;
  const rect = (top: number, height: number) => ({ top, bottom: top + height, height }) as DOMRect;
  vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(rect(100, 400));
  vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(rect(cardTop, cardHeight));
  return { body, card };
}

describe('revealInBody', () => {
  it('leaves a fully visible card alone', () => {
    const { body, card } = bodyWithCard(150, 100);
    revealInBody(card);
    expect(body.scrollTop).toBe(500);
  });

  it('aligns a card above the view to the top', () => {
    const { body, card } = bodyWithCard(-200, 100);
    revealInBody(card);
    expect(body.scrollTop).toBe(200);
  });

  it('aligns a card below the view to the bottom', () => {
    const { body, card } = bodyWithCard(450, 100);
    revealInBody(card);
    expect(body.scrollTop).toBe(550);
  });

  it('aligns a card taller than the body to the top', () => {
    const { body, card } = bodyWithCard(450, 600);
    revealInBody(card);
    expect(body.scrollTop).toBe(850);
  });
});

describe('pick signal', () => {
  it('counts page picks, not selections made from the panel', async () => {
    document.body.innerHTML = '<main><h2 class="t">A</h2><p class="p">B</p></main>';
    const layer = document.createElement('div');
    document.body.appendChild(layer);
    const runtime = new Runtime({ win: window, overlay: new Overlay(layer) });
    runtime.store.setHost(baseState());
    const seq = () => runtime.store.get().ui.pickSeq;
    expect(seq()).toBe(0);

    // A typed selector is a host message, a breadcrumb or level key is selectPath.
    await runtime.send({ kind: 'selection.setSelector', selector: 'css=.t', scope: 'page' });
    runtime.selectPath([0, 0]);
    await vi.waitFor(() => expect(runtime.store.get().ui.trail).toEqual([]));
    await new Promise((r) => setTimeout(r, 0));
    expect(seq()).toBe(0);

    runtime.pick(document.querySelector('p.p')!);
    await vi.waitFor(() => expect(seq()).toBe(1));
  });
});
