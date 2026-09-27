// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { HOST_BINDING, type DraftItem, type PageMessage, type ProposalView, type ProtocolCandidate, type RecorderState } from '@webscoop/core';
import { dataset, renderResults } from '@webscoop/playground';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathOfElement } from '../src/dom';
import { Overlay } from '../src/overlay';
import { Picker, type HoverWalk } from '../src/picker';
import { Runtime } from '../src/runtime';
import { baseState, renderPanel } from './panel';

const c = (strategy: ProtocolCandidate['strategy'], value: string): ProtocolCandidate => ({ strategy, value, stability: 'medium' });

beforeEach(() => {
  const html = renderResults(dataset.slice(0, 8));
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/, '').replace(/<\/html>\s*$/, '');
});

const titles = () => Array.from(document.querySelectorAll('h3.LC20lb'));
const blocks = () => Array.from(document.querySelectorAll('div.Mjj4Yd'));
/** Levels from a result title up to its result block. */
const UP_TO_BLOCK = 5;

const move = (el: Element, init: MouseEventInit = {}) => el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, ...init }));
const click = (el: Element, init: MouseEventInit = {}) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
const press = (el: Element, key: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true, ...init });
  el.dispatchEvent(e);
  return e;
};

function picker() {
  const hovers: { el: Element | null; walk: HoverWalk | undefined }[] = [];
  const picks: Element[] = [];
  const keys: string[] = [];
  let cancelled = 0;
  let active = true;
  const p = new Picker(window, {
    isActive: () => active,
    onHover: (el, walk) => hovers.push({ el, walk }),
    onPick: (el) => picks.push(el),
    onCancel: () => cancelled++,
    onKey: (e) => keys.push(e.key),
  });
  return {
    p,
    hovers,
    picks,
    keys,
    last: () => hovers.at(-1)!,
    cancelled: () => cancelled,
    stop: () => (active = false),
  };
}

describe('hover walk', () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it('walks up to a wrapper, then back down', () => {
    const t = picker();
    dispose = () => t.p.dispose();
    const title = titles()[0]!;
    move(title);
    expect(t.last()).toEqual({ el: title, walk: { start: title, depth: 0 } });
    press(document.body, 'ArrowUp');
    press(document.body, '[');
    expect(t.last()).toEqual({ el: title.parentElement!.parentElement, walk: { start: title, depth: 2 } });
    press(document.body, 'ArrowDown');
    expect(t.last()).toEqual({ el: title.parentElement, walk: { start: title, depth: 1 } });
    press(document.body, ']');
    press(document.body, ']');
    // Down at the start element does nothing.
    expect(t.last()).toEqual({ el: title, walk: { start: title, depth: 0 } });
    expect(t.hovers).toHaveLength(5);
  });

  it('stops below body', () => {
    const t = picker();
    dispose = () => t.p.dispose();
    const rso = document.getElementById('rso')!;
    move(rso);
    for (let i = 0; i < 10; i++) press(document.body, 'ArrowUp');
    expect(t.last().el).toBe(document.getElementById('main'));
  });

  it('picks the walked target when the click lands inside it', () => {
    const t = picker();
    dispose = () => t.p.dispose();
    const title = titles()[1]!;
    move(title);
    for (let i = 0; i < UP_TO_BLOCK; i++) press(document.body, 'ArrowUp');
    expect(t.last().el).toBe(blocks()[1]);
    click(title);
    expect(t.picks).toEqual([blocks()[1]]);
    // The walk resets after a pick.
    move(title);
    click(title);
    expect(t.picks.at(-1)).toBe(title);
  });

  it('picks the element under the pointer when the click lands outside the walked target', () => {
    const t = picker();
    dispose = () => t.p.dispose();
    move(titles()[0]!);
    press(document.body, 'ArrowUp');
    click(titles()[2]!);
    expect(t.picks).toEqual([titles()[2]]);
  });

  it('resets the walk when the pointer moves onto another element', () => {
    const t = picker();
    dispose = () => t.p.dispose();
    const title = titles()[0]!;
    move(title);
    press(document.body, 'ArrowUp');
    press(document.body, 'ArrowUp');
    // Moving within the same element keeps the walk.
    move(title);
    expect(t.last().walk).toEqual({ start: title, depth: 2 });
    const snippet = blocks()[1]!.querySelector('.VwiC3b span')!;
    move(snippet);
    expect(t.last()).toEqual({ el: snippet, walk: { start: snippet, depth: 0 } });
  });
});

