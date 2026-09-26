// @vitest-environment jsdom
import { HOST_BINDING, type DraftItem, type PageMessage, type ProtocolCandidate, type RecorderState } from '@webscoop/core';
import { dataset, renderResults } from '@webscoop/playground';
import { beforeEach, describe, expect, it } from 'vitest';
import { containersLocal, pathOfElement, resolveLocal } from '../src/dom';
import type { Overlay } from '../src/overlay';
import { Runtime } from '../src/runtime';
import { baseState } from './panel';

const c = (strategy: ProtocolCandidate['strategy'], value: string): ProtocolCandidate => ({ strategy, value, stability: 'medium' });

beforeEach(() => {
  const html = renderResults(dataset.slice(0, 8));
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/, '').replace(/<\/html>\s*$/, '');
  // A result-like block outside the list parent, which relative item selectors must not reach.
  document.querySelector('#searchform')!.insertAdjacentHTML('beforeend', '<div class="hlcw0c"><div class="Mjj4Yd"><h3>Sponsored</h3></div></div>');
});

const rso = () => document.getElementById('rso')!;
const results = () => Array.from(rso().querySelectorAll('div.Mjj4Yd'));

/** A confirmed item under `div#rso` whose selector also matches the block outside it. */
function item(extra: Partial<DraftItem> = {}): DraftItem {
  return { selectors: [c('css', 'div > div.Mjj4Yd')], within: [c('id', 'rso')], exclude: [], fingerprint: undefined, count: 8, total: 8, ...extra } as DraftItem;
}

function stateWith(i: DraftItem, extra: Partial<RecorderState> = {}): RecorderState {
  const state = baseState();
  return { ...state, draft: { ...state.draft, tables: [{ ...state.draft.tables[0]!, item: i }] }, ...extra };
}

describe('scoped resolution in the page', () => {
  it('matches css strictly inside the scope element and scopes a leading // xpath to it, like Playwright', () => {
    expect(resolveLocal(c('css', 'div > div.Mjj4Yd'))).toHaveLength(9);
    expect(resolveLocal(c('css', 'div > div.Mjj4Yd'), rso())).toHaveLength(8);
    expect(resolveLocal(c('css', 'div.main div.Mjj4Yd'), rso())).toHaveLength(0);
    expect(resolveLocal(c('css', 'div#rso > div'), rso())).toHaveLength(0);
    expect(resolveLocal(c('css', 'h3, div.Mjj4Yd'), rso())).toHaveLength(16);
    expect(resolveLocal(c('xpath', "//div[@id='rso']/div[1]/div[1]"), rso())).toHaveLength(0);
    expect(resolveLocal(c('xpath', "//div[@class='Mjj4Yd']"), rso())).toHaveLength(8);
    expect(resolveLocal(c('xpath', './div[1]/div[2]'), rso())[0]).toBe(results()[1]);
  });

  it('finds the containers inside the list parent only, minus exclusions', () => {
    expect(containersLocal(item())).toEqual(results());
    expect(containersLocal(item({ within: undefined }))).toHaveLength(9);
    expect(containersLocal(item({ within: [c('id', 'nothing')] }))).toEqual([]);
    const exclude = [c('xpath', "//div[@id='rso']/div[1]/div[1]")];
    expect(containersLocal(item({ exclude }))).toEqual(results().slice(1));
    expect(containersLocal(item({ exclude }), document, { keepExcluded: true })).toEqual(results());
  });
});

describe('runtime with a list parent', () => {
  function setup(state: RecorderState) {
    const calls: { items: Element[]; excluded: Element[] }[] = [];
    const overlay = {
      setSelected: () => {},
      setList: () => {},
      setHover: () => {},
      setMatches: () => {},
      setItems: (items: readonly Element[], _variant: string, excluded: readonly Element[] = []) => calls.push({ items: [...items], excluded: [...excluded] }),
    } as unknown as Overlay;
    const sent: PageMessage[] = [];
    (window as unknown as Record<string, unknown>)[HOST_BINDING] = async (msg: PageMessage) => {
      sent.push(msg);
      return { kind: 'draft.state', state };
    };
    const runtime = new Runtime({ win: window, overlay });
    runtime.store.setHost(state);
    return { runtime, calls, sent };
  }

  it('highlights only the containers inside the list parent', () => {
    const exclude = [c('xpath', "//div[@id='rso']/div[1]/div[2]")];
    const { runtime, calls } = setup(stateWith(item({ exclude })));
    runtime.syncOverlay();
    expect(calls.at(-1)!.items).toEqual(results());
    expect(calls.at(-1)!.excluded).toEqual([results()[1]]);
  });

  it('makes a pick inside a container item scoped, and a pick outside the list parent page scoped', async () => {
    const { runtime, sent } = setup(stateWith(item()));
    runtime.pick(results()[2]!.querySelector('h3')!);
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ kind: 'picker.select', selection: { containerPath: pathOfElement(results()[2]!) } });
    runtime.pick(document.querySelector('#searchform h3')!);
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]).toMatchObject({ kind: 'picker.select', selection: { containerPath: null } });
  });

  it('accepts a list parent pick only when it holds containers inside the current list parent', () => {
    const levelPick = { level: 'within' as const, ancestorOf: [], ofContainers: true, descendantOf: null, containing: null };
    const { runtime } = setup(stateWith(item(), { levelPick }));
    expect(runtime.levelRefusal(document.getElementById('center_col')!)).toBeNull();
    expect(runtime.levelRefusal(document.getElementById('searchform')!)).toBe('outside the list');
  });
});
