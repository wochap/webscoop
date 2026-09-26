import { describe, expect, it } from 'vitest';
import { countItems, extractPage, loadRecipe, resolveFirst } from '../src';
import { FakeBrowser } from '../src/testing';
import { catalog, cards, css, mixedPage, PAGE, recipe, tablesRecipe, testid } from './helpers';

async function session(dom: ReturnType<typeof catalog>) {
  const s = await new FakeBrowser({ [PAGE]: dom }).open('/profile');
  await s.goto(PAGE, { timeoutMs: 1000 });
  return s;
}

describe('candidate resolution order', () => {
  it('uses the first candidate that resolves', async () => {
    const s = await session(catalog(cards(2)));
    const result = await resolveFirst(s, [css('.nope'), testid('price'), css('.product-price')]);
    expect(result?.index).toBe(1);
    expect(result?.refs).toHaveLength(2);
  });

  it('reports the second candidate when the first fails', async () => {
    const s = await session(catalog(cards(3)));
    const r = loadRecipe(
      recipe({
        fields: [{ name: 'title', type: 'text', scope: 'item', selectors: [css('h3.gone'), css('h2')] }],
      }),
    );
    const out = (await extractPage(s, r, { pageUrl: PAGE, page: 1 })).tables[0]!;
    expect(out.fields[0]!.candidateIndex).toBe(1);
    expect(out.fields[0]!.candidate).toEqual(css('h2'));
    expect(out.rows.map((row) => row.title)).toEqual(['Product 1', 'Product 2', 'Product 3']);
  });
});

describe('item scoped extraction', () => {
  it('drops excluded containers', async () => {
    const s = await session(catalog(cards(24, (i) => ({ ad: i === 3 || i === 10 }))));
    const r = loadRecipe(recipe({ item: { selectors: [testid('product-card')], exclude: [css('.ad')] } }));
    const out = (await extractPage(s, r, { pageUrl: PAGE, page: 1 })).tables[0]!;
    expect(out.rows).toHaveLength(22);
    expect(out.item?.count).toBe(22);
    expect(out.rows.map((row) => row._index)).toEqual([...Array(22).keys()]);
    expect(out.rows.some((row) => row.title === 'Product 4')).toBe(false);
  });

  it('yields one row per container, repeats page fields, and converts values', async () => {
    const s = await session(catalog(cards(24)));
    const out = (await extractPage(s, loadRecipe(recipe()), { pageUrl: PAGE, page: 1 })).tables[0]!;
    expect(out.rows).toHaveLength(24);
    expect(new Set(out.rows.map((row) => row.category))).toEqual(new Set(['Electronics']));
    expect(out.rows[4]).toEqual({
      _page: 1,
      _index: 4,
      title: 'Product 5',
      price: 5,
      url: 'https://shop.test/p/4',
      category: 'Electronics',
    });
    expect(out.fields.every((f) => f.status === 'ok')).toBe(true);
  });

  it('uses the first match inside a container', async () => {
    const s = await session(catalog(cards(2)));
    const r = loadRecipe(recipe({ fields: [{ name: 'any', type: 'text', scope: 'item', selectors: [css('*')] }] }));
    const out = (await extractPage(s, r, { pageUrl: PAGE, page: 1 })).tables[0]!;
    expect(out.rows.map((row) => row.any)).toEqual(['Product 1', 'Product 2']);
  });

  it('yields exactly one row without an item block', async () => {
    const s = await session(catalog(cards(3)));
    const { item: _, ...rest } = recipe({
      fields: [{ name: 'category', type: 'text', scope: 'page', selectors: [testid('category')] }],
    });
    const out = (await extractPage(s, loadRecipe(rest), { pageUrl: PAGE, page: 1 })).tables[0]!;
    expect(out.rows).toEqual([{ _page: 1, _index: 0, category: 'Electronics' }]);
  });
});

