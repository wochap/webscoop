import { dataset } from '@webscoop/playground';
import { describe, expect, it } from 'vitest';
import {
  annotate,
  classifyToken,
  compoundOf,
  descendantsOf,
  elementChildren,
  fingerprint,
  generate,
  inferItems,
  loadRecipe,
  pathOf,
  rank,
  relativize,
  SIMILARITY_THRESHOLD,
  type AnnotatedNode,
  type Candidate,
  type SerializedElement,
  type Session,
} from '../src';
import { FakeBrowser, h } from '../src/testing';
import { readFileSync } from 'node:fs';
import { tier0Snapshot } from './snapshot';

const find = (root: AnnotatedNode, test: (n: AnnotatedNode) => boolean): AnnotatedNode => {
  const hit = descendantsOf(root).find(test);
  if (!hit) throw new Error('fixture node not found');
  return hit;
};
const byClass = (root: AnnotatedNode, cls: string, nth = 0) =>
  descendantsOf(root).filter((n) => (n.attrs.class ?? '').split(' ').includes(cls))[nth]!;
const strategies = (candidates: Candidate[]) => candidates.map((c) => c.strategy);
const pick = (candidates: Candidate[], strategy: Candidate['strategy']) => candidates.find((c) => c.strategy === strategy);

async function fakeSession(dom: SerializedElement): Promise<Session> {
  const session = await new FakeBrowser({ 'https://t.test/': dom }).open('/p');
  await session.goto('https://t.test/', { timeoutMs: 1000 });
  return session;
}

