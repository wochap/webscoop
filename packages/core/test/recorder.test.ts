import { dataset } from '@webscoop/playground';
import { describe, expect, it } from 'vitest';
import {
  detectPagination,
  draftFromRecipe,
  emptyDraft,
  fieldDefaults,
  HOST_MESSAGE_KINDS,
  isInteractiveSession,
  isNumericText,
  loadRecipe,
  PAGE_MESSAGE_KINDS,
  parse,
  parseHostMessage,
  parsePageMessage,
  ProtocolError,
  reduceDraft,
  slugName,
  type Draft,
  type HostMessage,
  type PageMessage,
  type RecorderState,
} from '../src';
import { FakeBrowser, h } from '../src/testing';
import { byClass, CATALOG, cardPath, harness, referenceRecipe } from './recorder-helpers';
import { tier0Snapshot } from './snapshot';

const candidate = { strategy: 'testid', value: 'price', stability: 'stable' } as const;
const fp = { tag: 'span', textSample: '$1', attrs: {}, ancestors: ['a'], bbox: { x: 0, y: 0, w: 1, h: 1 } };

function newDraft(): Draft {
  return emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?tier={tier}', vars: [{ name: 'tier', value: '0' }] });
}

const sampleState: RecorderState = {
  url: CATALOG,
  draft: newDraft(),
  selected: null,
  proposal: null,
  repick: null,
  test: null,
  saved: null,
  busy: null,
  error: null,
};

const selection = {
  path: [1, 0],
  tag: 'h2',
  role: 'heading',
  name: 'Mouse',
  text: 'Mouse',
  attrs: { class: 'product-title' },
  candidates: [{ ...candidate, count: 24 }],
  fingerprint: fp,
  ancestors: [{ label: 'body', path: [1] }],
  containerPath: null,
};