describe('keys while picking', () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it('holds back page keys and forwards them to the runtime', () => {
    const t = picker();
    const seen: string[] = [];
    const onPage = (e: KeyboardEvent) => seen.push(`${e.type}:${e.key}`);
    for (const type of ['keydown', 'keyup', 'keypress'] as const) document.addEventListener(type, onPage);
    dispose = () => {
      t.p.dispose();
      for (const type of ['keydown', 'keyup', 'keypress'] as const) document.removeEventListener(type, onPage);
    };
    const title = titles()[0]!;
    move(title);
    const j = press(title, 'j');
    title.dispatchEvent(new KeyboardEvent('keyup', { key: 'j', bubbles: true }));
    title.dispatchEvent(new KeyboardEvent('keypress', { key: 'j', bubbles: true }));
    expect(seen).toEqual([]);
    expect(t.keys).toEqual(['j']);
    // Browser defaults are not prevented.
    expect(j.defaultPrevented).toBe(false);
    expect(t.cancelled()).toBe(0);
    // Walk keys never scroll the page.
    expect(press(title, 'ArrowUp').defaultPrevented).toBe(true);
    expect(seen).toEqual([]);
    // Not picking: the page gets its keys.
    t.stop();
    press(title, 'j');
    expect(seen).toEqual(['keydown:j']);
  });

  it('walks while focus is in the panel, and leaves panel typing alone', () => {
    const t = picker();
    const host = document.documentElement.appendChild(document.createElement('webscoop-root'));
    const input = host.appendChild(document.createElement('input'));
    dispose = () => {
      t.p.dispose();
      host.remove();
    };
    const title = titles()[0]!;
    move(title);
    press(host, 'ArrowUp');
    expect(t.last()).toEqual({ el: title.parentElement, walk: { start: title, depth: 1 } });
    // Other panel keys reach the panel, not the runtime's page handler.
    press(host, 's', { ctrlKey: true });
    expect(t.keys).toEqual([]);
    // Typing in a panel input: arrows stay with the input.
    const typed = press(input, 'ArrowUp');
    expect(typed.defaultPrevented).toBe(false);
    expect(t.last().walk).toEqual({ start: title, depth: 1 });
  });

  it('saves with Ctrl+S while picking on the page', async () => {
    const sent: PageMessage[] = [];
    (window as unknown as Record<string, unknown>)[HOST_BINDING] = async (msg: PageMessage) => {
      sent.push(msg);
      return { kind: 'draft.state', state: baseState() };
    };
    const layer = document.body.appendChild(document.createElement('div'));
    const overlay = new Overlay(layer);
    const runtime = new Runtime({ win: window, overlay });
    runtime.store.setHost(baseState());
    const p = new Picker(window, {
      isActive: () => runtime.picking,
      onHover: (el, walk) => runtime.hover(el, walk),
      onPick: (el) => runtime.pick(el),
      onCancel: () => runtime.cancelPicking(),
      onKey: (e) => runtime.pageKey(e),
    });
    dispose = () => {
      p.dispose();
      runtime.dispose();
      overlay.dispose();
    };
    runtime.startPicking();
    const e = press(titles()[0]!, 's', { ctrlKey: true });
    await Promise.resolve();
    expect(sent.map((m) => m.kind)).toEqual(['save.request']);
    expect(e.defaultPrevented).toBe(true);
    expect(runtime.picking).toBe(true);
  });
});

/** A confirmed item under `div#rso`. */
function item(extra: Partial<DraftItem> = {}): DraftItem {
  return { selectors: [c('css', 'div > div.Mjj4Yd')], within: [c('id', 'rso')], exclude: [], count: 8, total: 8, ...extra } as DraftItem;
}

function stateWith(i: DraftItem | null, extra: Partial<RecorderState> = {}): RecorderState {
  const state = baseState();
  return { ...state, draft: { ...state.draft, tables: [{ ...state.draft.tables[0]!, name: 'results', item: i }] }, ...extra };
}

