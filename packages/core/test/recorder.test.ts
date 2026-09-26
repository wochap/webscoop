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
  pathOf,
  ProtocolError,
  reduceDraft,
  slugName,
  type Draft,
  type Recipe,
  type HostMessage,
  type PageMessage,
  type AnnotatedNode,
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
  levelPick: null,
  editing: null,
  pendingSelect: null,
  selectorError: null,
  repick: null,
  repickStep: null,
  repickContext: null,
  guardContext: null,
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
    { kind: 'selection.clear' },
    { kind: 'selection.setSelector', selector: 'css=h3', scope: 'item', snapshot: h('html') },
    { kind: 'inspect.count', candidate, scope: 'item' },
    { kind: 'inspect.primary', index: 1 },
    { kind: 'draft.confirmItems', level: 'broader' },
    { kind: 'draft.cancelItems' },
    { kind: 'draft.editItem' },
    { kind: 'draft.setLevel', level: 'within', by: 'pick', path: [1, 0, 1] },
    { kind: 'draft.setLevel', level: 'item', by: 'selector', selector: 'role=listitem' },
    { kind: 'draft.setLevel', level: 'within', by: 'clear', snapshot: h('html') },
    { kind: 'draft.pickLevel', level: 'item' },
    { kind: 'draft.toggleIncludeAll' },
    { kind: 'draft.setPrimary', level: 'item', index: 1, rung: 'broader' },
    { kind: 'draft.setPrimary', level: 'within', index: 0 },
    { kind: 'draft.setItem' },
    { kind: 'draft.clearItem' },
    { kind: 'draft.addExclusion', selector: '.sponsored' },
    { kind: 'draft.removeExclusion', index: 0 },
    { kind: 'draft.addField', patch: { name: 'price', type: 'number' } },
    { kind: 'draft.updateField', index: 0, patch: { attr: null, key: true } },
    { kind: 'draft.removeField', index: 0 },
    { kind: 'draft.editField', index: 1 },
    { kind: 'draft.updateEditedField', patch: { name: 'amount', type: 'number', scope: 'item', attr: null, optional: true, key: false } },
    { kind: 'draft.cancelEdit' },
    { kind: 'draft.moveField', from: 0, to: 2 },
    { kind: 'draft.repickTarget', target: 'field', index: 1 },
    { kind: 'draft.addStep', step: { kind: 'type', value: 'mouse' }, selection },
    { kind: 'draft.updateStep', index: 0, patch: { value: '{q}', optional: true, label: null } },
    { kind: 'draft.removeStep', index: 0 },
    { kind: 'draft.moveStep', from: 1, to: 0 },
    { kind: 'draft.replayStep', index: 0 },
    { kind: 'draft.markPagination' },
    { kind: 'draft.updatePagination', patch: { limit: 3, stopRules: ['no-new-items'] } },
    { kind: 'draft.clearPagination' },
    { kind: 'draft.setName', name: 'shop' },
    { kind: 'draft.setVar', name: 'tier', value: '1' },
    { kind: 'draft.reopen' },
    { kind: 'test.run' },
    { kind: 'test.clear' },
    { kind: 'save.request' },
    { kind: 'repick.confirm' },
    { kind: 'repick.skip' },
    { kind: 'repick.abort' },
    { kind: 'guard.continue' },
    { kind: 'guard.abort' },
  ];
  const host: HostMessage[] = [
    { kind: 'draft.state', state: sampleState },
    { kind: 'inspect.countResult', count: 24 },
    {
      kind: 'test.results',
      results: { rows: [{ _page: 1, _index: 0, title: 'x' }], rowCount: 1, dropped: { count: 0, fields: [] }, fields: [{ name: 'title', status: 'ok' }], durationMs: 12, warnings: [] },
      state: sampleState,
    },
    { kind: 'save.result', ok: false, errors: [{ path: '$.fields', message: 'a recipe needs at least one field' }], state: sampleState },
    { kind: 'session.error', message: 'boom' },
    { kind: 'step.replayResult', index: 0, ok: true, message: 'replayed step 1 (click)', state: sampleState },
    { kind: 'session.detach' },
    {
      kind: 'draft.state',
      state: {
        ...sampleState,
        repick: 0,
        repickContext: { field: 'price', index: 0, oldSelector: candidate, fingerprint: fp, sample: '$1', threshold: 0.7, reason: 'run', picked: { score: 0.91, sample: '$2', selector: candidate } },
      },
    },
    {
      kind: 'draft.state',
      state: {
        ...sampleState,
        levelPick: { level: 'within', ancestorOf: [[1, 0, 1, 2]], ofContainers: false, descendantOf: null, containing: null },
        proposal: {
          within: { tag: 'ul', label: 'ul.product-list', path: [1, 0, 1], selectors: [{ strategy: 'role', value: 'list', stability: 'stable', count: 1 }], primary: 0, count: 1, total: 1, paths: [[1, 0, 1]], samples: [] },
          proposed: { tag: 'article', label: 'article.card', path: [1, 0, 1, 0, 0], selectors: [{ strategy: 'class', value: 'article.card.kXeqYt', stability: 'fragile', count: 24 }], primary: 0, count: 24, total: 24, paths: [], samples: [] },
          broader: null,
          narrower: null,
          skipped: 6,
          includeAll: false,
          error: { level: 'item', message: 'matches nothing' },
          exclude: [],
          editing: true,
        },
      },
    },
    {
      kind: 'draft.state',
      state: {
        ...sampleState,
        selected: { selection: { ...selection, candidates: [{ ...candidate, count: 7, items: 7 }] }, scope: 'item', defaults: { name: 'price', type: 'number' }, primary: 0 },
        editing: { index: 0, options: { name: 'price', type: 'number', scope: 'item', optional: true, key: false }, candidates: [{ ...candidate, count: 0, items: 0 }], primary: 0 },
        pendingSelect: { path: [1, 0, 2] },
        selectorError: '"css=.nope" matches nothing',
      },
    },
    {
      kind: 'draft.state',
      state: { ...sampleState, guardContext: { kind: 'login', reason: 'redirected to a login page', page: 1, url: CATALOG, deadline: 1_700_000_000_000 } },
    },
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

  it('defaults the proposal editing flag to false', () => {
    const view = (host.find((m) => m.kind === 'draft.state' && m.state.proposal) as HostMessage & { kind: 'draft.state' }).state.proposal!;
    const { editing: _editing, ...rest } = view;
    const parsed = parseHostMessage(JSON.parse(JSON.stringify({ kind: 'draft.state', state: { ...sampleState, proposal: rest } })));
    expect(parsed.kind === 'draft.state' && parsed.state.proposal!.editing).toBe(false);
    expect(parsePageMessage({ kind: 'draft.editItem' })).toEqual({ kind: 'draft.editItem' });
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
    expect(state.proposal!.proposed.selectors.slice(0, 2)).toMatchObject([
      { strategy: 'role', value: 'article', count: 24 },
      { strategy: 'testid', value: 'product-card', count: 24 },
    ]);
    expect(state.proposal!.within).toMatchObject({ tag: 'ul', count: 1 });
    expect(state.proposal!.within!.selectors[0]).toMatchObject({ strategy: 'role', value: 'list', count: 1 });
    expect(state.proposal!.within!.selectors.map((c) => c.value)).toContain('product-list');
    expect(state.proposal!.skipped).toBe(0);
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
    expect(draft.item!.selectors.slice(0, 2).map((c) => c.value)).toEqual(['article', 'product-card']);
    expect(draft.item!.within![0]).toMatchObject({ strategy: 'role', value: 'list' });
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

  it('drops rows missing a required field and reports them', async () => {
    const reference = referenceRecipe();
    // Every article, questions blocks included; only the link is required.
    const r: Recipe = {
      ...reference,
      item: { ...reference.item!, selectors: [{ strategy: 'css', value: 'article', stability: 'medium' }] },
      fields: reference.fields.map((f) => ({ ...f, optional: f.name !== 'url' })),
    };
    const t = await harness(tier0Snapshot({ mixed: true }), draftFromRecipe(r));
    const results = await t.controller.testRun();
    expect(results.rowCount).toBe(24);
    expect(results.rows.every((row) => typeof row.url === 'string')).toBe(true);
    expect(results.dropped).toEqual({ count: 6, fields: ['url'] });
    expect(results.fields.find((f) => f.name === 'url')?.status).toBe('partial');
    expect(results.warnings[0]).toMatch(/^dropped 6 rows on page 1: required field "url" missing on rows /);
    expect(results.error).toBeUndefined();
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
    expect(recipe.item!.selectors[0]).toEqual({ strategy: 'role', value: 'article', stability: 'stable' });
    expect(recipe.item!.selectors[1]).toEqual({ strategy: 'testid', value: 'product-card', stability: 'stable' });
    expect(recipe.item!.within![0]).toEqual({ strategy: 'role', value: 'list', stability: 'stable' });
    expect(recipe.item!.withinFingerprint?.tag).toBe('ul');
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

describe('RecorderController proposal fields', () => {
  const title = (t: { page: AnnotatedNode }, nth = 0) => byClass(t.page, 'product-title', nth);
  const proposal = (t: { controller: { state: RecorderState } }) => t.controller.state.proposal!;

  it('reports skipped dissimilar siblings on the mixed catalog', async () => {
    const t = await harness(tier0Snapshot({ mixed: true }), newDraft());
    await t.pick(title(t, 1));
    expect(proposal(t)).toMatchObject({ skipped: 6, includeAll: false, error: null });
    expect(proposal(t).within!.label).toBe('ul.product-list');
    expect(proposal(t).proposed).toMatchObject({ tag: 'article', count: 24 });
    expect(proposal(t).proposed.paths).toHaveLength(24);
    expect(t.events.find((e) => e.name === 'recorder.itemsProposed')!.payload).toMatchObject({ count: 24, within: 'list', skipped: 6 });
  });

  it('toggles include all siblings', async () => {
    const t = await harness(tier0Snapshot({ mixed: true }), newDraft());
    await t.pick(title(t, 1));
    await t.send({ kind: 'draft.toggleIncludeAll' });
    expect(proposal(t)).toMatchObject({ skipped: 0, includeAll: true });
    expect(proposal(t).proposed).toMatchObject({ count: 30 });
    expect(proposal(t).proposed.paths).toHaveLength(30);
    expect(proposal(t).proposed.selectors[0]).toMatchObject({ strategy: 'role', value: 'article', count: 30 });
    await t.send({ kind: 'draft.toggleIncludeAll' });
    expect(proposal(t)).toMatchObject({ skipped: 6, includeAll: false });
    expect(proposal(t).proposed.count).toBe(24);
  });

  it('narrows and widens the list parent by picking', async () => {
    const t = await harness(tier0Snapshot({ rows: 4 }), newDraft());
    await t.pick(title(t, 5));
    expect(proposal(t).proposed.count).toBe(24);
    const row = byClass(t.page, 'product-row', 1);
    await t.send({ kind: 'draft.pickLevel', level: 'within' });
    expect(t.controller.state.levelPick).toEqual({ level: 'within', ancestorOf: [proposal(t).proposed.path], ofContainers: false, descendantOf: null, containing: null });
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'pick', path: pathOf(row) });
    expect(t.controller.state.levelPick).toBeNull();
    expect(proposal(t).within!.path).toEqual(pathOf(row));
    expect(proposal(t).proposed.count).toBe(4);
    expect(proposal(t).proposed.paths).toHaveLength(4);
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'pick', path: pathOf(byClass(t.page, 'product-list')) });
    expect(proposal(t).proposed.count).toBe(24);
    expect(proposal(t).proposed.paths).toHaveLength(24);
    // An element that is not an ancestor of the item is refused and nothing changes.
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'pick', path: pathOf(byClass(t.page, 'category-heading')) });
    expect(proposal(t).error).toMatchObject({ level: 'within', message: expect.stringContaining('outside the list') });
    expect(proposal(t).proposed.count).toBe(24);
  });

  it('sets the item level by typed selector and refuses one that matches nothing', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    await t.pick(title(t, 2));
    await t.send({ kind: 'draft.setLevel', level: 'item', by: 'selector', selector: 'role=listitem' });
    expect(proposal(t).error).toBeNull();
    expect(proposal(t).proposed).toMatchObject({ tag: 'li', count: 24 });
    expect(proposal(t).proposed.selectors[0]).toMatchObject({ strategy: 'role', value: 'listitem', count: 24 });
    expect(proposal(t).proposed.paths).toHaveLength(24);
    await t.send({ kind: 'draft.setLevel', level: 'item', by: 'selector', selector: '.no-such-card' });
    expect(proposal(t).error).toEqual({ level: 'item', message: '".no-such-card" matches nothing inside the list parent' });
    expect(proposal(t).proposed.selectors[0]).toMatchObject({ strategy: 'role', value: 'listitem', count: 24 });
    await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
    expect(t.controller.draft.item!.selectors[0]).toMatchObject({ strategy: 'role', value: 'listitem' });
    expect(t.controller.draft.item!.count).toBe(24);
    expect(t.controller.draft.fields[0]).toMatchObject({ scope: 'item', count: 24 });
  });

  it('picks the item level inside the list parent only', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    const pick = title(t, 2);
    await t.pick(pick);
    await t.send({ kind: 'draft.pickLevel', level: 'item' });
    expect(t.controller.state.levelPick).toMatchObject({ level: 'item', descendantOf: proposal(t).within!.path, containing: pathOf(pick) });
    await t.send({ kind: 'draft.setLevel', level: 'item', by: 'pick', path: pathOf(pick.parent!.parent!) });
    expect(proposal(t).proposed).toMatchObject({ tag: 'li', count: 24 });
    await t.send({ kind: 'draft.setLevel', level: 'item', by: 'pick', path: pathOf(title(t, 3)) });
    expect(proposal(t).error?.message).toContain('holds the selected element');
  });

  it('saves the list parent with the chosen primaries, and leaves it out when cleared', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    await t.pick(title(t, 0));
    const broader = proposal(t).broader!;
    const role = broader.selectors.findIndex((c) => c.strategy === 'role');
    const css = broader.selectors.findIndex((c) => c.strategy === 'css');
    await t.send({ kind: 'draft.setPrimary', level: 'item', index: css, rung: 'broader' });
    expect(proposal(t).broader!.primary).toBe(css);
    await t.send({ kind: 'draft.setPrimary', level: 'item', index: role, rung: 'broader' });
    const withinCss = proposal(t).within!.selectors.findIndex((c) => c.strategy === 'css');
    await t.send({ kind: 'draft.setPrimary', level: 'within', index: withinCss });
    await t.send({ kind: 'draft.confirmItems', level: 'broader' });
    const item = t.controller.draft.item!;
    expect(item.selectors[0]).toMatchObject({ strategy: 'role', value: 'listitem' });
    expect(item.within![0]).toMatchObject({ strategy: 'css', value: 'ul.product-list' });
    expect(item.withinFingerprint?.tag).toBe('ul');
    expect(item.withinCount).toBe(1);
    await t.send({ kind: 'draft.setName', name: 'shop-within' });
    await t.send({ kind: 'save.request' });
    const saved = loadRecipe(t.storage.files.get('shop-within')!);
    expect(saved.item!.selectors[0]).toEqual({ strategy: 'role', value: 'listitem', stability: 'stable' });
    expect(saved.item!.within![0]).toEqual({ strategy: 'css', value: 'ul.product-list', stability: 'medium' });

    const cleared = await harness(tier0Snapshot(), newDraft());
    await cleared.pick(title(cleared, 0));
    await cleared.send({ kind: 'draft.setLevel', level: 'within', by: 'clear' });
    expect(proposal(cleared).within).toBeNull();
    expect(proposal(cleared).proposed.count).toBe(24);
    await cleared.send({ kind: 'draft.confirmItems', level: 'proposed' });
    expect(cleared.controller.draft.item!.within).toBeUndefined();
    await cleared.send({ kind: 'save.request' });
    expect(loadRecipe(cleared.storage.files.get('shop-catalog')!).item).not.toHaveProperty('within');
  });

  it('re-picks and clears the list parent from the confirmed item', async () => {
    const t = await harness(tier0Snapshot(), newDraft());
    await t.pick(title(t, 0));
    await t.send({ kind: 'draft.setItem' });
    expect(t.controller.draft.item!.within).toBeUndefined();
    await t.send({ kind: 'draft.pickLevel', level: 'within' });
    expect(t.controller.state.levelPick).toMatchObject({ level: 'within', ofContainers: true });
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'pick', path: pathOf(byClass(t.page, 'product-list')), snapshot: t.snapshot });
    expect(t.controller.draft.item!.within![0]).toMatchObject({ strategy: 'role', value: 'list' });
    expect(t.controller.draft.item).toMatchObject({ withinCount: 1 });
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'pick', path: pathOf(byClass(t.page, 'category-heading')), snapshot: t.snapshot });
    expect(t.controller.state.error).toContain('outside the list');
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'clear' });
    expect(t.controller.draft.item!.within).toBeUndefined();
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'selector', selector: 'css=ul.product-list' });
    expect(t.controller.draft.item!.within![0]).toMatchObject({ strategy: 'css', value: 'ul.product-list', count: 1 });
  });

  it('relativizes item fields at a bare div container', async () => {
    const item = (i: number) =>
      h('div', { class: 'asEBEc' }, h('div', {}, h('div', {}, h('span', {}, 'Price')), h('div', {}, h('span', { class: 'price kXeqYt' }, `$${i}.00`))), h('h3', {}, `Item ${i}`));
    const dom = h('html', {}, h('body', {}, h('main', { class: 'results' }, Array.from({ length: 5 }, (_, i) => item(i + 1)))));
    const t = await harness(dom, newDraft());
    const price = byClass(t.page, 'price', 1);
    await t.pick(price);
    expect(proposal(t).proposed.count).toBe(5);
    expect(proposal(t).within!.label).toBe('main.results');
    await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
    const field = t.controller.draft.fields[0]!;
    expect(field.selectors[0]).toMatchObject({ strategy: 'css', value: 'span.price', count: 5 });
    expect(field.selectors.map((c) => [c.strategy, c.value])).toContainEqual(['class', 'span.price.kXeqYt']);
    expect(field.selectors.map((c) => [c.strategy, c.value])).toContainEqual(['xpath', './div[1]/div[2]/span[1]']);
    // A later pick inside a container is relative to that container too.
    const other = byClass(t.page, 'price', 3);
    await t.pick(other, pathOf(other.parent!.parent!.parent!));
    expect(t.controller.state.selected!.selection.candidates[0]).toMatchObject({ strategy: 'css', value: 'span.price', count: 5 });
  });
});
