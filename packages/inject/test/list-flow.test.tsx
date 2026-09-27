// @vitest-environment jsdom
import { cleanup, fireEvent } from '@testing-library/react';
import { draftFromRecipe, emptyDraft, loadRecipe, type RecorderState } from '@webscoop/core';
import { dataset } from '@webscoop/playground';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptList, byClass, harness, openList } from '../../core/test/recorder-helpers';
import { tier0Snapshot } from '../../core/test/snapshot';
import { baseState, hostStates, renderPanel } from './panel';

afterEach(cleanup);

const MIXED = 'http://127.0.0.1:4777/catalog?mixed=1';

describe('list suggestion (04a)', () => {
  it('shows the card with samples, opens the setup with L or the button, and dismisses', async () => {
    const { suggested } = await hostStates();
    const p = renderPanel(suggested);
    const card = p.q('pick-cta')!;
    expect(card.dataset.count).toBe('24');
    expect(card.textContent).toContain('Repeats 24× on this page');
    expect(card.textContent).toContain('Make this table a list? One row per item.');
    expect(p.q('list-samples')!.querySelectorAll('.ws-sample')).toHaveLength(3);
    expect(p.q('list-samples')!.textContent).toContain(dataset[0]!.title);
    expect(p.q('list-samples-more')!.textContent).toBe('+ 21 more');
    // The card sits between the field form and Add field.
    const order = ['pick-form', 'pick-cta', 'pick-add-field'].map((ws) => p.q(ws)!);
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(p.q('pick-add-hint')!.textContent).toBe('Adds one value — items becomes a page table (1 row).');
    expect((p.q('pick-add-field') as HTMLButtonElement).disabled).toBe(false);
    expect(p.q('pick-cta-manual')).toBeNull();
    expect(p.q('table-kind')!.textContent).toBe('No mode yet');

    fireEvent.keyDown(p.q('panel-body')!, { key: 'L' });
    expect(p.sent.at(-1)).toEqual({ kind: 'list.open', from: 'suggestion' });
    fireEvent.click(p.q('pick-cta-setup')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'list.open', from: 'suggestion' });
    fireEvent.click(p.q('pick-cta-single')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'list.dismiss' });
  });

  it('offers the manual link when nothing repeats', async () => {
    const t = await harness(tier0Snapshot(), emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?tier=0', vars: [] }));
    await t.pick(byClass(t.page, 'category-heading'));
    const p = renderPanel(t.controller.state);
    expect(p.q('pick-cta')).toBeNull();
    fireEvent.click(p.q('pick-cta-manual')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'list.open', from: 'manual' });
    fireEvent.keyDown(p.q('panel-body')!, { key: 'l' });
    expect(p.sent).toHaveLength(1);
  });

  it('shows one quiet line in a page table (04e) and the List ready notice after accepting', async () => {
    const t = await harness(tier0Snapshot(), emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?tier=0', vars: [] }));
    await t.pick(byClass(t.page, 'category-heading'));
    await t.send({ kind: 'draft.addField', patch: {} });
    await t.pick(byClass(t.page, 'product-title', 0));
    const p = renderPanel(t.controller.state);
    expect(p.q('table-kind')!.textContent).toBe('Page · 1 row');
    expect(p.q('pick-cta')).toBeNull();
    expect(p.q('pick-repeat')!.textContent).toContain('Repeats 24× —');
    expect(p.q('pick-add-hint')!.textContent).toBe('Reads the first match on the page.');
    fireEvent.click(p.q('pick-repeat-start')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'list.open', from: 'newTable' });
    fireEvent.keyDown(p.q('panel-body')!, { key: 'L' });
    expect(p.sent).toHaveLength(1);
    cleanup();

    const ready = renderPanel({ ...baseState(), notice: 'List ready — pick fields inside an item' });
    expect(ready.q('pick-list-ready')!.textContent).toBe('List ready — pick fields inside an item');
  });
});