function runtimeFor(state: RecorderState) {
  const sent: PageMessage[] = [];
  (window as unknown as Record<string, unknown>)[HOST_BINDING] = async (msg: PageMessage) => {
    sent.push(msg);
    return { kind: 'draft.state', state };
  };
  const layer = document.body.appendChild(document.createElement('div'));
  const overlay = new Overlay(layer);
  const runtime = new Runtime({ win: window, overlay });
  runtime.store.setHost(state);
  return { runtime, overlay, sent };
}

describe('walked targets in the runtime', () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it('shows the walk distance, the repeat count, the size, and the start marker in the tag', () => {
    const { runtime, overlay } = runtimeFor(baseState());
    dispose = () => {
      runtime.dispose();
      overlay.dispose();
    };
    runtime.startPicking();
    const title = titles()[0]!;
    runtime.hover(blocks()[0]!, { start: title, depth: UP_TO_BLOCK });
    expect(overlay.tagMarkup).toContain('<em class="ws-walk">↑5</em>');
    expect(overlay.tagMarkup).toContain('<span class="ws-similar">4 similar siblings</span>');
    expect(overlay.tagMarkup).toMatch(/<span class="ws-size">\d+×\d+<\/span>/);
    const start = overlay.boxes().find((b) => b.variant === 'start');
    expect(start?.el).toBe(title);
    expect(document.querySelector('.ws-box-start .ws-list-label')!.textContent).toBe('h3 · start');
    expect(runtime.store.get().ui.hover).toEqual({ depth: 5, similar: 4, path: ['div.Mjj4Yd', 'div.yuRUbf', 'div', 'span', 'a.zReHs', 'h3.LC20lb'] });
    // Back at the start: no distance, no size, no marker.
    runtime.hover(title, { start: title, depth: 0 });
    expect(overlay.tagMarkup).not.toContain('ws-walk');
    expect(overlay.tagMarkup).not.toContain('ws-size');
    expect(overlay.boxes().some((b) => b.variant === 'start')).toBe(false);
    expect(runtime.store.get().ui.hover).toEqual({ depth: 0, similar: 1, path: ['h3.LC20lb'] });
  });

  it('accepts a walked-up results wrapper as the list parent', async () => {
    const title = titles()[0]!;
    const state = stateWith(item(), { levelPick: { level: 'within', ancestorOf: [], ofContainers: true, descendantOf: null, containing: null } });
    const { runtime, overlay, sent } = runtimeFor(state);
    dispose = () => {
      runtime.dispose();
      overlay.dispose();
    };
    runtime.startPicking();
    const rso = document.getElementById('rso')!;
    runtime.hover(rso, { start: title, depth: 7 });
    expect(overlay.tagMarkup).not.toContain('ws-refused');
    runtime.pick(rso);
    await Promise.resolve();
    expect(sent[0]).toMatchObject({ kind: 'draft.setLevel', level: 'within', by: 'pick', path: pathOfElement(rso) });
  });

  it('refuses an item level walked above the list parent and ignores the click', () => {
    const title = titles()[0]!;
    const rso = document.getElementById('rso')!;
    const state = stateWith(null, { levelPick: { level: 'item', ancestorOf: [], ofContainers: false, descendantOf: pathOfElement(rso), containing: null } });
    const { runtime, overlay, sent } = runtimeFor(state);
    dispose = () => {
      runtime.dispose();
      overlay.dispose();
    };
    runtime.startPicking();
    const above = rso.parentElement!;
    runtime.hover(above, { start: title, depth: 8 });
    expect(overlay.tagMarkup).toContain('<em class="ws-refused">outside the list</em>');
    runtime.pick(above);
    expect(sent).toEqual([]);
    expect(runtime.picking).toBe(true);
  });
});

