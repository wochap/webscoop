import { dataset } from '@webscoop/playground';
import { describe, expect, it } from 'vitest';
import { emptyDraft, type Draft, type RecorderState } from '../src';
import { h } from '../src/testing';
import { byClass, cardPath, harness, type Harness } from './recorder-helpers';
import { tier0Snapshot } from './snapshot';

function newDraft(): Draft {
  return emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?tier={tier}', vars: [{ name: 'tier', value: '0' }] });
}

const proposal = (t: { controller: { state: RecorderState } }) => t.controller.state.proposal!;

/** Tier 0 catalog with the 24 cards confirmed and a title and a price field. */
async function confirmed(snapshot = tier0Snapshot()): Promise<Harness> {
  const t = await harness(snapshot, newDraft());
  await t.pick(byClass(t.page, 'product-title', 0));
  await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
  await t.send({ kind: 'draft.updateField', index: 0, patch: { name: 'title' } });
  const price = byClass(t.page, 'product-price', 0);
  await t.pick(price, cardPath(price));
  await t.send({ kind: 'draft.addField', patch: { name: 'price' } });
  expect(t.controller.draft.tables[0]!.fields.map((f) => [f.name, f.count])).toEqual([
    ['title', 24],
    ['price', 24],
  ]);
  return t;
}

