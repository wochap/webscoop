import { h } from '../src/testing';
import type { RecipeInput, SelectorCandidate } from '../src';

export const PAGE = 'https://shop.test/c/electronics';

export interface CardSpec {
  title: string;
  price?: string;
  ad?: boolean;
  /** Leave out the product link. */
  noLink?: boolean;
}

export function card(spec: CardSpec, index: number) {
  return h(
    'article',
    { class: `product-card${spec.ad ? ' ad' : ''}`, 'data-testid': 'product-card', id: `p${index}` },
    h('h2', { class: 'product-title' }, spec.title),
    spec.price !== undefined && h('span', { class: 'product-price', 'data-testid': 'price' }, spec.price),
    !spec.noLink && h('a', { class: 'product-link', href: `/p/${index}` }, 'View details'),
  );
}

export function catalog(cards: CardSpec[], category = 'Electronics') {
  return h(
    'html',
    {},
    h('head', {}, h('title', {}, 'Catalog')),
    h(
      'body',
      {},
      h(
        'main',
        {},
        h('h1', { class: 'category-heading', 'data-testid': 'category' }, category),
        h('ul', {}, cards.map((c, i) => h('li', {}, card(c, i)))),
      ),
    ),
  );
}

export function cards(n: number, extra: (i: number) => Partial<CardSpec> = () => ({})): CardSpec[] {
  return Array.from({ length: n }, (_, i) => ({ title: `Product ${i + 1}`, price: `$${i + 1}.00`, ...extra(i) }));
}

export const css = (value: string): SelectorCandidate => ({ strategy: 'css', value, stability: 'medium' });
export const testid = (value: string): SelectorCandidate => ({ strategy: 'testid', value, stability: 'stable' });

export function recipe(overrides: Partial<RecipeInput> = {}): RecipeInput {
  return {
    schemaVersion: 1,
    name: 'shop',
    url: 'https://shop.test/c/{category}',
    vars: [{ name: 'category', type: 'string', default: 'electronics' }],
    item: { selectors: [testid('product-card')] },
    fields: [
      { name: 'title', type: 'text', scope: 'item', selectors: [css('h2')] },
      { name: 'price', type: 'number', scope: 'item', selectors: [testid('price')] },
      { name: 'url', type: 'url', scope: 'item', selectors: [css('a.product-link')] },
      { name: 'category', type: 'text', scope: 'page', selectors: [testid('category')] },
    ],
    ...overrides,
  };
}

/** A category page with a heading, a product list, and a block of questions. */
export function mixedPage(products: CardSpec[], questions: string[], category = 'Electronics') {
  return h(
    'html',
    {},
    h('head', {}, h('title', {}, 'Catalog')),
    h(
      'body',
      {},
      h(
        'main',
        {},
        h('h1', { class: 'category-heading', 'data-testid': 'category' }, category),
        h('ul', {}, products.map((c, i) => h('li', {}, card(c, i)))),
        h(
          'section',
          { class: 'questions' },
          questions.map((q, i) => h('div', { class: 'question', 'data-testid': 'question', id: `q${i}` }, h('h3', {}, q))),
        ),
      ),
    ),
  );
}

/** Tables `page` (the heading), `products` (cards, keyed by url), and `questions`; scopes left to their defaults. */
export function tablesRecipe(overrides: Partial<RecipeInput> = {}): RecipeInput {
  const { item: _item, fields: _fields, ...rest } = recipe();
  return {
    ...rest,
    tables: [
      { name: 'page', fields: [{ name: 'heading', type: 'text', selectors: [testid('category')] }] },
      {
        name: 'products',
        item: { selectors: [testid('product-card')] },
        fields: [
          { name: 'title', type: 'text', selectors: [css('h2')] },
          { name: 'url', type: 'url', selectors: [css('a.product-link')], key: true },
        ],
      },
      { name: 'questions', item: { selectors: [testid('question')] }, fields: [{ name: 'title', type: 'text', selectors: [css('h3')] }] },
    ],
    ...overrides,
  };
}