describe('pick strip', () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it('says Picking in the active list with the key hints, and goes away on Esc', () => {
    const { runtime, overlay } = runtimeFor(stateWith(item()));
    dispose = () => {
      runtime.dispose();
      overlay.dispose();
    };
    expect(overlay.stripText).toBe('');
    runtime.startPicking();
    expect(overlay.stripText).toBe('Picking in results↑ ↓parent / childclickto pickAlt+clickthrough overlaysEsccancel');
    const strip = document.querySelector('.ws-strip') as HTMLElement;
    expect(strip).not.toBeNull();
    runtime.hover(titles()[0]!, { start: titles()[0]!, depth: 0 });
    expect(runtime.store.get().ui.hover).not.toBeNull();
    runtime.cancelPicking();
    expect(overlay.stripText).toBe('');
    expect(document.querySelector('.ws-strip')).toBeNull();
    expect(runtime.store.get().ui.hover).toBeNull();
  });

  it('says Picking alone in a table without a list', () => {
    const { runtime, overlay } = runtimeFor(baseState());
    dispose = () => {
      runtime.dispose();
      overlay.dispose();
    };
    runtime.startPicking();
    expect(overlay.stripText.startsWith('Picking↑')).toBe(true);
    runtime.pick(titles()[0]!);
    expect(overlay.stripText).toBe('');
  });
});

describe('pick helpers in the panel', () => {
  it('shows the hovering card that follows the walk, and drops it when picking stops', () => {
    const p = renderPanel(baseState(), { picking: true, hover: { depth: 2, similar: 11, path: ['div.MjjYud', 'div.yuRUbf', 'h3.LC20lb'] } });
    expect(p.q('pick-strip')!.textContent).toContain('Picking on the page');
    const card = p.q('pick-hover')!;
    expect(p.q('pick-hover-depth')!.textContent).toBe('↑2');
    expect(p.q('pick-hover-similar')!.textContent).toBe('11 similar siblings');
    expect(p.qa('pick-hover-step').map((s) => s.textContent)).toEqual(['div.MjjYud', 'div.yuRUbf', 'h3.LC20lb']);
    expect(p.q('pick-hover-path')!.textContent).toBe('div.MjjYud‹div.yuRUbf‹h3.LC20lb· start');
    expect(card.textContent).toContain('Wrappers are hard to click — hover any child and press ↑ until the whole item is outlined.');
    act(() => p.store.setUi({ hover: { depth: 1, similar: 0, path: ['div.yuRUbf', 'h3.LC20lb'] } }));
    expect(p.q('pick-hover-depth')!.textContent).toBe('↑1');
    expect(p.q('pick-hover-similar')).toBeNull();
    act(() => p.store.setUi({ picking: false, hover: null }));
    expect(p.q('pick-hover')).toBeNull();
  });

  it('marks an inferred list parent in the list setup and its summary', () => {
    const within = { tag: 'div', label: 'div#rso', path: [1, 1, 0, 0, 0], selectors: [{ strategy: 'id' as const, value: 'rso', stability: 'stable' as const, count: 1 }], primary: 0, count: 1, total: 1, paths: [], samples: [] };
    const proposed = { tag: 'div', label: 'div.Mjj4Yd', path: [1, 1, 0, 0, 0, 0, 0], selectors: [{ strategy: 'class' as const, value: 'div.Mjj4Yd', stability: 'fragile' as const, count: 8 }], primary: 0, count: 8, total: 8, paths: [], samples: [] };
    const proposal: ProposalView = { within, withinInferred: true, proposed, skipped: 1, includeAll: false, error: null, exclude: [], origin: 'pick', previousCount: null, pick: null, itemLadder: null, parentLadder: null, fieldPreview: [] };
    const p = renderPanel(stateWith(null, { proposal }));
    expect(p.q('setup-row-within')!.querySelector('[data-ws="within-inferred"]')!.textContent).toBe('inferred');
    expect(p.q('adjust-parent')!.textContent).toContain('div#rso · inferred');
    act(() => p.store.setHost(stateWith(null, { proposal: { ...proposal, withinInferred: false } })));
    expect(p.q('within-inferred')).toBeNull();
    expect(p.q('adjust-parent')!.textContent).not.toContain('inferred');
  });

  it('marks an inferred list parent in the Rows section and offers Change', () => {
    const p = renderPanel(stateWith(item({ withinInferred: true, withinCount: 1 })));
    const row = p.q('rows-stack')!.querySelector('[data-level="list"]')!;
    expect(row.querySelector('[data-ws="within-inferred"]')!.textContent).toBe('inferred');
    expect(p.q('within-repick')!.textContent).toBe('Change');
    act(() => p.store.setHost(stateWith(item({ withinCount: 1 }))));
    expect(p.q('within-inferred')).toBeNull();
    expect(p.q('within-repick')!.textContent).toBe('Re-pick');
  });
});
