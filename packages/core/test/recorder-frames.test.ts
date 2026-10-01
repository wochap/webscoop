import { describe, expect, it } from 'vitest';
import { annotate, descendantsOf, draftToRecipe, emptyDraft, pathOf, selectionOf, type AnnotatedNode, type SerializedElement } from '../src';
import { h, iframe } from '../src/testing';
import { catalog, cards } from './helpers';
import { CATALOG, harness, type Harness } from './recorder-helpers';

const inner = () => catalog(cards(3));
/** The top page: a heading, a menu button, and `iframe#app` holding the catalog. */
const top = (frameDoc: SerializedElement | null) =>
  h('html', {}, h('body', {}, h('h1', { class: 'portal' }, 'Portal'), h('button', { id: 'menu' }, 'Menu'), frameDoc ? iframe({ id: 'app', class: 'app-frame' }, frameDoc) : h('iframe', { id: 'app', class: 'app-frame' })));

const plain = (node: AnnotatedNode): SerializedElement => JSON.parse(JSON.stringify(node, (k, v) => (k === 'parent' ? undefined : v)));

async function setup(): Promise<Harness & { inner: AnnotatedNode; topPage: AnnotatedNode; pickInFrame(node: AnnotatedNode): Promise<unknown> }> {
  const t = await harness(top(inner()), emptyDraft({ name: 'framed', url: CATALOG, vars: [] }));
  const innerPage = annotate(inner());
  const topPage = annotate(top(null));
  const frameNode = descendantsOf(topPage).find((n) => n.tag === 'iframe')!;
  const frameSelection = selectionOf(frameNode);
  const pickInFrame = (node: AnnotatedNode) =>
    t.send({
      kind: 'picker.select',
      url: CATALOG,
      selection: { ...selectionOf(node), framePath: pathOf(frameNode), frame: { selectors: frameSelection.candidates, fingerprint: frameSelection.fingerprint } },
      snapshot: plain(innerPage),
    });
  return { ...t, inner: innerPage, topPage, pickInFrame };
}

const first = (root: AnnotatedNode, cls: string) => descendantsOf(root).find((n) => (n.attrs.class ?? '').split(' ').includes(cls))!;

describe('recorder inside an iframe', () => {
  it('counts a pick inside the iframe there, shows its frame target, and binds the table to the frame', async () => {
    const t = await setup();
    await t.pickInFrame(first(t.inner, 'category-heading'));
    const selected = t.controller.state.selected!;
    expect(selected.selection.frame!.selectors[0]).toMatchObject({ strategy: 'id', value: 'app', count: 1 });
    expect(selected.selection.candidates[0]!.count).toBe(1);
    expect(selected.frameRefusal).toBeNull();
    expect(t.controller.state.frame?.path).toEqual([0, 2]);
    expect(t.controller.state.frame?.selectors[0]).toMatchObject({ value: 'app' });
    await t.send({ kind: 'draft.addField', patch: { name: 'category' } });
    const table = t.controller.draft.tables[0]!;
    expect(table.frame?.selectors[0]).toMatchObject({ strategy: 'id', value: 'app' });
    expect(table.fields[0]).toMatchObject({ name: 'category', count: 1 });
    expect(draftToRecipe(t.controller.draft).tables![0]!.frame!.selectors[0]).toEqual({ strategy: 'id', value: 'app', stability: 'stable' });
    const results = await t.controller.testRun();
    expect(results.tables[0]!.rows[0]).toMatchObject({ category: 'Electronics' });
  });

  it('refuses a field from the top document for a table that reads from the iframe, and clearing the table clears its frame', async () => {
    const t = await setup();
    await t.pickInFrame(first(t.inner, 'category-heading'));
    await t.send({ kind: 'draft.addField', patch: { name: 'category' } });
    await t.pick(first(t.topPage, 'portal'));
    expect(t.controller.state.selected!.frameRefusal).toBe('the page table reads from iframe#app');
    await t.send({ kind: 'draft.addField', patch: { name: 'portal' } });
    expect(t.controller.state.error).toMatch(/reads from iframe#app/);
    expect(t.controller.draft.tables[0]!.fields).toHaveLength(1);
    await t.send({ kind: 'draft.clearTable' });
    expect(t.controller.draft.tables[0]!.frame).toBeUndefined();
    await t.pick(first(t.topPage, 'portal'));
    await t.send({ kind: 'draft.addField', patch: { name: 'portal' } });
    expect(t.controller.draft.tables[0]!.fields.map((f) => f.name)).toEqual(['portal']);
  });

  it('records a click inside the iframe with its frame, and a frame edit applies to every target with that frame', async () => {
    const t = await setup();
    const link = descendantsOf(t.inner).find((n) => n.tag === 'a')!;
    await t.pickInFrame(link);
    await t.send({ kind: 'draft.addStep', step: { kind: 'click' } });
    await t.send({ kind: 'draft.addField', patch: { name: 'link' } });
    expect(t.controller.draft.steps[0]!.target!.frame!.selectors[0]).toMatchObject({ strategy: 'id', value: 'app' });
    await t.send({ kind: 'frame.edit', key: { strategy: 'id', value: 'app', stability: 'stable' }, by: 'selector', selector: 'iframe.app-frame' });
    expect(t.controller.state.error).toBeNull();
    expect(t.controller.draft.steps[0]!.target!.frame!.selectors[0]).toMatchObject({ strategy: 'css', value: 'iframe.app-frame', count: 1 });
    expect(t.controller.draft.tables[0]!.frame!.selectors[0]).toMatchObject({ strategy: 'css', value: 'iframe.app-frame' });
    await t.send({ kind: 'frame.edit', key: { strategy: 'css', value: 'iframe.app-frame', stability: 'medium' }, by: 'selector', selector: '#menu' });
    expect(t.controller.state.error).toMatch(/not match a same-origin iframe/);
  });
});