describe('protocol', () => {
  const page: PageMessage[] = [
    { kind: 'session.ready', url: CATALOG },
    { kind: 'session.end' },
    { kind: 'picker.hover', path: [1, 0], tag: 'h2' },
    { kind: 'picker.select', url: CATALOG, selection, snapshot: h('html') },
    { kind: 'picker.cancel' },
    { kind: 'inspect.count', candidate, scope: 'item' },
    { kind: 'inspect.primary', index: 1 },
    { kind: 'draft.confirmItems', level: 'broader' },
    { kind: 'draft.cancelItems' },
    { kind: 'draft.setItem' },
    { kind: 'draft.clearItem' },
    { kind: 'draft.addExclusion', selector: '.sponsored' },
    { kind: 'draft.removeExclusion', index: 0 },
    { kind: 'draft.addField', patch: { name: 'price', type: 'number' } },
    { kind: 'draft.updateField', index: 0, patch: { attr: null, key: true } },
    { kind: 'draft.removeField', index: 0 },
    { kind: 'draft.moveField', from: 0, to: 2 },
    { kind: 'draft.repickField', index: 1 },
    { kind: 'draft.markPagination' },
    { kind: 'draft.updatePagination', patch: { limit: 3, stopRules: ['no-new-items'] } },
    { kind: 'draft.clearPagination' },
    { kind: 'draft.setName', name: 'shop' },
    { kind: 'draft.setVar', name: 'tier', value: '1' },
    { kind: 'draft.reopen' },
    { kind: 'test.run' },
    { kind: 'test.clear' },
    { kind: 'save.request' },
  ];
  const host: HostMessage[] = [
    { kind: 'draft.state', state: sampleState },
    { kind: 'inspect.countResult', count: 24 },
    {
      kind: 'test.results',
      results: { rows: [{ _page: 1, _index: 0, title: 'x' }], rowCount: 1, fields: [{ name: 'title', status: 'ok' }], durationMs: 12, warnings: [] },
      state: sampleState,
    },
    { kind: 'save.result', ok: false, errors: [{ path: '$.fields', message: 'a recipe needs at least one field' }], state: sampleState },
    { kind: 'session.error', message: 'boom' },
  ];

  it('round-trips every message kind through JSON and parse', () => {
    expect(new Set(page.map((m) => m.kind))).toEqual(new Set(PAGE_MESSAGE_KINDS));
    expect(new Set(host.map((m) => m.kind))).toEqual(new Set(HOST_MESSAGE_KINDS));
    for (const message of [...page, ...host]) {
      const wire = JSON.parse(JSON.stringify(message));
      expect(parse(wire), message.kind).toEqual(message);
    }
    for (const message of page) expect(parsePageMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    for (const message of host) expect(parseHostMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
  });

  it('rejects malformed messages', () => {
    expect(() => parsePageMessage({ kind: 'draft.moveField', from: -1, to: 0 })).toThrow(ProtocolError);
    expect(() => parse({ kind: 'nope' })).toThrow(/invalid message/);
    expect(() => parseHostMessage({ kind: 'session.ready', url: 'x' })).toThrow(ProtocolError);
  });
});

describe('FakeInteractiveSession', () => {
  it('is an InteractiveSession that records injections, bindings, and dispatches', async () => {
    const browser = new FakeBrowser({ [CATALOG]: tier0Snapshot() });
    const session = await browser.open('/p', { bypassCSP: true });
    expect(isInteractiveSession(session)).toBe(true);
    expect(browser.openOptions[0]).toEqual({ bypassCSP: true });
    const navigations: string[] = [];
    session.onNavigated((url) => navigations.push(url));
    await session.inject('window.x = 1');
    await session.expose('__webscoopHost', async (msg) => ({ echo: msg }));
    await session.goto(CATALOG, { timeoutMs: 1000 });
    await session.dispatch({ kind: 'draft.state' });
    expect(session.injected).toEqual(['window.x = 1']);
    expect(navigations).toEqual([CATALOG]);
    expect(session.dispatchedOf('draft.state')).toHaveLength(1);
    expect(await session.callHost({ kind: 'ping' })).toEqual({ echo: { kind: 'ping' } });
    let closed = 0;
    session.onClosed(() => closed++);
    await session.userClose();
    expect(closed).toBe(1);
    await expect(session.dispatch({})).rejects.toThrow(/closed/);
  });
});

describe('draft reducer', () => {
  it('defaults links to url/href, images to image/src, numeric text to number', () => {
    expect(fieldDefaults({ tag: 'a', attrs: { href: '/p/1' }, role: 'link', name: 'View details', text: 'View details' }, [])).toEqual({
      name: 'view_details',
      type: 'url',
      attr: 'href',
    });
    expect(fieldDefaults({ tag: 'img', attrs: { src: '/i.svg', alt: 'Mouse' }, role: 'img', name: 'Mouse', text: '' }, ['mouse'])).toEqual({
      name: 'mouse_2',
      type: 'image',
      attr: 'src',
    });
    expect(fieldDefaults({ tag: 'p', attrs: {}, text: '$1,299.00' }, [])).toEqual({ name: 'f_1_299_00', type: 'number' });
    expect(fieldDefaults({ tag: 'h2', attrs: {}, role: 'heading', name: 'Wireless Mouse', text: 'Wireless Mouse' }, [])).toEqual({
      name: 'wireless_mouse',
      type: 'text',
    });
    expect(isNumericText('4.5')).toBe(true);
    expect(isNumericText('27-inch Monitor')).toBe(false);
    expect(slugName('')).toBe('field');
  });

  const field = (name: string) => ({
    name,
    type: 'text' as const,
    scope: 'page' as const,
    selectors: [{ strategy: 'css' as const, value: 'h1', stability: 'medium' as const }],
  });

  it('reports a duplicate name on the field and blocks nothing else', () => {
    let draft = reduceDraft(newDraft(), { type: 'addField', field: field('price') });
    draft = reduceDraft(draft, { type: 'addField', field: field('title') });
    expect(draft.fields.every((f) => f.error === undefined)).toBe(true);
    expect(draft.dirty).toBe(true);
    draft = reduceDraft(draft, { type: 'updateField', index: 1, patch: { name: 'price' } });
    expect(draft.fields[1]!.error).toMatch(/duplicate field name "price"/);
    expect(draft.fields[0]!.error).toBeUndefined();
    draft = reduceDraft(draft, { type: 'updateField', index: 1, patch: { name: 'title' } });
    expect(draft.fields[1]!.error).toBeUndefined();
  });

  it('surfaces schema errors per field and on the name', () => {
    let draft = reduceDraft(newDraft(), { type: 'addField', field: field('bad name') });
    expect(draft.fields[0]!.error).toMatch(/identifiers/);
    draft = reduceDraft(draft, { type: 'setName', name: 'Not Kebab' });
    expect(draft.nameError).toMatch(/kebab-case/);
    expect(newDraft().errors.map((e) => e.message)).toContain('a recipe needs at least one field');
  });

  it('updates the item count after an exclusion without marking counts dirty', () => {
    let draft = reduceDraft(newDraft(), {
      type: 'setItem',
      item: { selectors: [{ ...candidate, value: 'product-card' }], exclude: [], count: null, total: null },
    });
    draft = reduceDraft(draft, { type: 'setItemCounts', count: 24, total: 24 });
    draft = reduceDraft(draft, { type: 'addExclusion', candidate: { strategy: 'css', value: '.sponsored', stability: 'medium' } });
    draft = reduceDraft({ ...draft, dirty: false }, { type: 'setItemCounts', count: 22, total: 24 });
    expect(draft.item).toMatchObject({ count: 22, total: 24, exclude: [{ value: '.sponsored' }] });
    expect(draft.dirty).toBe(false);
  });

  it('reorders fields and keeps a single key', () => {
    let draft = newDraft();
    for (const name of ['a', 'b', 'c']) draft = reduceDraft(draft, { type: 'addField', field: field(name) });
    draft = reduceDraft(draft, { type: 'moveField', from: 2, to: 0 });
    expect(draft.fields.map((f) => f.name)).toEqual(['c', 'a', 'b']);
    draft = reduceDraft(draft, { type: 'updateField', index: 0, patch: { key: true } });
    draft = reduceDraft(draft, { type: 'updateField', index: 2, patch: { key: true } });
    expect(draft.fields.map((f) => f.key)).toEqual([false, false, true]);
  });
});

describe('pagination detection', () => {
  it('detects a numeric page parameter as url', () => {
    expect(detectPagination({ tag: 'a', attrs: { href: '/catalog?page=2' } }, 'http://h.test/catalog?page=1')).toEqual({
      kind: 'url',
      param: { name: 'page', start: 1, step: 1 },
    });
    expect(detectPagination({ tag: 'a', attrs: { href: '?tier=0&page=2' } }, 'http://h.test/catalog?tier=0')).toEqual({
      kind: 'url',
      param: { name: 'page', start: 1, step: 1 },
    });
    expect(detectPagination({ tag: 'a', attrs: { href: '/blog/page/3' } }, 'http://h.test/blog/page/2')).toEqual({
      kind: 'url',
      param: { name: 'page', start: 2, step: 1 },
    });
  });

  it('detects other links as next and buttons as more', () => {
    expect(detectPagination({ tag: 'a', attrs: { href: '/catalog?cursor=abc', rel: 'next' } }, 'http://h.test/catalog')).toEqual({ kind: 'next' });
    expect(detectPagination({ tag: 'button', attrs: {} }, 'http://h.test/catalog')).toEqual({ kind: 'more' });
    expect(detectPagination({ tag: 'div', attrs: {}, role: 'button' }, 'http://h.test/catalog')).toEqual({ kind: 'more' });
  });
});

describe('RecorderController', () => {
  it('proposes 24 items from one title with host counts on every candidate', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    expect(t.session.injected).toEqual(['/* recorder */']);
    await t.pick(byClass(t.page, 'product-title', 0));
    const state = t.controller.state;
    expect(state.selected!.selection.candidates.length).toBeGreaterThan(0);
    for (const c of state.selected!.selection.candidates) expect(c.count, `${c.strategy}=${c.value}`).toBeTypeOf('number');
    expect(state.selected!.selection.candidates.find((c) => c.strategy === 'role')?.count).toBe(1);
    expect(state.proposal!.proposed.count).toBe(24);
    expect(state.proposal!.proposed.paths).toHaveLength(24);
    expect(state.proposal!.proposed.selectors[0]).toMatchObject({ strategy: 'testid', value: 'product-card', count: 24 });
    for (const c of state.proposal!.proposed.selectors) expect(c.count).toBeTypeOf('number');
    expect(state.proposal!.proposed.samples[0]).toContain(dataset[0]!.title);
    expect(state.proposal!.broader).toMatchObject({ tag: 'li', count: 24 });
    expect(t.events.map((e) => e.name)).toEqual(['recorder.navigated', 'recorder.selected', 'recorder.itemsProposed']);
  });

  it('confirms the container and turns the pick into an item field', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    const title = byClass(t.page, 'product-title', 0);
    await t.pick(title);
    await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
    const { draft } = t.controller;
    expect(draft.item).toMatchObject({ count: 24, total: 24 });
    expect(draft.item!.selectors[0]!.value).toBe('product-card');
    expect(draft.fields).toHaveLength(1);
    expect(draft.fields[0]).toMatchObject({ name: 'wireless_mouse', type: 'text', scope: 'item', count: 24, sample: dataset[0]!.title });
    expect(draft.fields[0]!.selectors[0]).toMatchObject({ strategy: 'role', value: 'heading', count: 24 });

    // A later pick inside a card is item scoped and relative.
    const price = byClass(t.page, 'product-price', 3);
    await t.pick(price, cardPath(price));
    expect(t.controller.state.selected!.scope).toBe('item');
    expect(t.controller.state.selected!.defaults).toEqual({ name: 'f_1_299_00', type: 'number' });
    await t.send({ kind: 'draft.addField', patch: { name: 'price' } });
    await t.send({ kind: 'draft.updateField', index: 0, patch: { name: 'title' } });
    expect(t.controller.draft.fields.map((f) => [f.name, f.count, f.sample])).toEqual([
      ['title', 24, dataset[0]!.title],
      ['price', 24, String(dataset[0]!.price)],
    ]);

    const reply = (await t.send({ kind: 'test.run' })) as HostMessage & { kind: 'test.results' };
    expect(reply.results.rowCount).toBe(24);
    expect(reply.results.fields).toEqual([
      { name: 'title', status: 'ok' },
      { name: 'price', status: 'ok' },
    ]);
    expect(reply.results.rows.map((r) => r.title)).toEqual(dataset.map((p) => p.title));
  });

  it('excludes sponsored cards from the item count', async () => {
    const t = await harness(tier0Snapshot({ sponsored: 2 }), newDraft());
    await t.pick(byClass(t.page, 'product-title', 5));
    await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
    expect(t.controller.draft.item).toMatchObject({ count: 24, total: 24 });
    await t.send({ kind: 'draft.addExclusion', selector: '.sponsored' });
    expect(t.controller.draft.item).toMatchObject({ count: 22, total: 24, exclude: [{ strategy: 'css', value: '.sponsored', count: 2 }] });
    expect(t.controller.draft.fields[0]!.count).toBe(22);
    const results = await t.controller.testRun();
    expect(results.rowCount).toBe(22);
    expect(results.rows[0]!.wireless_mouse ?? results.rows[0]![t.controller.draft.fields[0]!.name]).toBe(dataset[2]!.title);
  });

  it('applies exclusions added while the proposal is shown', async () => {
    const t = await harness(tier0Snapshot({ sponsored: 2 }), newDraft());
    await t.pick(byClass(t.page, 'product-title', 5));
    await t.send({ kind: 'draft.addExclusion', selector: '.sponsored' });
    expect(t.controller.state.proposal!.proposed).toMatchObject({ count: 22, total: 24 });
    expect(t.controller.state.proposal!.exclude).toEqual([{ strategy: 'css', value: '.sponsored', stability: 'medium', count: 2 }]);
    await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
    expect(t.controller.draft.item).toMatchObject({ count: 22, total: 24, exclude: [{ value: '.sponsored' }] });
  });

  it('offers a page field when nothing repeats', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    await t.pick(byClass(t.page, 'category-heading'));
    expect(t.controller.state.proposal).toBeNull();
    expect(t.controller.state.selected!.scope).toBe('page');
    await t.send({ kind: 'draft.addField', patch: {} });
    expect(t.controller.draft.fields[0]).toMatchObject({ name: 'electronics', scope: 'page', count: 1, sample: 'Electronics' });
  });

  it('proposes url pagination for a numeric page link', async () => {
    const dom = h('html', {}, h('body', {}, h('main', {}, h('h1', {}, 'x')), h('nav', {}, h('a', { class: 'next', href: '/catalog?page=2' }, 'Next'))));
    const url = 'http://127.0.0.1:4777/catalog?page=1';
    const t = await harness(dom, emptyDraft({ name: 'paged', url, vars: [] }), url);
    await t.pick(byClass(t.page, 'next'));
    await t.send({ kind: 'draft.markPagination' });
    await t.send({ kind: 'draft.updatePagination', patch: { limit: 3 } });
    expect(t.controller.draft.pagination).toMatchObject({
      kind: 'url',
      param: { name: 'page', start: 1, step: 1 },
      limit: 3,
    });
    expect(t.controller.draft.pagination!.target!.selectors[0]).toMatchObject({ strategy: 'role', value: 'link|Next' });
  });

  it('runs the reference recipe on the current page', async () => {
    const t = await harness(tier0Snapshot(), draftFromRecipe(referenceRecipe()));
    const results = await t.controller.testRun();
    expect(results.rowCount).toBe(24);
    expect(results.rows).toHaveLength(24);
    expect(results.fields.map((f) => f.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(results.durationMs).toBeGreaterThan(0);
    expect(t.events.at(-1)).toEqual({ name: 'recorder.testRun', payload: { rows: 24, durationMs: results.durationMs } });
  });

  it('saves a draft that loads back with loadRecipe', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    const failed = (await t.send({ kind: 'save.request' })) as HostMessage & { kind: 'save.result' };
    expect(failed.ok).toBe(false);
    expect(t.storage.files.size).toBe(0);
    await t.pick(byClass(t.page, 'product-title', 0));
    await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
    await t.send({ kind: 'draft.updateField', index: 0, patch: { name: 'title' } });
    expect(t.controller.draft.dirty).toBe(true);
    const saved = (await t.send({ kind: 'save.request' })) as HostMessage & { kind: 'save.result' };
    expect(saved).toMatchObject({ ok: true, path: '/recipes/shop-catalog.json', errors: [] });
    expect(t.controller.draft.dirty).toBe(false);
    const recipe = loadRecipe(t.storage.files.get('shop-catalog')!);
    expect(recipe.url).toBe('http://127.0.0.1:4777/catalog?tier={tier}');
    expect(recipe.vars).toEqual([{ name: 'tier', type: 'string', default: '0' }]);
    expect(recipe.item!.selectors[0]).toEqual({ strategy: 'testid', value: 'product-card', stability: 'stable' });
    expect(recipe.fields[0]!.fingerprint?.tag).toBe('h2');
    expect(t.events.map((e) => e.name)).toContain('recorder.saved');
  });

  it('loads a recipe for editing and requests counts when the page is ready', async () => {
    const reference = referenceRecipe();
    const t = await harness(tier0Snapshot(), draftFromRecipe(reference));
    expect(t.controller.draft.fields.map((f) => f.count)).toEqual([null, null, null, null, null, null]);
    const reply = (await t.send({ kind: 'session.ready', url: CATALOG })) as HostMessage & { kind: 'draft.state' };
    expect(reply.state.draft.fields).toHaveLength(6);
    await t.controller.idle();
    expect(t.controller.draft.fields.map((f) => f.count)).toEqual([24, 24, 24, 24, 24, 1]);
    expect(t.controller.draft.item).toMatchObject({ count: 24, total: 24 });
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
