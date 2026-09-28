// @vitest-environment jsdom
import { HOST_BINDING, type DraftItem, type ProtocolCandidate, type RecorderState } from '@webscoop/core';
import { dataset, renderResults } from '@webscoop/playground';
import { beforeEach, describe, expect, it } from 'vitest';
import { pathOfElement } from '../src/dom';
import type { Overlay } from '../src/overlay';
import { Runtime } from '../src/runtime';
import { baseState } from './panel';

const c = (strategy: ProtocolCandidate['strategy'], value: string): ProtocolCandidate => ({ strategy, value, stability: 'medium' });

beforeEach(() => {
  const html = renderResults(dataset.slice(0, 8));
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/, '').replace(/<\/html>\s*$/, '');
});

const results = () => Array.from(document.getElementById('rso')!.querySelectorAll('div.Mjj4Yd'));
const titles = () => results().map((r) => r.querySelector('h3')!);
const h3 = c('css', 'h3');

function item(extra: Partial<DraftItem> = {}): DraftItem {
  return { selectors: [c('css', 'div > div.Mjj4Yd')], within: [c('id', 'rso')], exclude: [], fingerprint: undefined, count: 8, total: 8, ...extra } as DraftItem;
}

/** A selection of `el` with `candidate` as primary and the given scope. */
function selected(el: Element, candidate: ProtocolCandidate, scope: 'item' | 'page') {
  return { selection: { path: pathOfElement(el), candidates: [candidate] }, primary: 0, scope } as unknown as RecorderState['selected'];
}

function state(extra: Partial<RecorderState> = {}, i: DraftItem | null = null): RecorderState {
  const base = baseState();
  return { ...base, draft: { ...base.draft, tables: [{ ...base.draft.tables[0]!, item: i }] }, ...extra } as RecorderState;
}

function proposal(pick: ProtocolCandidate | null, exclude: ProtocolCandidate[] = []) {
  return { proposed: { paths: results().map(pathOfElement) }, exclude, within: null, pick: pick && { selector: pick, matched: 8, total: 8 } } as unknown as RecorderState['proposal'];
}

function matches(s: RecorderState): Element[] {
  let last: Element[] = [];
  const overlay = {
    setSelected: () => {},
    setList: () => {},
    setHover: () => {},
    setStrip: () => {},
    setOutlines: () => {},
    setItems: () => {},
    setMatches: (els: readonly Element[]) => (last = [...els]),
  } as unknown as Overlay;
  (window as unknown as Record<string, unknown>)[HOST_BINDING] = async () => ({ kind: 'draft.state', state: s });
  const runtime = new Runtime({ win: window, overlay });
  runtime.store.setHost(s);
  runtime.syncOverlay();
  return last;
}

describe('match highlight for a pick', () => {
  it('shows nothing while the list suggestion is shown', () => {
    expect(matches(state({ selected: selected(titles()[0]!, c('css', 'div#rso h3'), 'page') }))).toEqual([]);
  });

  it('shows the pick in every proposed item while the setup is open from a pick', () => {
    expect(matches(state({ selected: selected(titles()[0]!, c('css', 'div#rso h3'), 'page'), proposal: proposal(h3) }))).toEqual(titles());
  });

  it('shows nothing in the setup opened from Edit, and nothing in excluded proposed items', () => {
    expect(matches(state({ proposal: proposal(null) }))).toEqual([]);
    const exclude = [c('xpath', "//div[@id='rso']/div[1]/div[2]")];
    expect(matches(state({ selected: selected(titles()[0]!, h3, 'page'), proposal: proposal(h3, exclude) }))).toEqual(titles().filter((_, i) => i !== 1));
  });

  it('shows matches after accept and for a later pick in the third item', () => {
    expect(matches(state({ selected: selected(titles()[0]!, h3, 'item') }, item()))).toEqual(titles());
    expect(matches(state({ selected: selected(titles()[2]!, h3, 'item') }, item()))).toEqual(titles());
  });

  it('shows nothing for a page table, a pick outside the items, or the item itself', () => {
    expect(matches(state({ selected: selected(titles()[0]!, h3, 'page') }))).toEqual([]);
    expect(matches(state({ selected: selected(document.getElementById('rso')!, c('id', 'rso'), 'page') }, item()))).toEqual([]);
    expect(matches(state({ selected: selected(results()[0]!, c('css', 'div'), 'item') }, item()))).toEqual([]);
  });

  it('skips excluded containers', () => {
    const exclude = [c('xpath', "//div[@id='rso']/div[1]/div[2]")];
    expect(matches(state({ selected: selected(titles()[0]!, h3, 'item') }, item({ exclude })))).toEqual(titles().filter((_, i) => i !== 1));
  });

  it('keeps every match of an edited field, page scope included', () => {
    const editing = { candidates: [h3], primary: 0, options: { scope: 'page' } } as unknown as RecorderState['editing'];
    expect(matches(state({ editing }, item()))).toEqual(Array.from(document.querySelectorAll('h3')));
    const itemEditing = { candidates: [h3], primary: 0, options: { scope: 'item' } } as unknown as RecorderState['editing'];
    expect(matches(state({ editing: itemEditing }, item()))).toEqual(titles());
  });
});