describe('missing fields', () => {
  it('flags a required field missing on every row', async () => {
    const s = await session(catalog(cards(3, () => ({ price: undefined }))));
    const out = (await extractPage(s, loadRecipe(recipe()), { pageUrl: PAGE, page: 1 })).tables[0]!;
    expect(out.missingRequired).toEqual(['price']);
    expect(out.fields.find((f) => f.name === 'price')?.status).toBe('missing');
  });

  it('drops the row and warns naming the row when missing on some rows', async () => {
    const s = await session(catalog(cards(24, (i) => (i === 7 ? { price: undefined } : {}))));
    const out = (await extractPage(s, loadRecipe(recipe()), { pageUrl: PAGE, page: 1 })).tables[0]!;
    expect(out.missingRequired).toEqual([]);
    expect(out.rows).toHaveLength(23);
    expect(out.rows.some((row) => row.price === null)).toBe(false);
    expect(out.rows.some((row) => row.title === 'Product 8')).toBe(false);
    expect(out.rows.map((row) => row._index)).toEqual([...Array(23).keys()]);
    expect(out.containerCount).toBe(24);
    expect(out.firstRow?.title).toBe('Product 1');
    expect(out.dropped).toEqual([{ index: 7, fields: ['price'] }]);
    expect(out.fields.find((f) => f.name === 'price')).toMatchObject({ status: 'partial', missingRows: [7] });
    expect(out.warnings).toEqual(['dropped 1 row on page 1: required field "price" missing on row 7']);
  });

  it('keeps the first row before dropping', async () => {
    const s = await session(catalog(cards(3, (i) => (i === 0 ? { noLink: true } : {}))));
    const out = (await extractPage(s, loadRecipe(recipe()), { pageUrl: PAGE, page: 1 })).tables[0]!;
    expect(out.rows.map((row) => row.title)).toEqual(['Product 2', 'Product 3']);
    expect(out.firstRow).toMatchObject({ _index: 0, title: 'Product 1', url: null });
  });

  it('leaves no rows when two required fields are missing on disjoint halves', async () => {
    const s = await session(catalog(cards(24, (i) => (i < 12 ? { noLink: true } : { price: undefined }))));
    const out = (await extractPage(s, loadRecipe(recipe()), { pageUrl: PAGE, page: 1 })).tables[0]!;
    expect(out.rows).toEqual([]);
    expect(out.containerCount).toBe(24);
    expect(out.missingRequired).toEqual([]);
    expect(out.dropped).toHaveLength(24);
    expect(out.dropped[0]).toEqual({ index: 0, fields: ['url'] });
    expect(out.dropped[23]).toEqual({ index: 23, fields: ['price'] });
    expect(out.fields.filter((f) => f.status === 'partial').map((f) => f.name)).toEqual(['price', 'url']);
  });

  it('yields null for an optional field missing on one row', async () => {
    const s = await session(catalog(cards(24, (i) => (i === 3 ? { price: undefined } : {}))));
    const base = recipe();
    base.fields = base.fields!.map((f) => (f.name === 'price' ? { ...f, optional: true } : f));
    const out = (await extractPage(s, loadRecipe(base), { pageUrl: PAGE, page: 1 })).tables[0]!;
    expect(out.rows).toHaveLength(24);
    expect(out.rows[3]!.price).toBeNull();
    expect(out.dropped).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  it('yields null without failure for optional fields', async () => {
    const s = await session(catalog(cards(3)));
    const base = recipe();
    base.fields!.push({ name: 'badge', type: 'text', scope: 'item', selectors: [css('.badge')], optional: true });
    const out = (await extractPage(s, loadRecipe(base), { pageUrl: PAGE, page: 1 })).tables[0]!;
    expect(out.missingRequired).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect(out.rows.every((row) => row.badge === null)).toBe(true);
    expect(out.fields.find((f) => f.name === 'badge')?.status).toBe('missing');
  });

  it('flags the item container when it matches nothing', async () => {
    const s = await session(catalog([]));
    const out = (await extractPage(s, loadRecipe(recipe()), { pageUrl: PAGE, page: 1 })).tables[0]!;
    expect(out.rows).toEqual([]);
    expect(out.missingRequired).toEqual(['item']);
  });
});

describe('tables', () => {
  it('extracts a page table and two lists from one page', async () => {
    const s = await session(mixedPage(cards(5), ['Is it waterproof?', 'Does it ship abroad?', 'Warranty?']));
    const out = await extractPage(s, loadRecipe(tablesRecipe()), { pageUrl: PAGE, page: 1 });
    expect(out.tables.map((t) => t.name)).toEqual(['page', 'products', 'questions']);
    const [page, products, questions] = out.tables;
    expect(page!.rows).toEqual([{ _page: 1, _index: 0, heading: 'Electronics' }]);
    expect(products!.rows).toHaveLength(5);
    expect(questions!.rows.map((r) => r.title)).toEqual(['Is it waterproof?', 'Does it ship abroad?', 'Warranty?']);
    expect(products!.rows.every((r) => !('heading' in r))).toBe(true);
    expect(Object.keys(products!.rows[0]!)).toEqual(['_page', '_index', 'title', 'url']);
    expect(out.resolved).toHaveLength(3);
    expect(out.resolved.every((r) => r !== null)).toBe(true);
  });

  it('leaves a list that matched nothing unresolved for a later page', async () => {
    const s = await session(mixedPage(cards(2), []));
    const out = await extractPage(s, loadRecipe(tablesRecipe()), { pageUrl: PAGE, page: 1 });
    expect(out.tables[2]!.rows).toEqual([]);
    expect(out.tables[2]!.missingRequired).toEqual(['item']);
    expect(out.resolved[2]).toBeNull();
    expect(out.resolved[1]).not.toBeNull();
  });

  it('applies fromIndex to the primary table only', async () => {
    const s = await session(mixedPage(cards(6), ['a', 'b']));
    const recipe = loadRecipe(tablesRecipe());
    const first = await extractPage(s, recipe, { pageUrl: PAGE, page: 1 });
    const grown = await extractPage(s, recipe, { pageUrl: PAGE, page: 2, resolved: first.resolved, fromIndex: 4 });
    expect(grown.tables[1]!.rows.map((r) => r.title)).toEqual(['Product 5', 'Product 6']);
    expect(grown.tables[2]!.rows).toHaveLength(2);
    expect(grown.tables[0]!.rows).toHaveLength(1);
  });

  it('counts the primary table containers, or one per page without an item table', async () => {
    const s = await session(mixedPage(cards(7), ['a', 'b', 'c']));
    const recipe = loadRecipe(tablesRecipe());
    const first = await extractPage(s, recipe, { pageUrl: PAGE, page: 1 });
    expect(await countItems(s, recipe, first.resolved)).toBe(7);
    const pageOnly = loadRecipe(tablesRecipe({ tables: [tablesRecipe().tables![0]!] }));
    expect(await countItems(s, pageOnly, [{ item: null, fields: [[testid('category')]] }])).toBe(1);
  });
});
