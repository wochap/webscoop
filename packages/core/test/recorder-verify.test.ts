import { dataset } from '@webscoop/playground';
import { describe, expect, it } from 'vitest';
import { detach, elementChildren, emptyDraft, nodeAt, rank, type AnnotatedNode, type Draft, type HostMessage, type ProtocolCandidate } from '../src';
import { h } from '../src/testing';
import { byClass, cardPath, harness, type Harness } from './recorder-helpers';
import { tier0Snapshot } from './snapshot';

function newDraft(): Draft {
  return emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?tier={tier}', vars: [{ name: 'tier', value: '0' }] });
}

const STRICT_SPAN = 'p.product-note:nth-of-type(4) > span';

/** The twins catalog with the item container confirmed from the first title. */
async function twins(): Promise<Harness> {
  const t = await harness(tier0Snapshot({ twins: true }), newDraft());
  await t.pick(byClass(t.page, 'product-title', 0));
  await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
  return t;
}

/** The `p.product-note` twin (0 or 1) of card `card`, and its `span`. */
function twin(t: Harness, card: number, which: 0 | 1): { note: AnnotatedNode; span: AnnotatedNode } {
  const note = byClass(t.page, 'product-note', card * 2 + which);
  return { note, span: elementChildren(note)[0]! };
}

async function answerPending(t: Harness): Promise<void> {
  const pending = t.controller.state.pendingSelect;
  if (!pending) throw new Error('no pending select');
  const node = nodeAt(t.page, pending.path)!;
  await t.pick(node, cardPath(node));
}

const candidates = (t: Harness) => t.controller.state.selected!.selection.candidates;
const find = (list: readonly ProtocolCandidate[], value: string) => list.find((c) => c.value === value);

describe('verify', () => {
  it('marks a candidate whose first match in the picked container is the element a hit, else a miss', async () => {
    const t = await twins();
    const { span } = twin(t, 2, 1);
    const card = nodeAt(t.page, cardPath(span))!;
    const controller = t.controller as unknown as {
      containers(): Promise<unknown[]>;
      verify(c: ProtocolCandidate[], scope: 'item' | 'page', picked: AnnotatedNode, container: AnnotatedNode | null, containers: unknown[]): Promise<ProtocolCandidate[]>;
    };
    const containers = await controller.containers();
    const out = await controller.verify(
      [
        { strategy: 'css', value: 'p.product-note span', stability: 'medium' },
        { strategy: 'css', value: STRICT_SPAN, stability: 'fragile' },
        { strategy: 'css', value: 'blink', stability: 'medium' },
      ],
      'item',
      span,
      card,
      containers,
    );
    expect(out.map((c) => c.hit)).toEqual([false, true, false]);
    // A container that cannot be found leaves every candidate unknown.
    const unknown = await controller.verify([{ strategy: 'css', value: STRICT_SPAN, stability: 'fragile', hit: true }], 'item', span, card, []);
    expect(unknown[0]!.hit).toBeUndefined();
  });
});

