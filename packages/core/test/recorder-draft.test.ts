import { describe, expect, it } from 'vitest';
import { detectPagination, emptyDraft, fieldDefaults, isNumericText, reduceDraft, slugName, type Draft } from '../src';

const candidate = { strategy: 'testid', value: 'price', stability: 'stable' } as const;

function newDraft(): Draft {
  return emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?tier={tier}', vars: [{ name: 'tier', value: '0' }] });
}

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
    expect(draft.tables[0]!.fields.every((f) => f.error === undefined)).toBe(true);
    expect(draft.dirty).toBe(true);
    draft = reduceDraft(draft, { type: 'updateField', index: 1, patch: { name: 'price' } });
    expect(draft.tables[0]!.fields[1]!.error).toMatch(/duplicate field name "price"/);
    expect(draft.tables[0]!.fields[0]!.error).toBeUndefined();
    draft = reduceDraft(draft, { type: 'updateField', index: 1, patch: { name: 'title' } });
    expect(draft.tables[0]!.fields[1]!.error).toBeUndefined();
  });

  it('surfaces schema errors per field and on the name', () => {
    let draft = reduceDraft(newDraft(), { type: 'addField', field: field('bad name') });
    expect(draft.tables[0]!.fields[0]!.error).toMatch(/identifiers/);
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
    expect(draft.tables[0]!.item).toMatchObject({ count: 22, total: 24, exclude: [{ value: '.sponsored' }] });
    expect(draft.dirty).toBe(false);
  });

  it('reorders fields and keeps a single key', () => {
    let draft = newDraft();
    for (const name of ['a', 'b', 'c']) draft = reduceDraft(draft, { type: 'addField', field: field(name) });
    draft = reduceDraft(draft, { type: 'moveField', from: 2, to: 0 });
    expect(draft.tables[0]!.fields.map((f) => f.name)).toEqual(['c', 'a', 'b']);
    draft = reduceDraft(draft, { type: 'updateField', index: 0, patch: { key: true } });
    draft = reduceDraft(draft, { type: 'updateField', index: 2, patch: { key: true } });
    expect(draft.tables[0]!.fields.map((f) => f.key)).toEqual([false, false, true]);
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