describe('annotate', () => {
  it('keeps h() fixtures valid and adds parent links, roles, and names', () => {
    const el: SerializedElement = h('main', {}, h('h1', {}, 'Hi'));
    const root = annotate(el);
    const heading = elementChildren(root)[0]!;
    expect(heading.parent).toBe(root);
    expect(heading.role).toBe('heading');
    expect(heading.name).toBe('Hi');
    expect(root.role).toBe('main');
    expect(root.name).toBeUndefined();
  });

  it('annotates the tier 0 snapshot', () => {
    const root = annotate(tier0Snapshot());
    expect(root.tag).toBe('html');
    const cards = descendantsOf(root).filter((n) => n.attrs['data-testid'] === 'product-card');
    expect(cards).toHaveLength(24);
    const title = byClass(root, 'product-title');
    expect(title.role).toBe('heading');
    expect(title.name).toBe(dataset[0]!.title);
    expect(title.parent?.tag).toBe('article');
    expect(pathOf(title)).toEqual(pathOf(title.parent!).concat(1));
  });

  it('keeps annotations sent with the snapshot', () => {
    const el = { ...h('h2', {}, 'x'), role: 'heading', name: 'Other', bbox: { x: 1, y: 2, w: 3, h: 4 } };
    const node = annotate(el);
    expect(node.name).toBe('Other');
    expect(node.bbox).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
});

describe('classifyToken', () => {
  it.each([
    ['sc-bdfBwQ', 'hashed'],
    ['css-1x2y3z', 'hashed'],
    ['jsx-123', 'hashed'],
    ['item-48213', 'hashed'],
    ['kXeqYt', 'hashed'],
    ['emotion-0', 'hashed'],
    ['card', 'stable'],
    ['product-card', 'stable'],
    ['pc__price', 'stable'],
    ['product-p02', 'stable'],
    ['asEBEc', 'hashed'],
    ['bdfBwQ', 'hashed'],
    ['navBar', 'stable'],
    ['iOS', 'stable'],
    ['itemUSD', 'stable'],
  ])('%s is %s', (token, expected) => {
    expect(classifyToken(token)).toBe(expected);
  });
});

describe('generate', () => {
  it('anchors CSS on a readable test hook attribute other than data-testid', () => {
    const root = annotate(
      h(
        'html',
        {},
        h(
          'body',
          {},
          h('section', { class: 'x1a2b3c', 'data-qa': 'product-card' }, h('div', {}, h('span', {}, 'Cost:'), h('span', { class: 'x9z8y7w', 'data-qa': 'price' }, '$1.00'))),
          h('div', { 'data-cy': 'a9f3k2m7' }, h('span', {}, 'x')),
        ),
      ),
    );
    const price = find(root, (n) => n.attrs['data-qa'] === 'price');
    expect(compoundOf(price)).toBe('span[data-qa="price"]');
    expect(pick(generate(price), 'css')).toEqual({ strategy: 'css', value: 'span[data-qa="price"]', stability: 'medium' });
    const label = find(root, (n) => n.tag === 'span' && !n.attrs['data-qa'] && n.parent?.tag === 'div' && n.parent.parent?.tag === 'section');
    expect(pick(generate(label), 'css')!.value).toBe('section[data-qa="product-card"] > div > span');
    // Hashed values are not hooks.
    const hashed = find(root, (n) => n.attrs['data-cy'] === 'a9f3k2m7');
    expect(compoundOf(hashed)).toBe('div');
    const card = find(root, (n) => n.tag === 'section');
    const relative = relativize(pick(generate(price), 'css')!, compoundOf(card));
    expect(relative?.value).toBe('span[data-qa="price"]');
  });

  it('produces role, testid, text, css, and xpath for a heading with a testid, and no id', () => {
    const root = annotate(h('html', {}, h('body', {}, h('h3', { 'data-testid': 'product-title' }, 'Wireless Mouse'))));
    const node = find(root, (n) => n.tag === 'h3');
    const candidates = generate(node);
    expect(strategies(candidates)).toEqual(['role', 'testid', 'text', 'css', 'xpath']);
    expect(pick(candidates, 'role')).toEqual({ strategy: 'role', value: 'heading|Wireless Mouse', stability: 'stable' });
    expect(pick(candidates, 'testid')).toEqual({ strategy: 'testid', value: 'product-title', stability: 'stable' });
    expect(pick(candidates, 'text')).toEqual({ strategy: 'text', value: 'Wireless Mouse', stability: 'fragile' });
    expect(pick(candidates, 'id')).toBeUndefined();
  });

  it('rates ids by how generated they look', () => {
    const root = annotate(h('div', {}, h('span', { id: 'item-48213' }), h('span', { id: 'main-nav' })));
    const [a, b] = elementChildren(root);
    expect(pick(generate(a!), 'id')?.stability).toBe('fragile');
    expect(pick(generate(b!), 'id')?.stability).toBe('stable');
  });

  it('builds css from stable classes only', () => {
    const root = annotate(h('div', {}, h('div', { class: 'card sc-bdfBwQ kXeqYt' }, 'x')));
    expect(pick(generate(elementChildren(root)[0]!), 'css')?.value).toBe('div.card');
  });

  it('walks up to the nearest ancestor with a stable class and adds :nth-child for ambiguous siblings', () => {
    const root = annotate(
      h('body', {}, h('div', { class: 'grid' }, h('article', {}, h('a', {}, h('h3', {}, 'A'))), h('article', {}, h('a', {}, h('h3', {}, 'B'))))),
    );
    const second = find(root, (n) => n.tag === 'h3' && n.children[0]?.type === 'text' && n.children[0].text === 'B');
    const css = pick(generate(second), 'css')!;
    expect(css).toEqual({ strategy: 'css', value: 'div.grid > article:nth-child(2) > a > h3', stability: 'fragile' });
  });

  it('builds xpath from the nearest ancestor with an id', () => {
    const root = annotate(tier0Snapshot());
    const title = byClass(root, 'product-title', 2);
    expect(pick(generate(title), 'xpath')?.value).toBe("//article[@id='product-p03']/h2[1]");
    expect(pick(generate(title), 'css')).toEqual({ strategy: 'css', value: 'h2.product-title', stability: 'medium' });
  });

  it('adds a class candidate with hashed tokens only when it differs from css', () => {
    const root = annotate(h('body', {}, h('div', { class: 'asEBEc' }, h('div', { class: 'price kXeqYt' }, '$1'), h('div', { class: 'plain' }, 'x'))));
    const price = find(root, (n) => n.attrs.class === 'price kXeqYt');
    const candidates = generate(price);
    expect(pick(candidates, 'css')).toEqual({ strategy: 'css', value: 'div.price', stability: 'medium' });
    expect(pick(candidates, 'class')).toEqual({ strategy: 'class', value: 'div.price.kXeqYt', stability: 'fragile' });
    expect(strategies(candidates)).toEqual(['text', 'css', 'class', 'xpath']);
    // Same value as css: no class candidate.
    const plain = find(root, (n) => n.attrs.class === 'plain');
    expect(pick(generate(plain), 'class')).toBeUndefined();
    expect(pick(generate(find(root, (n) => n.tag === 'body')), 'class')).toBeUndefined();
  });

  it('prefixes the class candidate with the nearest anchored ancestor when the element has no stable token', () => {
    const root = annotate(h('body', {}, h('section', { class: 'results' }, h('div', { class: 'asEBEc' }, h('span', { class: 'kXeqYt' }, '$1')))));
    const span = find(root, (n) => n.tag === 'span');
    expect(pick(generate(span), 'css')!.value).toBe('section.results > div > span');
    expect(pick(generate(span), 'class')).toEqual({ strategy: 'class', value: 'section.results span.kXeqYt', stability: 'fragile' });
  });

  it('adds role-only candidates for container levels', () => {
    const root = annotate(
      h('body', {}, h('ul', { class: 'list' }, h('li', { class: 'product-item' }, h('article', {}, h('h2', {}, 'A'))), h('li', {}, h('div', { class: 'box' }, 'x')))),
    );
    const level = (n: AnnotatedNode) => pick(generate(n, { level: true, positional: false }), 'role');
    expect(level(find(root, (n) => n.tag === 'li'))).toEqual({ strategy: 'role', value: 'listitem', stability: 'stable' });
    expect(level(find(root, (n) => n.tag === 'ul'))).toEqual({ strategy: 'role', value: 'list', stability: 'stable' });
    expect(level(find(root, (n) => n.tag === 'article'))).toEqual({ strategy: 'role', value: 'article', stability: 'stable' });
    expect(level(find(root, (n) => n.tag === 'div'))).toBeUndefined();
    // Fields keep role plus name.
    expect(pick(generate(find(root, (n) => n.tag === 'li')), 'role')).toBeUndefined();
    expect(pick(generate(find(root, (n) => n.tag === 'h2')), 'role')?.value).toBe('heading|A');
  });

  it('omits text for elements with more than one child node', () => {
    const root = annotate(h('p', {}, 'a', h('b', {}, 'b')));
    expect(pick(generate(root), 'text')).toBeUndefined();
  });

  it('resolves every generated candidate back to the element on the fake browser', async () => {
    const snapshot = tier0Snapshot();
    const root = annotate(snapshot);
    const session = await fakeSession(snapshot);
    const title = byClass(root, 'product-title', 4);
    for (const candidate of generate(title)) {
      const refs = await session.resolve(candidate);
      const texts = await Promise.all(refs.map((r) => session.read(r, { mode: 'text' })));
      expect(texts, `${candidate.strategy}=${candidate.value}`).toContain(dataset[4]!.title);
    }
  });
});

describe('rank', () => {
  it('puts testid before css at equal counts, and unique before non-unique', () => {
    const css24: Candidate = { strategy: 'css', value: 'h2.t', stability: 'medium', count: 24 };
    const testid24: Candidate = { strategy: 'testid', value: 't', stability: 'stable', count: 24 };
    expect(rank([css24, testid24])[0]).toBe(testid24);
    const unique: Candidate = { strategy: 'css', value: '#x h2', stability: 'medium', count: 1 };
    const many: Candidate = { strategy: 'css', value: 'h2', stability: 'medium', count: 5 };
    expect(rank([many, unique])).toEqual([unique, many]);
  });

  it('prefers the item count for item scoped candidates and sinks zero matches', () => {
    const role1: Candidate = { strategy: 'role', value: 'heading|A', stability: 'stable', count: 1 };
    const css24: Candidate = { strategy: 'css', value: 'h2', stability: 'medium', count: 24 };
    const none: Candidate = { strategy: 'testid', value: 'gone', stability: 'stable', count: 0 };
    expect(rank([none, role1, css24], { itemCount: 24 })).toEqual([css24, role1, none]);
    expect(rank([none, role1, css24])).toEqual([role1, css24, none]);
  });
});

describe('rank with class candidates', () => {
  it('ranks css before class at equal counts and a class candidate with the item count above a mismatched css one', () => {
    const css24: Candidate = { strategy: 'css', value: 'div > div:nth-child(2)', stability: 'fragile', count: 24 };
    const class24: Candidate = { strategy: 'class', value: 'div.price.kXeqYt', stability: 'fragile', count: 24 };
    const xpath24: Candidate = { strategy: 'xpath', value: './div[1]/div[2]', stability: 'fragile', count: 24 };
    expect(rank([xpath24, class24, css24], { itemCount: 24 })).toEqual([css24, class24, xpath24]);
    const css30: Candidate = { ...css24, count: 30 };
    expect(rank([css30, class24], { itemCount: 24 })).toEqual([class24, css30]);
  });
});

describe('relativize', () => {
  it('anchors a css candidate below its container with :scope when asked', () => {
    const root = annotate(
      h('html', {}, h('body', {}, h('div', { class: 'main' }, h('div', { id: 'rso' }, h('div', {}, h('div', { class: 'Mjj4Yd' }, h('h3', {}, 'A'))), h('div', {}, h('div', { class: 'Mjj4Yd' }, h('h3', {}, 'B'))))))),
    );
    const rso = descendantsOf(root).find((n) => n.attrs.id === 'rso')!;
    const item = rso.children.filter((c): c is AnnotatedNode => c.type === 'element')[0]!.children.find((c): c is AnnotatedNode => c.type === 'element')!;
    const css = generate(item, { positional: false, level: true }).find((c) => c.strategy === 'css')!;
    expect(relativize(css, rso, { anchor: true })?.value).toMatch(/^:scope > /);
    expect(relativize(css, rso)?.value).not.toMatch(/:scope/);
  });

  it('drops the container and its position', () => {
    const candidate: Candidate = { strategy: 'css', value: 'article:nth-child(2) > a > h3', stability: 'fragile' };
    expect(relativize(candidate, 'article')).toEqual({ strategy: 'css', value: 'a > h3', stability: 'medium' });
  });

  it('turns item-specific candidates into item-relative ones', () => {
    expect(relativize({ strategy: 'role', value: 'heading|Mouse', stability: 'stable' }, 'article')?.value).toBe('heading');
    expect(relativize({ strategy: 'text', value: 'Mouse', stability: 'fragile' }, 'article')).toBeNull();
    expect(relativize({ strategy: 'id', value: 'x', stability: 'stable' }, 'article')).toBeNull();
    expect(relativize({ strategy: 'xpath', value: "//article[@id='p3']/h2[1]", stability: 'fragile' }, 'article.card')?.value).toBe('./h2[1]');
  });

  it('cuts at a bare div container by element, not by selector text', () => {
    const item = (price: string) =>
      h('div', { class: 'asEBEc' }, h('div', {}, h('div', {}, h('span', {}, 'label')), h('div', {}, h('span', { class: 'kXeqYt' }, price))));
    const root = annotate(h('body', {}, h('main', {}, item('$1'), item('$2'), item('$3'))));
    const container = find(root, (n) => n.attrs.class === 'asEBEc' && descendantsOf(n).some((d) => d.children[0]?.type === 'text' && d.children[0].text === '$2'));
    const price = find(container, (n) => n.attrs.class === 'kXeqYt');
    const candidates = generate(price);
    expect(pick(candidates, 'css')!.value).toBe('main > div:nth-child(2) > div > div:nth-child(2) > span');
    expect(relativize(pick(candidates, 'css')!, container)).toEqual({ strategy: 'css', value: 'div > div:nth-child(2) > span', stability: 'fragile' });
    expect(relativize(pick(candidates, 'class')!, container)).toEqual({ strategy: 'class', value: 'span.kXeqYt', stability: 'fragile' });
    expect(relativize(pick(candidates, 'xpath')!, container)?.value).toBe('./div[1]/div[2]/span[1]');
    // The text form matches the last bare `div` segment and cuts too deep.
    expect(relativize(pick(candidates, 'css')!, compoundOf(container))?.value).toBe('span');
    // The container itself has no relative form.
    expect(relativize(pick(generate(container), 'css')!, container)).toBeNull();
  });

  it('keeps the a > h3 cut by element', () => {
    const root = annotate(
      h('body', {}, h('div', { class: 'grid' }, h('article', {}, h('a', {}, h('h3', {}, 'A'))), h('article', {}, h('a', {}, h('h3', {}, 'B'))))),
    );
    const second = find(root, (n) => n.tag === 'h3' && n.children[0]?.type === 'text' && n.children[0].text === 'B');
    const article = second.parent!.parent!;
    expect(relativize(pick(generate(second), 'css')!, article)).toEqual({ strategy: 'css', value: 'a > h3', stability: 'medium' });
  });

  it('matches once per card on the tier 0 snapshot', async () => {
    const snapshot = tier0Snapshot();
    const root = annotate(snapshot);
    const session = await fakeSession(snapshot);
    const cards = await session.resolve({ strategy: 'css', value: 'article.product-card', stability: 'medium' });
    expect(cards).toHaveLength(24);
    const title = byClass(root, 'product-title', 1);
    const card = title.parent!;
    const positional: Candidate = {
      strategy: 'css',
      value: `li.product-item:nth-child(2) > ${compoundOf(card)} > h2.product-title`,
      stability: 'fragile',
    };
    const generalized = [positional, ...generate(title)].map((c) => relativize(c, compoundOf(card))).filter((c) => c !== null);
    expect(generalized[0]!.value).toBe('h2.product-title');
    for (const candidate of generalized) {
      for (const container of cards) {
        expect(await session.resolve(candidate, container), `${candidate.strategy}=${candidate.value}`).toHaveLength(1);
      }
    }
  });
});

describe('inferItems', () => {
  it('proposes the 24 tier 0 cards from one title', () => {
    const root = annotate(tier0Snapshot());
    const proposal = inferItems(byClass(root, 'product-title', 3))!;
    expect(proposal.container.tag).toBe('article');
    expect(proposal.siblings).toHaveLength(24);
    expect(proposal.siblings.every((s) => s.attrs['data-testid'] === 'product-card')).toBe(true);
    expect(proposal.broader?.node.tag).toBe('li');
    expect(proposal.broader?.items).toHaveLength(24);
    expect(proposal.narrower).toBeNull();
  });

  it('offers the link inside each card as the narrower level', () => {
    const cards = Array.from({ length: 5 }, (_, i) => h('article', {}, h('a', { href: `/p/${i}` }, h('h3', {}, `T${i}`), h('span', {}, '$1'))));
    const root = annotate(h('html', {}, h('body', {}, h('div', { class: 'grid' }, cards))));
    const proposal = inferItems(find(root, (n) => n.tag === 'h3'))!;
    expect(proposal.within?.attrs.class).toBe('grid');
    expect(proposal.container.tag).toBe('article');
    expect(proposal.siblings).toHaveLength(5);
    expect(proposal.skipped).toEqual([]);
    expect(proposal.broader).toBeNull();
    expect(proposal.narrower?.node.tag).toBe('a');
    expect(proposal.narrower?.items).toHaveLength(5);
  });

  it('names the product list as list parent on tier 0', () => {
    const root = annotate(tier0Snapshot());
    const proposal = inferItems(byClass(root, 'product-title', 3))!;
    expect(proposal.within?.attrs.class).toBe('product-list');
    expect(proposal.all).toHaveLength(24);
  });

  const card = (i: number, extra: SerializedElement[] = []) =>
    h('article', { class: 'card' }, ...extra, h('a', { href: `/p/${i}` }, h('h3', {}, `T${i}`)), h('p', {}, 'text'), h('span', {}, '$1'));

  it('finds cards grouped in rows as cousins under the grid', () => {
    const rows = Array.from({ length: 6 }, (_, r) => h('div', { class: 'row' }, Array.from({ length: 4 }, (_, c) => card(r * 4 + c))));
    const root = annotate(h('html', {}, h('body', {}, h('div', { class: 'grid' }, rows))));
    const title = find(root, (n) => n.tag === 'h3' && n.children[0]?.type === 'text' && n.children[0].text === 'T9');
    const proposal = inferItems(title)!;
    expect(proposal.within?.attrs.class).toBe('grid');
    expect(proposal.container.tag).toBe('article');
    expect(proposal.siblings).toHaveLength(24);
    expect(proposal.broader?.node.attrs.class).toBe('row');
    expect(proposal.broader?.items).toHaveLength(6);
    expect(proposal.narrower?.node.tag).toBe('a');
  });

  const questions = () => h('li', {}, h('article', { class: 'questions' }, h('h3', {}, 'People also ask'), h('button', {}, 'a'), h('button', {}, 'b'), h('button', {}, 'c')));
  const results = (thumb: number | null) =>
    annotate(
      h(
        'html',
        {},
        h(
          'body',
          {},
          h('ul', { class: 'results' }, [
            ...Array.from({ length: 4 }, (_, i) => h('li', {}, card(i, i === thumb ? [h('img', { src: 'x' })] : []))),
            questions(),
            ...Array.from({ length: 4 }, (_, i) => h('li', {}, card(i + 4, i + 4 === thumb ? [h('img', { src: 'x' })] : []))),
          ]),
        ),
      ),
    );

  it('skips a dissimilar sibling and reports it', () => {
    const root = results(null);
    const proposal = inferItems(find(root, (n) => n.tag === 'h3' && n.parent?.tag === 'a'))!;
    expect(proposal.within?.attrs.class).toBe('results');
    expect(proposal.container.attrs.class).toBe('card');
    expect(proposal.siblings).toHaveLength(8);
    expect(proposal.skipped).toHaveLength(1);
    expect(proposal.skipped[0]!.attrs.class).toBe('questions');
    expect(proposal.all).toHaveLength(9);
  });

  it('finds the group when the odd item is picked', () => {
    const root = results(5);
    const title = find(root, (n) => n.tag === 'h3' && n.children[0]?.type === 'text' && n.children[0].text === 'T5');
    expect(descendantsOf(title.parent!.parent!).some((n) => n.tag === 'img')).toBe(true);
    const proposal = inferItems(title)!;
    expect(proposal.siblings).toHaveLength(8);
    expect(proposal.skipped).toHaveLength(1);
  });

  it('recomputes items for a fixed list parent and item level', () => {
    const rows = Array.from({ length: 6 }, (_, r) => h('div', { class: 'row' }, Array.from({ length: 4 }, (_, c) => card(r * 4 + c))));
    const root = annotate(h('html', {}, h('body', {}, h('div', { class: 'grid' }, rows))));
    const title = find(root, (n) => n.tag === 'h3' && n.children[0]?.type === 'text' && n.children[0].text === 'T5');
    const row = title.parent!.parent!.parent!;
    const narrow = inferItems(title, { within: row })!;
    expect(narrow.within).toBe(row);
    expect(narrow.siblings).toHaveLength(4);
    const wide = inferItems(title, { within: row.parent! })!;
    expect(wide.siblings).toHaveLength(24);
    const rowsOnly = inferItems(title, { within: row.parent!, item: row })!;
    expect(rowsOnly.container).toBe(row);
    expect(rowsOnly.siblings).toHaveLength(6);
    expect(inferItems(title, { within: title })).toBeNull();
  });

  it('finds 24 cards with 6 skipped questions blocks on the mixed catalog, from a plain and from an odd card', () => {
    const root = annotate(tier0Snapshot({ mixed: true }));
    for (const nth of [2, 3]) {
      const proposal = inferItems(byClass(root, 'product-title', nth))!;
      expect(proposal.within?.attrs.class).toBe('product-list');
      expect(proposal.container.tag).toBe('article');
      expect(proposal.siblings).toHaveLength(24);
      expect(proposal.skipped).toHaveLength(6);
      expect(proposal.all).toHaveLength(30);
    }
  });

  it('finds the 24 cards across row wrappers on the rows catalog', () => {
    const root = annotate(tier0Snapshot({ rows: 4 }));
    const proposal = inferItems(byClass(root, 'product-title', 9))!;
    expect(proposal.within?.attrs.class).toBe('product-list');
    expect(proposal.container.tag).toBe('article');
    expect(proposal.siblings).toHaveLength(24);
  });

  it('reports no container for a single hero heading', () => {
    const root = annotate(h('html', {}, h('body', {}, h('header', {}, h('h1', {}, 'Hero')), h('main', {}, h('p', {}, 'text')))));
    expect(inferItems(find(root, (n) => n.tag === 'h1'))).toBeNull();
  });

  it('never proposes body', () => {
    const root = annotate(h('html', {}, h('head', {}), h('body', {}, h('h1', {}, 'x'))));
    expect(inferItems(find(root, (n) => n.tag === 'body'))).toBeNull();
  });

  it('keeps only structurally similar items in an irregular list', () => {
    const li = (...children: SerializedElement[]) => h('li', {}, children);
    const root = annotate(
      h(
        'html',
        {},
        h(
          'body',
          {},
          h(
            'ul',
            {},
            li(h('a', {}, 'a'), h('span', {}, 's')),
            li(h('a', {}, 'b'), h('span', {}, 's'), h('em', {}, 'e')),
            li(h('a', {}, 'c'), h('span', {}, 's')),
            li(h('div', {}, h('p', {}, 'ad'), h('p', {}, 'ad'), h('p', {}, 'ad'))),
            li(h('a', {}, 'd')),
          ),
        ),
      ),
    );
    expect(SIMILARITY_THRESHOLD).toBe(0.6);
    const proposal = inferItems(find(root, (n) => n.tag === 'span'))!;
    expect(proposal.container.tag).toBe('li');
    // a+span, a+span+em (2/3), a+span, a alone (1/2 < 0.6) and the ad block are out.
    expect(proposal.siblings.map((s) => elementChildren(s).map((c) => c.tag).join('+'))).toEqual(['a+span', 'a+span+em', 'a+span']);
  });
});

describe('fingerprint', () => {
  it('captures the price scenario', () => {
    const root = annotate(
      h('article', {}, h('a', {}, h('span', { 'data-testid': 'price', class: 'pc__price' }, '$999.00'))),
    );
    const span = find(root, (n) => n.tag === 'span');
    span.bbox = { x: 10, y: 20, w: 60, h: 16 };
    const fp = fingerprint(span);
    expect(fp.tag).toBe('span');
    expect(fp.textSample).toBe('$999.00');
    expect(fp.attrs).toEqual({ 'data-testid': 'price' });
    expect(fp.ancestors.slice(0, 2)).toEqual(['a', 'article']);
    expect(fp.bbox).toEqual({ x: 10, y: 20, w: 60, h: 16 });
  });

  it('masks digits in href and matches the reference title fingerprint shape', () => {
    const root = annotate(tier0Snapshot());
    const link = byClass(root, 'product-link', 0);
    expect(fingerprint(link).attrs).toEqual({ href: '/p/p##' });

    const reference = JSON.parse(readFileSync(new URL('../../cli/fixtures/playground-catalog.json', import.meta.url), 'utf8'));
    const expected = loadRecipe(reference).fields[0]!.fingerprint!;
    const fp = fingerprint(byClass(root, 'product-title', 0));
    expect(Object.keys(fp)).toEqual(Object.keys(expected));
    expect(fp.tag).toBe(expected.tag);
    expect(fp.role).toBe(expected.role);
    expect(fp.name).toBe(expected.name);
    expect(fp.textSample).toBe(expected.textSample);
    expect(fp.ancestors).toHaveLength(6);
    expect([fp.ancestors[0], ...fp.ancestors.slice(2)]).toEqual([expected.ancestors[0], ...expected.ancestors.slice(2)]);
  });
});

describe('determinism', () => {
  it('yields deep-equal output for the same snapshot and path', () => {
    const run = () => {
      const root = annotate(tier0Snapshot());
      const title = byClass(root, 'product-title', 7);
      const proposal = inferItems(title)!;
      return {
        path: pathOf(title),
        candidates: generate(title),
        fingerprint: fingerprint(title),
        container: pathOf(proposal.container),
        within: pathOf(proposal.within!),
        siblings: proposal.siblings.map(pathOf),
        skipped: proposal.skipped.map(pathOf),
        broader: proposal.broader?.items.map(pathOf),
      };
    };
    expect(run()).toEqual(run());
  });
});