describe('verification after a pick', () => {
  it('preselects the strict candidate for the second twin', async () => {
    const t = await twins();
    const { span } = twin(t, 0, 1);
    await t.pick(span, cardPath(span));
    const list = candidates(t);
    expect(t.controller.state.selected!.scope).toBe('item');
    expect(list[0]).toMatchObject({ strategy: 'css', value: STRICT_SPAN, stability: 'fragile', count: 24, items: 24, hit: true });
    expect(list.every((c) => c.hit !== undefined)).toBe(true);
    await t.send({ kind: 'draft.addField', patch: { name: 'seller' } });
    const field = t.controller.draft.tables[0]!.fields.at(-1)!;
    expect(field).toMatchObject({ count: 24, sample: 'Sold by Acme' });
    const reply = (await t.send({ kind: 'test.run' })) as HostMessage & { kind: 'test.results' };
    const rows = reply.results.tables[0]!.rows;
    expect(rows).toHaveLength(24);
    expect(rows.map((r) => r.seller)).toEqual(dataset.map((p) => `Sold by ${p.seller}`));
  });

  it('verifies a crumb click against the crumb element', async () => {
    const t = await twins();
    const { note, span } = twin(t, 0, 1);
    await t.pick(span, cardPath(span));
    await t.pick(note, cardPath(note));
    const list = candidates(t);
    expect(list[0]).toMatchObject({ value: 'p.product-note:nth-of-type(4)', hit: true, count: 24 });
    expect(find(list, 'p.product-note')).toMatchObject({ strategy: 'class', count: 48, hit: false });
    const firstMiss = list.findIndex((c) => c.hit === false);
    expect(list.slice(firstMiss).every((c) => c.hit === false)).toBe(true);
  });

  it('leaves a unique element ranked as without verification', async () => {
    const t = await twins();
    const price = byClass(t.page, 'product-price', 3);
    await t.pick(price, cardPath(price));
    const list = candidates(t);
    expect(list.every((c) => c.hit === true)).toBe(true);
    const unverified = rank(list.map(({ hit: _hit, ...c }) => c), { itemCount: 24 });
    expect(list.map((c) => c.value)).toEqual(unverified.map((c) => c.value));
    expect(list.some((c) => c.value.includes(':nth-of-type('))).toBe(false);
  });

  it('does not verify a typed selector', async () => {
    const t = await twins();
    await t.send({ kind: 'selection.setSelector', selector: 'css=p.product-note span', scope: 'item', snapshot: detach(t.page) });
    await answerPending(t);
    const list = candidates(t);
    expect(list[0]).toMatchObject({ value: 'p.product-note span' });
    expect(list.every((c) => c.hit === undefined)).toBe(true);
  });

  it('does not verify an opened edit, and verifies a pick while editing', async () => {
    const t = await twins();
    const { span } = twin(t, 0, 1);
    await t.pick(span, cardPath(span));
    await t.send({ kind: 'draft.addField', patch: { name: 'seller' } });
    await t.send({ kind: 'draft.editField', index: 1, snapshot: detach(t.page) });
    await answerPending(t);
    expect(candidates(t).every((c) => c.hit === undefined)).toBe(true);
    const other = twin(t, 1, 0).span;
    await t.pick(other, cardPath(other));
    expect(t.controller.state.editing).toMatchObject({ index: 1 });
    expect(candidates(t)[0]).toMatchObject({ value: 'p.product-note:nth-of-type(3) > span', hit: true });
    expect(candidates(t).every((c) => c.hit !== undefined)).toBe(true);
  });
});

describe('page scoped verification', () => {
  it('verifies on the document: the first of two headings is a miss for the second', async () => {
    const dom = h('html', {}, h('body', {}, h('h2', { class: 'title' }, 'First'), h('h2', { class: 'title' }, 'Second')));
    const t = await harness(dom, newDraft());
    const second = byClass(t.page, 'title', 1);
    await t.pick(second);
    const list = candidates(t);
    expect(t.controller.state.selected!.scope).toBe('page');
    expect(find(list, 'h2.title')).toMatchObject({ strategy: 'class', count: 2, hit: false });
    expect(list[0]!.hit).toBe(true);
    expect(list.at(-1)).toMatchObject({ value: 'h2.title', hit: false });

    const controller = t.controller as unknown as {
      verify(c: ProtocolCandidate[], scope: 'page', picked: AnnotatedNode, container: null, containers: []): Promise<ProtocolCandidate[]>;
    };
    const out = await controller.verify([{ strategy: 'css', value: 'h2', stability: 'medium' }, { strategy: 'role', value: 'heading|Second', stability: 'stable' }], 'page', second, null, []);
    expect(out.map((c) => c.hit)).toEqual([false, true]);
  });
});

describe('save order', () => {
  it('keeps hits before misses and writes no verification to the recipe', async () => {
    const t = await twins();
    const { note } = twin(t, 0, 1);
    await t.pick(note, cardPath(note));
    await t.send({ kind: 'draft.addField', patch: { name: 'note' } });
    const saved = t.controller.draft.tables[0]!.fields.at(-1)!.selectors;
    expect(saved[0]).toMatchObject({ value: 'p.product-note:nth-of-type(4)', hit: true });
    const firstMiss = saved.findIndex((c) => c.hit === false);
    expect(firstMiss).toBeGreaterThan(0);
    expect(saved.slice(0, firstMiss).every((c) => c.hit === true)).toBe(true);
    expect(saved.slice(firstMiss).every((c) => c.hit === false)).toBe(true);
    const reply = (await t.send({ kind: 'save.request' })) as HostMessage & { kind: 'save.result' };
    expect(reply.ok).toBe(true);
    const recipe = await t.storage.load('shop-catalog');
    const fields = recipe.tables?.[0]?.fields ?? recipe.fields!;
    for (const c of fields.at(-1)!.selectors) expect(Object.keys(c).sort()).toEqual(['stability', 'strategy', 'value']);
  });
});