describe('banners for picks outside the list', () => {
  async function products() {
    const t = await harness(tier0Snapshot({ mixed: true }), emptyDraft({ name: 'shop-catalog', url: MIXED, vars: [] }), MIXED);
    await openList(t, byClass(t.page, 'product-title', 0));
    await acceptList(t);
    await t.send({ kind: 'draft.renameTable', name: 'products' });
    return t;
  }

  it('offers a new page table with an editable name when none exists (04c)', async () => {
    const t = await products();
    await t.pick(byClass(t.page, 'category-heading'));
    const p = renderPanel(t.controller.state);
    const banner = p.q('pick-outside-banner')!;
    expect(banner.textContent).toContain('Outside the products list');
    expect(banner.textContent).toContain('keep it in a page table');
    expect(p.q('pick-outside-add-to')).toBeNull();
    expect(p.q('pick-outside-new-list')).toBeNull();
    const name = p.q('pick-outside-table-name') as HTMLInputElement;
    expect(name.value).toBe('page');
    fireEvent.change(name, { target: { value: 'search-info' } });
    fireEvent.click(p.q('pick-outside-new-page')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.addTable', name: 'search-info' });
    fireEvent.change(name, { target: { value: 'products' } });
    expect((p.q('pick-outside-new-page') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(p.q('pick-outside-repick')!);
    expect(p.store.get().ui.picking).toBe(true);
    expect((p.q('pick-add-field') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says a pick repeats outside the list and offers a new list table and the page table (04c2)', async () => {
    const t = await products();
    await t.send({ kind: 'draft.addTable', name: 'summary' });
    await t.send({ kind: 'draft.selectTable', index: 0 });
    await t.pick(byClass(t.page, 'questions-title', 0));
    const p = renderPanel(t.controller.state);
    const banner = p.q('pick-outside-banner')!;
    const repeats = t.controller.state.selected!.outside!.repeats!;
    expect(p.q('pick-outside-repeats')!.textContent).toBe(`repeats ${repeats}×`);
    expect(banner.textContent).toContain('probably a separate list');
    fireEvent.click(p.q('pick-outside-new-list')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'list.open', from: 'newTable' });
    expect(p.q('pick-outside-add-to')!.textContent).toBe('Add to summary');
    fireEvent.click(p.q('pick-outside-add-to')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.selectTable', index: 1 });
  });

  it('says a pick belongs to another list and switches to it with the pick (04d)', async () => {
    const t = await products();
    await t.send({ kind: 'draft.addTable', name: 'questions' });
    await openList(t, byClass(t.page, 'questions-title', 0));
    const own = t.controller.state.proposal!.proposed.selectors.findIndex((c) => c.value === 'article.mixed-questions');
    await t.send({ kind: 'draft.setPrimary', level: 'item', index: own });
    await acceptList(t);
    await t.send({ kind: 'draft.selectTable', index: 0 });
    await t.pick(byClass(t.page, 'questions-title', 1));
    const p = renderPanel(t.controller.state);
    expect(p.q('pick-outside-banner')).toBeNull();
    const banner = p.q('pick-belongs-banner')!;
    expect(banner.textContent).toContain('Belongs to the questions list');
    expect(p.q('pick-belongs-item')!.textContent).toBe('This is inside item 2 of 6 in questions');
    expect(p.q('pick-belongs-stack')!.querySelector('[data-level="item"] [data-ws="chip"]')!.getAttribute('data-selector')).toBe('css=article.mixed-questions');
    expect((p.q('pick-add-field') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(p.q('pick-belongs-switch')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.selectTable', index: 1 });
    fireEvent.click(p.q('pick-belongs-repick')!);
    expect(p.store.get().ui.picking).toBe(true);
  });

  it('shows no banner while a field is edited', async () => {
    const t = await products();
    await t.pick(byClass(t.page, 'category-heading'));
    const state: RecorderState = { ...t.controller.state, editing: { index: 0, options: { name: 'x', type: 'text', scope: 'item', optional: false, key: false }, candidates: [], primary: 0 } };
    const p = renderPanel(state);
    expect(p.q('pick-outside-banner')).toBeNull();
  });
});

describe('old mixed tables', () => {
  it('marks a page field of a list and moves it to a page table', () => {
    const recipe = loadRecipe({
      schemaVersion: 1,
      name: 'mixed',
      url: MIXED,
      tables: [
        {
          name: 'products',
          item: { selectors: [{ strategy: 'testid', value: 'product-card', stability: 'stable' }] },
          fields: [
            { name: 'title', type: 'text', scope: 'item', selectors: [{ strategy: 'css', value: 'h2', stability: 'medium' }] },
            { name: 'category', type: 'text', scope: 'page', selectors: [{ strategy: 'css', value: '.category-heading', stability: 'medium' }] },
          ],
        },
      ],
    });
    const p = renderPanel(baseState(draftFromRecipe(recipe)));
    const rows = p.qa('field');
    expect(rows.map((r) => r.querySelector('[data-ws="field-misplaced"]') !== null)).toEqual([false, true]);
    expect(rows[1]!.querySelector('[data-ws="field-misplaced"]')!.textContent).toContain('Read once from the page');
    fireEvent.click(rows[1]!.querySelector('[data-ws="field-move-to-page"]')!);
    expect(p.sent).toEqual([{ kind: 'draft.moveFieldToPage', index: 1 }]);
  });
});
