// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
import { emptyDraft, pathOf } from '@webscoop/core';
import { afterEach, describe, expect, it } from 'vitest';
import { byClass, harness, RESULTS } from '../../core/test/recorder-helpers';
import { resultsSnapshot } from '../../core/test/snapshot';
import { chainLevels, selectorChain } from '../src/chain';
import { renderPanel } from './panel';

afterEach(cleanup);

const c = (strategy: 'id' | 'css' | 'class', value: string) => ({ strategy, value, stability: 'medium' as const });

/** Chip texts of a selector path element, in order. */
const chips = (el: Element | null | undefined) => Array.from(el?.querySelectorAll('[data-ws="path-chip"]') ?? []).map((chip) => chip.textContent);

describe('selector chain', () => {
  it('joins the primary selectors from the list parent down, leaving out levels that are not set', () => {
    expect(selectorChain([c('id', 'rso'), c('css', 'div > div'), c('css', 'h3')])).toBe('id=rso » css=div > div » css=h3');
    expect(selectorChain([undefined, c('css', 'article'), c('css', 'h2')])).toBe('css=article » css=h2');
    expect(selectorChain([null, c('css', 'article')])).toBe('css=article');
    expect(selectorChain([undefined, undefined])).toBe('');
  });

  it('returns one level per set selector, labelled by position', () => {
    expect(chainLevels([c('id', 'rso'), c('css', ':scope > div'), c('css', 'h3')], ['list parent', 'item', 'field'])).toEqual([
      { label: 'list parent', value: 'id=rso' },
      { label: 'item', value: 'css=:scope > div' },
      { label: 'field', value: 'css=h3' },
    ]);
    expect(chainLevels([undefined, c('css', 'article'), c('css', 'h2')], ['list parent', 'item', 'field'])).toEqual([
      { label: 'item', value: 'css=article' },
      { label: 'field', value: 'css=h2' },
    ]);
    expect(chainLevels([c('css', 'h2')])).toEqual([{ value: 'css=h2' }]);
  });

  it('shows the chain in the proposal card, the item summary, and the inspector of an item scoped pick', async () => {
    const t = await harness(resultsSnapshot(), emptyDraft({ name: 'search-results', url: RESULTS, vars: [] }), RESULTS);
    await t.pick(byClass(t.page, 'LC20lb', 0));
    const proposed = renderPanel(t.controller.state);
    const p = t.controller.state.proposal!;
    const item = p.proposed.selectors[0]!;
    expect(chips(proposed.q('items-card')!.querySelector('[data-ws="selector-chain-path"]'))).toEqual(['id=rso', `${item.strategy}=${item.value}`]);
    cleanup();

    await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
    const other = byClass(t.page, 'LC20lb', 3);
    let container = other;
    while (container.attrs.class !== 'Mjj4Yd') container = container.parent!;
    await t.pick(other, pathOf(container));
    const state = t.controller.state;
    expect(state.selected!.scope).toBe('item');
    const confirmed = renderPanel(state);
    const saved = state.draft.tables[0]!.item!.selectors[0]!;
    expect(chips(confirmed.q('item-summary')!.querySelector('[data-ws="selector-chain-path"]'))).toEqual(['id=rso', `${saved.strategy}=${saved.value}`]);
    const field = state.selected!.selection.candidates[0]!;
    expect(chips(confirmed.q('inspector-chain'))).toEqual(['id=rso', `${saved.strategy}=${saved.value}`, `${field.strategy}=${field.value}`]);
    expect(confirmed.q('inspector-chain')!.dataset.chain).toBe(`id=rso » ${saved.strategy}=${saved.value} » ${field.strategy}=${field.value}`);
  });

  it('starts the chain at the item container without a list parent, and shows none for a page scoped pick', async () => {
    const t = await harness(resultsSnapshot(), emptyDraft({ name: 'search-results', url: RESULTS, vars: [] }), RESULTS);
    await t.pick(byClass(t.page, 'LC20lb', 0));
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'clear' });
    await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
    await t.pick(byClass(t.page, 'gLFyf'));
    const panel = renderPanel(t.controller.state);
    const saved = t.controller.state.draft.tables[0]!.item!.selectors[0]!;
    expect(chips(panel.q('item-summary')!.querySelector('[data-ws="selector-chain-path"]'))).toEqual([`${saved.strategy}=${saved.value}`]);
    expect(panel.q('inspector-chain')).toBeNull();
  });
});