describe('editing the confirmed item container', () => {
  it('reopens the proposal seeded from the confirmed item', async () => {
    const t = await confirmed();
    const before = t.controller.draft.tables[0]!.item!;
    await t.send({ kind: 'draft.editItem' });
    expect(t.controller.state.error).toBeNull();
    const p = proposal(t);
    expect(p.editing).toBe(true);
    expect(p.proposed).toMatchObject({ tag: 'article', count: 24 });
    expect(p.proposed.paths).toHaveLength(24);
    expect(p.proposed.samples[0]).toContain(dataset[0]!.title);
    expect(p.within!.selectors[0]).toMatchObject({ strategy: 'role', value: 'list', count: 1 });
    expect(p.within!.label).toBe('ul.product-list');
    expect(p.broader).toMatchObject({ tag: 'li', count: 24 });
    expect(p.exclude).toEqual([]);
    // The draft does not change until the update.
    expect(t.controller.draft.tables[0]!.item).toEqual(before);
    expect(t.controller.draft.tables[0]!.fields).toHaveLength(2);
  });

  it('updates to the broader level, keeps the fields, and refreshes their counts', async () => {
    const t = await confirmed();
    await t.send({ kind: 'draft.editItem' });
    await t.send({ kind: 'draft.confirmItems', level: 'broader' });
    expect(t.controller.state.proposal).toBeNull();
    expect(t.controller.state.selected).toBeNull();
    const { draft } = t.controller;
    expect(draft.tables[0]!.item).toMatchObject({ count: 24, total: 24, fingerprint: { tag: 'li' } });
    expect(draft.tables[0]!.item!.selectors[0]!.value).toBe('listitem');
    expect(draft.tables[0]!.item!.within![0]).toMatchObject({ strategy: 'role', value: 'list' });
    expect(draft.tables[0]!.fields.map((f) => [f.name, f.scope, f.count])).toEqual([
      ['title', 'item', 24],
      ['price', 'item', 24],
    ]);
    expect(draft.tables[0]!.fields[0]!.sample).toBe(dataset[0]!.title);
    const results = await t.controller.testRun();
    expect(results.tables[0]!.rowCount).toBe(24);
  });

  it('keeps a field that the new level breaks, with a zero count', async () => {
    const t = await confirmed();
    await t.send({ kind: 'draft.editItem' });
    await t.send({ kind: 'draft.setLevel', level: 'item', by: 'selector', selector: '.product-title' });
    expect(proposal(t).error).toBeNull();
    expect(proposal(t).proposed.count).toBe(24);
    await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
    const { draft } = t.controller;
    expect(draft.tables[0]!.item!.count).toBe(24);
    expect(draft.tables[0]!.fields.map((f) => f.name)).toEqual(['title', 'price']);
    expect(draft.tables[0]!.fields[1]).toMatchObject({ name: 'price', count: 0, sample: null });
  });

  it('leaves the item unchanged on cancel', async () => {
    const t = await confirmed();
    const before = t.controller.draft;
    await t.send({ kind: 'draft.editItem' });
    await t.send({ kind: 'draft.setLevel', level: 'item', by: 'selector', selector: 'role=listitem' });
    expect(proposal(t).proposed.tag).toBe('li');
    await t.send({ kind: 'draft.cancelItems' });
    expect(t.controller.state.proposal).toBeNull();
    expect(t.controller.state.selected).toBeNull();
    expect(t.controller.draft.tables[0]!.item).toEqual(before.tables[0]!.item);
    expect(t.controller.draft.tables[0]!.fields).toEqual(before.tables[0]!.fields);
  });

  it('seeds the exclusions and keeps them on update', async () => {
    const t = await confirmed(tier0Snapshot({ sponsored: 2 }));
    await t.send({ kind: 'draft.addExclusion', selector: '.sponsored' });
    expect(t.controller.draft.tables[0]!.item).toMatchObject({ count: 22, total: 24 });
    await t.send({ kind: 'draft.editItem' });
    expect(proposal(t).exclude).toMatchObject([{ value: '.sponsored' }]);
    expect(proposal(t).proposed).toMatchObject({ count: 22, total: 24 });
    // Exclusions added while editing go to the proposal, not the draft.
    await t.send({ kind: 'draft.addExclusion', selector: '#product-1' });
    expect(t.controller.draft.tables[0]!.item!.exclude).toHaveLength(1);
    await t.send({ kind: 'draft.removeExclusion', index: 1 });
    await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
    expect(t.controller.draft.tables[0]!.item).toMatchObject({ count: 22, total: 24, exclude: [{ value: '.sponsored' }] });
  });

  it('includes all siblings on the mixed catalog after confirming the product cards', async () => {
    const t = await harness(tier0Snapshot({ mixed: true }), newDraft());
    await t.pick(byClass(t.page, 'product-title', 1));
    expect(proposal(t).skipped).toBe(6);
    await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
    expect(t.controller.draft.tables[0]!.item!.count).toBe(24);
    await t.send({ kind: 'draft.editItem' });
    expect(proposal(t)).toMatchObject({ skipped: 6, includeAll: false, editing: true });
    await t.send({ kind: 'draft.toggleIncludeAll' });
    expect(proposal(t)).toMatchObject({ skipped: 0, includeAll: true });
    await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
    expect(t.controller.draft.tables[0]!.item!.count).toBe(30);
    expect(t.controller.draft.tables[0]!.fields).toHaveLength(1);
  });

  it('re-picks both levels while editing', async () => {
    const t = await confirmed();
    await t.send({ kind: 'draft.editItem' });
    const title = byClass(t.page, 'product-title', 0);
    await t.send({ kind: 'draft.pickLevel', level: 'item' });
    expect(t.controller.state.levelPick).toMatchObject({ level: 'item', containing: expect.any(Array) });
    await t.send({ kind: 'draft.setLevel', level: 'item', by: 'pick', path: cardPath(title).slice(0, -1) });
    expect(proposal(t).proposed).toMatchObject({ tag: 'li', count: 24 });
    expect(proposal(t).editing).toBe(true);
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'clear' });
    expect(proposal(t).within).toBeNull();
    expect(t.controller.draft.tables[0]!.item!.fingerprint!.tag).toBe('article');
    await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
    expect(t.controller.draft.tables[0]!.item!.within).toBeUndefined();
    expect(t.controller.draft.tables[0]!.item).toMatchObject({ count: 24, fingerprint: { tag: 'li' } });
  });

  it('refuses item and field edits while editing the items', async () => {
    const t = await confirmed();
    await t.send({ kind: 'draft.editItem' });
    await t.send({ kind: 'draft.setItem' });
    expect(t.controller.state.error).toMatch(/finish editing the items/);
    await t.send({ kind: 'draft.editField', index: 0 });
    expect(t.controller.state.error).toMatch(/finish editing the items/);
    expect(t.controller.state.editing).toBeNull();
    expect(proposal(t).editing).toBe(true);
  });

  it('falls back to a single container when nothing is like it', async () => {
    const page = h('html', {}, h('body', {}, h('main', {}, h('section', { class: 'only' }, h('h2', {}, 'Lone'), h('p', {}, 'Text')))));
    const t = await harness(page, newDraft());
    await t.pick(byClass(t.page, 'only'));
    await t.send({ kind: 'draft.setItem' });
    expect(t.controller.draft.tables[0]!.item!.count).toBe(1);
    await t.send({ kind: 'draft.editItem' });
    expect(t.controller.state.error).toBeNull();
    expect(proposal(t)).toMatchObject({ editing: true, skipped: 0, broader: null, narrower: null });
    expect(proposal(t).proposed).toMatchObject({ tag: 'section', count: 1 });
  });

  it('refuses when the item container matches nothing on the page', async () => {
    const t = await confirmed();
    const other = 'http://127.0.0.1:4777/about';
    t.browser.setPage(other, h('html', {}, h('body', {}, h('p', {}, 'About us'))));
    await t.session.goto(other, { timeoutMs: 1000 });
    await t.controller.recount();
    expect(t.controller.draft.tables[0]!.item!.count).toBe(0);
    await t.send({ kind: 'draft.editItem' });
    expect(t.controller.state.error).toMatch(/matches nothing on this page/);
    expect(t.controller.state.proposal).toBeNull();
  });
});
