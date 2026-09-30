import { dataset, render } from '@webscoop/playground';
import { describe, expect, it } from 'vitest';
import { draftFromRecipe, emptyDraft, loadRecipe, type Draft, type Recipe, type HostMessage, type RecorderState } from '../src';
import { acceptList, byClass, cardPath, CATALOG, harness, openList, referenceRecipe } from './recorder-helpers';
import { cards, catalog, recipe } from './helpers';
import { snapshotFromHtml, tier0Snapshot } from './snapshot';

function newDraft(): Draft {
  return emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?tier={tier}', vars: [{ name: 'tier', value: '0' }] });
}

describe('RecorderController', () => {
  it('runs the reference recipe on the current page', async () => {
    const t = await harness(tier0Snapshot(), draftFromRecipe(referenceRecipe()));
    const results = await t.controller.testRun();
    expect(results.tables[0]!.rowCount).toBe(24);
    expect(results.tables[0]!.rows).toHaveLength(24);
    expect(results.tables[0]!.fields.map((f) => f.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(results.durationMs).toBeGreaterThan(0);
    expect(t.events.at(-1)).toEqual({ name: 'recorder.testRun', payload: { rows: 24, durationMs: results.durationMs } });
  });

  it('drops rows missing a required field and reports them', async () => {
    const reference = referenceRecipe();
    // Every article, questions blocks included; only the link is required.
    const r: Recipe = {
      ...reference,
      item: { ...reference.item!, selectors: [{ strategy: 'css', value: 'article', stability: 'medium' }] },
      fields: reference.fields!.map((f) => ({ ...f, optional: f.name !== 'url' })),
    };
    const t = await harness(tier0Snapshot({ mixed: true }), draftFromRecipe(r));
    const results = await t.controller.testRun();
    expect(results.tables[0]!.rowCount).toBe(24);
    expect(results.tables[0]!.rows.every((row) => typeof row.url === 'string')).toBe(true);
    expect(results.tables[0]!.dropped).toEqual({ count: 6, fields: ['url'] });
    expect(results.tables[0]!.fields.find((f) => f.name === 'url')?.status).toBe('partial');
    expect(results.warnings[0]).toMatch(/^dropped 6 rows on page 1: required field "url" missing on rows /);
    expect(results.error).toBeUndefined();
  });

  it('honors the fallback flag in test runs when toggled on a field', async () => {
    const reference = referenceRecipe();
    // Every article, questions blocks included; the title's second candidate matches only in the questions blocks.
    const r: Recipe = {
      ...reference,
      item: { ...reference.item!, selectors: [{ strategy: 'css', value: 'article', stability: 'medium' }] },
      fields: [
        {
          name: 'title',
          type: 'text',
          scope: 'item',
          selectors: [
            { strategy: 'css', value: 'h2.product-title', stability: 'medium' },
            { strategy: 'css', value: 'h3.questions-title', stability: 'medium' },
          ],
          optional: false,
          fallback: false,
          hover: false,
        },
      ],
    };
    const t = await harness(tier0Snapshot({ mixed: true }), draftFromRecipe(r));
    const off = await t.controller.testRun();
    expect(off.tables[0]!.rowCount).toBe(24);
    expect(off.tables[0]!.dropped).toEqual({ count: 6, fields: ['title'] });
    await t.send({ kind: 'draft.updateField', index: 0, patch: { fallback: true } });
    expect(t.controller.draft.tables[0]!.fields[0]!.fallback).toBe(true);
    const on = await t.controller.testRun();
    expect(on.tables[0]!.rowCount).toBe(30);
    expect(on.tables[0]!.rows.filter((row) => row.title === 'People also ask')).toHaveLength(6);
    const saved = (await t.send({ kind: 'save.request' })) as HostMessage & { kind: 'save.result' };
    expect(saved.ok).toBe(true);
    expect(JSON.parse(t.storage.files.get(r.name)!).fields[0].fallback).toBe(true);
  });

  it('saves the hover flag, keeps it for edit, and never hovers in test runs', async () => {
    const r = referenceRecipe();
    const t = await harness(tier0Snapshot(), draftFromRecipe(r));
    await t.send({ kind: 'draft.updateField', index: 0, patch: { hover: true } });
    expect(t.controller.draft.tables[0]!.fields[0]!.hover).toBe(true);
    const results = await t.controller.testRun();
    expect(t.browser.hovers).toEqual([]);
    expect(results.tables[0]!.fields[0]).toMatchObject({ name: r.fields![0]!.name, hover: true });
    expect(results.tables[0]!.fields[1]).not.toHaveProperty('hover');
    const saved = (await t.send({ kind: 'save.request' })) as HostMessage & { kind: 'save.result' };
    expect(saved.ok).toBe(true);
    const stored = JSON.parse(t.storage.files.get(r.name)!);
    expect(stored.fields[0].hover).toBe(true);
    expect(stored.fields[1]).not.toHaveProperty('hover');
    expect(draftFromRecipe(loadRecipe(stored)).tables[0]!.fields[0]!.hover).toBe(true);
  });

  it('keeps the draft when the page announces itself again after a navigation', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    await openList(t, byClass(t.page, 'product-title', 0));
    await acceptList(t, { name: 'title' });
    const price = byClass(t.page, 'product-price', 0);
    await t.pick(price, cardPath(price));
    await t.send({ kind: 'draft.addField', patch: { name: 'price' } });
    expect(t.controller.draft.tables[0]!.fields.map((f) => f.name)).toEqual(['title', 'price']);
    // The page is injected again after following a link and announces itself.
    await t.send({ kind: 'session.ready', url: `${CATALOG}&page=2` });
    await t.controller.idle();
    expect(t.controller.draft.tables[0]!.fields.map((f) => f.name)).toEqual(['title', 'price']);
    const state = t.session.dispatchedOf('draft.state').at(-1) as { state: RecorderState };
    expect(state.state.draft.tables[0]!.fields.map((f) => f.name)).toEqual(['title', 'price']);
  });

  it('counts the containers each item field matches in', async () => {
    const dom = catalog(cards(11, (i) => (i >= 9 ? { noLink: true } : {})));
    const t = await harness(dom, draftFromRecipe(loadRecipe(recipe({ url: CATALOG }))));
    await t.send({ kind: 'session.ready', url: CATALOG });
    await t.controller.idle();
    const fields = t.controller.draft.tables[0]!.fields;
    expect(fields.find((f) => f.name === 'url')!.coverage).toEqual({ matched: 9, total: 11 });
    expect(fields.find((f) => f.name === 'title')!.coverage).toEqual({ matched: 11, total: 11 });
    expect(fields.find((f) => f.name === 'category')!.coverage).toBeNull();
    const state = t.session.dispatchedOf('draft.state').at(-1) as { state: RecorderState } | undefined;
    expect(state?.state.draft.tables[0]!.fields.find((f) => f.name === 'url')!.coverage).toEqual({ matched: 9, total: 11 });
  });

  it('drops a row whose required field reads empty and reports it', async () => {
    // Blank the fourth card's title: the element is there but holds only whitespace.
    let seen = 0;
    const html = render(dataset, { tier: 0, seed: 1 }).replace(/(<h2 class="product-title">)[^<]*(<\/h2>)/g, (match, open: string, close: string) =>
      seen++ === 3 ? `${open}  \n  ${close}` : match,
    );
    expect(seen).toBe(24);
    const t = await harness(snapshotFromHtml(html), draftFromRecipe(referenceRecipe()));
    const results = await t.controller.testRun();
    expect(results.tables[0]!.rowCount).toBe(23);
    expect(results.tables[0]!.rows.every((row) => typeof row.title === 'string' && row.title !== '')).toBe(true);
    expect(results.tables[0]!.dropped).toEqual({ count: 1, fields: ['title'] });
    expect(results.tables[0]!.fields.find((f) => f.name === 'title')?.status).toBe('partial');
    expect(results.warnings[0]).toBe('dropped 1 row on page 1: required field "title" missing on row 3');
    expect(results.error).toBeUndefined();
  });

  it('saves a draft that loads back with loadRecipe', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    const failed = (await t.send({ kind: 'save.request' })) as HostMessage & { kind: 'save.result' };
    expect(failed.ok).toBe(false);
    expect(t.storage.files.size).toBe(0);
    await openList(t, byClass(t.page, 'product-title', 0));
    await acceptList(t, { name: 'title' });
    expect(t.controller.draft.dirty).toBe(true);
    const saved = (await t.send({ kind: 'save.request' })) as HostMessage & { kind: 'save.result' };
    expect(saved).toMatchObject({ ok: true, path: '/recipes/shop-catalog.json', errors: [] });
    expect(t.controller.draft.dirty).toBe(false);
    const recipe = loadRecipe(t.storage.files.get('shop-catalog')!);
    expect(recipe.url).toBe('http://127.0.0.1:4777/catalog?tier={tier}');
    expect(recipe.vars).toEqual([{ name: 'tier', type: 'string', default: '0' }]);
    expect(recipe.item!.selectors[0]).toEqual({ strategy: 'role', value: 'article', stability: 'stable' });
    expect(recipe.item!.selectors[1]).toEqual({ strategy: 'testid', value: 'product-card', stability: 'stable' });
    expect(recipe.item!.within![0]).toEqual({ strategy: 'role', value: 'list', stability: 'stable' });
    expect(recipe.item!.withinFingerprint?.tag).toBe('ul');
    expect(recipe.fields![0]!.fingerprint?.tag).toBe('h2');
    expect(t.events.map((e) => e.name)).toContain('recorder.saved');
  });

  it('loads a recipe for editing and requests counts when the page is ready', async () => {
    const reference = referenceRecipe();
    const t = await harness(tier0Snapshot(), draftFromRecipe(reference));
    expect(t.controller.draft.tables[0]!.fields.map((f) => f.count)).toEqual([null, null, null, null, null, null]);
    const reply = (await t.send({ kind: 'session.ready', url: CATALOG })) as HostMessage & { kind: 'draft.state' };
    expect(reply.state.draft.tables[0]!.fields).toHaveLength(6);
    await t.controller.idle();
    expect(t.controller.draft.tables[0]!.fields.map((f) => f.count)).toEqual([24, 24, 24, 24, 24, 1]);
    expect(t.controller.draft.tables[0]!.item).toMatchObject({ count: 24, total: 24 });
    expect(t.session.dispatchedOf('draft.state')).toHaveLength(1);
    expect(t.controller.draft.dirty).toBe(false);
    // Saving unchanged writes the same recipe.
    await t.send({ kind: 'save.request' });
    expect(loadRecipe(t.storage.files.get(reference.name)!)).toEqual(reference);
  });

  it('reports errors to the page instead of throwing', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    const reply = (await t.send({ kind: 'draft.addField', patch: {} })) as HostMessage & { kind: 'draft.state' };
    expect(reply.state.error).toBe('select an element first');
    const bad = (await t.send({ kind: 'bogus' })) as HostMessage & { kind: 'draft.state' };
    expect(bad.state.error).toMatch(/invalid page message/);
  });

  it('ends when the user closes the window', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    await t.session.userClose();
    expect(await t.controller.closed()).toBe('closed');
  });
});
