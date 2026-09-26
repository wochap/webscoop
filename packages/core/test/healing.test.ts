import { describe, expect, it, vi } from 'vitest';
import {
  ancestorSimilarity,
  annotate,
  applyPromotions,
  candidatesResolver,
  defaultLadder,
  descendantsOf,
  extractPage,
  fingerprint,
  firstCandidateResolver,
  fuzzyResolver,
  healContext,
  isRequired,
  plausible,
  targetName,
  loadRecipe,
  pickMatch,
  promote,
  refForNode,
  resolveTarget,
  saveRecipe,
  scoreFingerprint,
  scoreParts,
  SnapshotCache,
  xpathFor,
  type AnnotatedNode,
  type HealTarget,
  type Resolver,
  type SerializedElement,
  tablesOf,
} from '../src';
import { dataset } from '@webscoop/playground';
import { FakeBrowser, h } from '../src/testing';
import { catalogSnapshot, fingerprintedRecipe, tier0Nodes } from './healing-helpers';
import { CATALOG, referenceRecipe } from './recorder-helpers';
import { css, PAGE, recipe, tablesRecipe, testid } from './helpers';

/** A recipe as plain input again, so a test can add keys before loading it. */
const saveRecipeInput = (recipe: ReturnType<typeof loadRecipe>) => JSON.parse(saveRecipe(recipe)) as Record<string, unknown>;

async function open(dom: SerializedElement, url = CATALOG) {
  const s = await new FakeBrowser({ [url]: dom }).open('/profile');
  await s.goto(url, { timeoutMs: 1000 });
  return s;
}

const ctxFor = (session: Awaited<ReturnType<typeof open>>, extra: Partial<Parameters<typeof healContext>[0]> = {}) =>
  healContext({ session, cache: new SnapshotCache(session), threshold: 0.7, ...extra });

const fieldTarget = (name: string, fp: HealTarget['fingerprint'], selectors = [css('.gone')], scope: 'item' | 'page' = 'page'): HealTarget => ({
  kind: 'field',
  index: 0,
  name,
  scope,
  optional: false,
  selectors,
  ...(fp ? { fingerprint: fp } : {}),
});

describe('positional xpath for snapshot nodes', () => {
  it('addresses the same element as a stable selector, in the document and inside a container', async () => {
    const session = await open(catalogSnapshot(0));
    const root = annotate((await session.snapshot()) as SerializedElement);
    const price = descendantsOf(root).filter((n) => n.attrs['data-testid'] === 'price')[4]!;
    expect(xpathFor(price)).toBe('/html[1]/body[1]/main[1]/ul[1]/li[5]/article[1]/p[1]');
    const byXpath = await refForNode(session, price);
    const [, , , , byTestid] = await session.resolve(testid('price'));
    expect(await session.same(byXpath!, byTestid!)).toBe(true);

    const [card] = await session.resolve(testid('product-card'));
    const sub = annotate((await session.snapshot(card)) as SerializedElement);
    const title = descendantsOf(sub).find((n) => n.tag === 'h2')!;
    expect(xpathFor(title)).toBe('./h2[1]');
    const [titleRef] = await session.resolve(css('h2'), card);
    expect(await session.same((await refForNode(session, title, card))!, titleRef!)).toBe(true);
  });
});

describe('fingerprint score', () => {
  const nodes = tier0Nodes();

  it('scores the same element at least 0.9 after class hashing', () => {
    const price = nodes.price!;
    const fp = fingerprint({ ...price, bbox: { x: 40, y: 300, w: 200, h: 24 } });
    const hashed: AnnotatedNode = { ...price, attrs: { ...price.attrs, class: 'sc-a1b2c3 css-9zz8yy' }, bbox: { x: 40, y: 300, w: 200, h: 24 } };
    expect(scoreFingerprint(fp, hashed)).toBeGreaterThanOrEqual(0.9);
    expect(scoreFingerprint(fp, hashed)).toBe(1);
  });

  it('scores a different field of the same card below 0.7', () => {
    const fp = fingerprint(nodes.price!);
    expect(scoreFingerprint(fp, nodes.title!)).toBeLessThan(0.7);
    expect(scoreFingerprint(fp, nodes.rating!)).toBeLessThan(0.7);
  });

  it('gives full weight to data absent on both sides and none to data absent on one side', () => {
    const fp = { tag: 'span', textSample: '', attrs: {}, ancestors: [], bbox: { x: 0, y: 0, w: 0, h: 0 } };
    const bare: AnnotatedNode = { type: 'element', tag: 'span', attrs: {}, children: [] };
    expect(scoreParts(fp, bare)).toMatchObject({ tag: 0.15, role: 0.15, name: 0.15, text: 0.2, attrs: 0.15, ancestors: 0.1, bbox: 0.1, total: 1 });
    const texted: AnnotatedNode = { ...bare, role: 'note', children: [{ type: 'text', text: 'hello' }], bbox: { x: 1, y: 1, w: 5, h: 5 } };
    expect(scoreParts(fp, texted)).toMatchObject({ role: 0, text: 0, bbox: 0 });
  });

  it('lets a few added wrapper elements cost little in the ancestor chain', () => {
    const stored = ['article', 'listitem', 'list', 'main', 'body', 'html'];
    expect(ancestorSimilarity(stored, stored)).toBe(1);
    expect(ancestorSimilarity(stored, ['div', 'div', ...stored])).toBe(0.75);
    expect(ancestorSimilarity(stored, ['listitem', 'list', 'main', 'body', 'html'])).toBeCloseTo(5 / 6);
    expect(ancestorSimilarity(stored, ['cell', 'row', 'table', 'section', 'div', 'body', 'html'])).toBeLessThan(0.5);
  });

  it('compares text trimmed and case folded, with a capped edit distance', () => {
    const fp = { tag: 'p', textSample: '  WIRELESS mouse ', attrs: {}, ancestors: [], bbox: { x: 0, y: 0, w: 0, h: 0 } };
    const node: AnnotatedNode = { type: 'element', tag: 'p', attrs: {}, children: [{ type: 'text', text: 'wireless   Mouse' }] };
    expect(scoreParts(fp, node).text).toBe(0.2);
    const long: AnnotatedNode = { ...node, children: [{ type: 'text', text: 'x'.repeat(5000) }] };
    expect(scoreParts(fp, long).text).toBeLessThan(0.05);
  });

  it('matches the host annotation of tier 0 against the reference recipe fingerprints recorded in a browser', () => {
    const recipe = referenceRecipe();
    // The snapshot here carries no geometry, so only the bbox component is lost.
    expect(scoreFingerprint(recipe.item!.fingerprint!, nodes.item!)).toBeGreaterThanOrEqual(0.9);
    for (const field of recipe.fields!) expect(scoreFingerprint(field.fingerprint!, nodes[field.name]!), field.name).toBeGreaterThanOrEqual(0.9);
  });
});

describe('fuzzy resolver', () => {
  it('rejects an ambiguous best match', () => {
    const node = { type: 'element', tag: 'p', attrs: {}, children: [] } as AnnotatedNode;
    expect(pickMatch([{ node, score: 0.82 }, { node, score: 0.8 }], 0.7)).toBeNull();
    expect(pickMatch([{ node, score: 0.86 }, { node, score: 0.8 }], 0.7)?.score).toBe(0.86);
    expect(pickMatch([{ node, score: 0.69 }], 0.7)).toBeNull();
  });

  it('fails when two identical elements tie', async () => {
    const dom = h('html', {}, h('body', {}, h('p', {}, 'Total: $5'), h('p', {}, 'Total: $5')));
    const session = await open(dom);
    const fp = { tag: 'p', role: 'paragraph', textSample: 'Total: $5', attrs: {}, ancestors: ['body', 'html'], bbox: { x: 0, y: 0, w: 0, h: 0 } };
    expect(await fuzzyResolver.resolve(fieldTarget('total', fp), ctxFor(session))).toBeNull();
  });

  it('finds the price on tier 1 and returns a positional xpath and score', async () => {
    const session = await open(catalogSnapshot(1));
    const fp = fingerprint(tier0Nodes().price!);
    const [card] = await session.resolve(css('article'));
    const ctx = ctxFor(session, { within: card!, outerAncestors: fingerprint(tier0Nodes().item!).ancestors });
    const found = await fuzzyResolver.resolve(fieldTarget('price', fp, [testid('price')], 'item'), ctx);
    expect(found?.outcome.kind).toBe('fuzzy');
    expect((found?.outcome as { score: number }).score).toBeGreaterThanOrEqual(0.7);
    expect(found?.selector).toEqual({ strategy: 'xpath', value: './p[1]', stability: 'fragile' });
    expect(await session.read(found!.refs[0]!, { mode: 'text' })).toBe('$24.99');
  });

  it('skips targets without a fingerprint and snapshots each scope once', async () => {
    const session = await open(catalogSnapshot(1));
    const spy = vi.spyOn(session, 'snapshot');
    const ctx = ctxFor(session);
    expect(await fuzzyResolver.resolve(fieldTarget('category', undefined), ctx)).toBeNull();
    const fp = fingerprint(tier0Nodes().category!);
    await fuzzyResolver.resolve(fieldTarget('category', fp), ctx);
    await fuzzyResolver.resolve(fieldTarget('category', fp), ctx);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('ladder', () => {
  it('does not call later rungs when a candidate wins, and reports its index', async () => {
    const session = await open(catalogSnapshot(0));
    const fuzzy: Resolver = { name: 'fuzzy', resolve: vi.fn(async () => null) };
    const target = fieldTarget('category', fingerprint(tier0Nodes().category!), [css('.gone'), testid('category')]);
    const found = await resolveTarget([candidatesResolver, fuzzy], target, ctxFor(session));
    expect(found?.outcome).toEqual({ kind: 'candidate', index: 1 });
    expect(fuzzy.resolve).not.toHaveBeenCalled();
  });

  it('tries only candidate 0 when healing is disabled', async () => {
    const session = await open(catalogSnapshot(0));
    const spy = vi.spyOn(session, 'resolve');
    const target = fieldTarget('category', fingerprint(tier0Nodes().category!), [css('.gone'), testid('category')]);
    const ladder = defaultLadder({ enabled: false, extra: [{ name: 'extra', resolve: vi.fn(async () => null) }] });
    expect(ladder).toEqual([firstCandidateResolver]);
    expect(await resolveTarget(ladder, target, ctxFor(session))).toBeNull();
    expect(spy.mock.calls.map((c) => c[0])).toEqual([css('.gone')]);
  });

  it('falls through to fuzzy, then extra rungs, in order', async () => {
    const session = await open(catalogSnapshot(1));
    const extra: Resolver = { name: 'extra', resolve: vi.fn(async () => null) };
    const ladder = defaultLadder({ enabled: true, extra: [extra] });
    expect(ladder.map((r) => r.name)).toEqual(['candidates', 'fuzzy', 'extra']);
    const target = fieldTarget('category', fingerprint(tier0Nodes().category!), [testid('category')]);
    const found = await resolveTarget(ladder, target, ctxFor(session));
    expect(found?.outcome.kind).toBe('fuzzy');
    expect(extra.resolve).not.toHaveBeenCalled();
    expect(await resolveTarget(ladder, fieldTarget('nothing', undefined), ctxFor(session))).toBeNull();
    expect(extra.resolve).toHaveBeenCalledTimes(1);
  });

  it('moves on when the caller turns a resolution down', async () => {
    const session = await open(catalogSnapshot(0));
    const target = fieldTarget('category', undefined, [testid('category')]);
    const other: Resolver = { name: 'other', resolve: async () => ({ refs: await session.resolve(css('h1')), outcome: { kind: 'model', rationale: 'heading' }, selector: css('h1') }) };
    const out = await resolveTarget([candidatesResolver, other], target, ctxFor(session), async (r) => (r.outcome.kind === 'candidate' ? null : r.outcome));
    expect(out).toEqual({ kind: 'model', rationale: 'heading' });
  });
});

describe('promotion', () => {
  it('puts the resolving candidate first, then fresh ones, then old ones that still resolve', async () => {
    const session = await open(catalogSnapshot(0));
    const target = fieldTarget('category', fingerprint(tier0Nodes().category!), [css('.gone'), testid('category'), css('h1.category-heading')]);
    const ctx = ctxFor(session);
    const found = await resolveTarget([candidatesResolver], target, ctx);
    const p = await promote(target, found!, ctx);
    expect(p.selectors[0]).toEqual(testid('category'));
    expect(p.selectors.map((s) => `${s.strategy}=${s.value}`)).toEqual([
      'testid=category',
      'role=heading|Electronics',
      'id=category',
      'css=h1.category-heading',
      'text=Electronics',
      "xpath=//main[@id='catalog']/h1[1]",
      'xpath=/html[1]/body[1]/main[1]/h1[1]',
    ]);
    expect(p.selectors.some((s) => s.value === '.gone')).toBe(false);
    expect(p.selectors.at(-1)).toEqual({ strategy: 'xpath', value: '/html[1]/body[1]/main[1]/h1[1]', stability: 'fragile' });
    expect(p.oldPrimary).toEqual(css('.gone'));
    expect(p.newPrimary).toEqual(testid('category'));
    expect(p.fingerprint?.textSample).toBe('Electronics');
  });

  it('drops dead candidates and ranks fresh ones after a fuzzy match', async () => {
    const session = await open(catalogSnapshot(1));
    const recipe = fingerprintedRecipe();
    const price = recipe.fields!.find((f) => f.name === 'price')!;
    const containers = await session.resolve(css('article'));
    const target: HealTarget = { kind: 'field', index: 1, name: 'price', scope: 'item', optional: false, selectors: price.selectors, fingerprint: price.fingerprint! };
    const ctx = ctxFor(session, { within: containers[0]!, containers, outerAncestors: recipe.item!.fingerprint!.ancestors });
    const found = await fuzzyResolver.resolve(target, ctx);
    const p = await promote(target, found!, ctx);
    expect(p.selectors.some((s) => s.value === 'price' || s.value === '.product-price')).toBe(false);
    expect(p.selectors[0]!.strategy).toBe('testid');
    expect(p.selectors[0]!.value).toMatch(/^x/);
    expect(p.selectors.at(-1)).toEqual({ strategy: 'xpath', value: './p[1]', stability: 'fragile' });
    expect(p.coverage).toBe(24);
    expect(p.fingerprint?.ancestors).toEqual(recipe.fields![1]!.fingerprint!.ancestors);
    for (const s of p.selectors) {
      const [ref] = await session.resolve(s, containers[3]);
      expect(await session.read(ref!, { mode: 'text' }), `${s.strategy}=${s.value}`).toBe('$1,299.00');
    }
  });

  it('keeps the selectors a user picked', async () => {
    const session = await open(catalogSnapshot(0));
    const target = fieldTarget('category', undefined, [css('.gone'), css('h1')]);
    const refs = await session.resolve(testid('category'));
    const fp = fingerprint(tier0Nodes().category!);
    const p = await promote(target, { refs, outcome: { kind: 'user' }, selector: testid('category'), selectors: [testid('category')], fingerprint: fp }, ctxFor(session));
    expect(p.selectors).toEqual([testid('category'), css('h1')]);
    expect(p.fingerprint).toEqual(fp);
  });
});

describe('applyPromotions', () => {
  it('changes only promoted targets', () => {
    const before = fingerprintedRecipe();
    const selectors = [testid('x1abc23')];
    const fp = { ...before.fields![1]!.fingerprint!, textSample: '$1.00' };
    const target: HealTarget = { kind: 'field', index: 1, name: 'price', scope: 'item', optional: false, selectors: before.fields![1]!.selectors };
    const after = applyPromotions(before, [{ target, outcome: { kind: 'fuzzy', score: 0.9 }, oldPrimary: before.fields![1]!.selectors[0]!, newPrimary: selectors[0]!, selectors, fingerprint: fp }]);
    expect(after).not.toBe(before);
    expect(after.fields![1]!.selectors).toEqual(selectors);
    expect(after.fields![1]!.fingerprint).toEqual(fp);
    const { fields: a, ...restA } = after;
    const { fields: b, ...restB } = before;
    expect(restA).toEqual(restB);
    expect(a!.filter((_, i) => i !== 1)).toEqual(b!.filter((_, i) => i !== 1));
    expect(before.fields![1]!.selectors[0]!.value).toBe('price');

    const lines = (text: string) => text.split('\n');
    const x = lines(saveRecipe(before));
    const y = lines(saveRecipe(after));
    expect(y).not.toEqual(x);
    // Everything before the price field is byte-identical.
    const priceAt = x.findIndex((l) => l.includes('"name": "price"'));
    expect(y.slice(0, priceAt + 4)).toEqual(x.slice(0, priceAt + 4));
    const urlAtX = x.findIndex((l) => l.includes('"name": "url"'));
    const urlAtY = y.findIndex((l) => l.includes('"name": "url"'));
    expect(y.slice(urlAtY)).toEqual(x.slice(urlAtX));
  });

  it('heals a field in the second table and leaves the first untouched', () => {
    const before = loadRecipe(tablesRecipe());
    const products = tablesOf(before)[1]!;
    const selectors = [testid('product-title')];
    const target: HealTarget = { kind: 'field', table: 'products', index: 0, name: 'title', scope: 'item', optional: false, selectors: products.fields[0]!.selectors };
    const after = applyPromotions(before, [{ target, outcome: { kind: 'fuzzy', score: 0.9 }, oldPrimary: css('h2'), newPrimary: selectors[0]!, selectors }]);
    const [page, healed, questions] = tablesOf(after);
    expect(healed!.fields[0]!.selectors).toEqual(selectors);
    expect(healed!.fields[1]).toEqual(products.fields[1]);
    expect(page).toEqual(tablesOf(before)[0]);
    // Same field name, other table: untouched.
    expect(questions).toEqual(tablesOf(before)[2]);
    expect(after.fields).toBeUndefined();
    expect(after.item).toBeUndefined();
  });

  it('heals the item container of a named table', () => {
    const before = loadRecipe(tablesRecipe());
    const selectors = [css('div.question')];
    const target: HealTarget = { kind: 'item', table: 'questions', selectors: tablesOf(before)[2]!.item!.selectors };
    const after = applyPromotions(before, [{ target, outcome: { kind: 'fuzzy', score: 0.9 }, oldPrimary: testid('question'), newPrimary: selectors[0]!, selectors }]);
    expect(tablesOf(after)[2]!.item!.selectors).toEqual(selectors);
    expect(tablesOf(after)[1]!.item).toEqual(tablesOf(before)[1]!.item);
  });

  it('keeps a shorthand recipe in the shorthand form', () => {
    const before = fingerprintedRecipe();
    const selectors = [testid('x1abc23')];
    const target: HealTarget = { kind: 'field', table: 'items', index: 1, name: 'price', scope: 'item', optional: false, selectors: before.fields![1]!.selectors };
    const after = applyPromotions(before, [{ target, outcome: { kind: 'fuzzy', score: 0.9 }, oldPrimary: before.fields![1]!.selectors[0]!, newPrimary: selectors[0]!, selectors }]);
    expect(after.tables).toBeUndefined();
    expect(after.fields![1]!.selectors).toEqual(selectors);
    expect(Object.keys(after)).toEqual(Object.keys(before));
  });
});

describe('step targets', () => {
  const accept = [css('.consent-accept')];
  const stepTarget = (optional: boolean): HealTarget => ({ kind: 'step', index: 1, step: 'click', optional, selectors: accept });

  it('applies a step promotion at steps[index].target and leaves other steps alone', () => {
    const before = loadRecipe({
      ...saveRecipeInput(fingerprintedRecipe()),
      steps: [
        { kind: 'wait', value: '100' },
        { kind: 'click', target: { selectors: accept }, optional: true },
      ],
    });
    const selectors = [testid('accept-all')];
    const after = applyPromotions(before, [{ target: stepTarget(true), outcome: { kind: 'fuzzy', score: 0.8 }, oldPrimary: accept[0]!, newPrimary: selectors[0]!, selectors }]);
    expect(after.steps[1]).toEqual({ ...before.steps[1], target: { selectors } });
    expect(after.steps[0]).toEqual(before.steps[0]);
    expect(after.fields).toEqual(before.fields);
  });

  it('names a step by label or index and requires it only when not optional', () => {
    expect(targetName(stepTarget(false))).toBe('step:1');
    expect(targetName({ ...stepTarget(false), label: 'consent' } as HealTarget)).toBe('consent');
    expect(isRequired(stepTarget(false))).toBe(true);
    expect(isRequired(stepTarget(true))).toBe(false);
  });

  it('considers only elements a step can act on plausible', () => {
    const root = annotate(
      h('body', {}, h('button', {}, 'Accept'), h('p', {}, 'Text'), h('input', { name: 'q' }), h('select', {}), h('div', { role: 'tab' }, 'Products')) as SerializedElement,
    );
    const tags = (step: 'click' | 'type' | 'select') =>
      descendantsOf(root)
        .filter((n) => plausible(n, { ...stepTarget(false), step } as HealTarget))
        .map((n) => n.tag);
    expect(tags('click')).toEqual(['button', 'input', 'select', 'div']);
    expect(tags('type')).toEqual(['input']);
    expect(tags('select')).toEqual(['select']);
  });
});

describe('extractPage with the healing ladder', () => {
  it('heals every broken field of the reference recipe on tier 1 through fuzzy matching', async () => {
    const session = await open(catalogSnapshot(1));
    const healed: string[] = [];
    const out = (await extractPage(session, fingerprintedRecipe(), {
      pageUrl: CATALOG,
      page: 1,
      ladder: defaultLadder({ enabled: true }),
      promote: true,
      onHealed: (p) => healed.push(p.target.kind === 'field' ? p.target.name : p.target.kind),
    })).tables[0]!;
    expect(out.missingRequired).toEqual([]);
    expect(out.rows).toHaveLength(24);
    expect(out.item?.outcome.kind).toBe('fuzzy');
    expect(out.item?.count).toBe(24);
    const byName = Object.fromEntries(out.fields.map((f) => [f.name, f]));
    expect(byName.title).toMatchObject({ status: 'ok', outcome: { kind: 'candidate', index: 0 } });
    expect(byName.url).toMatchObject({ status: 'healed', outcome: { kind: 'candidate', index: 1 } });
    for (const name of ['price', 'rating', 'image', 'category']) {
      expect(byName[name]!.status, name).toBe('healed');
      expect(byName[name]!.outcome.kind, name).toBe('fuzzy');
    }
    expect(healed).toEqual(['item', 'price', 'url', 'image', 'rating', 'category']);
    expect(out.rows[3]).toMatchObject({ title: '27-inch Monitor', price: 1299, rating: 4.6, category: 'Electronics' });
    expect(out.promotions.map((p) => p.target.kind)).toContain('item');
  });

  it('accepts an item field that holds in 20 of 24 containers and reports it partial', async () => {
    const cardOf = (i: number, withPrice: boolean) =>
      h(
        'li',
        {},
        h(
          'article',
          { class: 'card', 'data-testid': 'card' },
          h('h2', {}, `Product ${i + 1}`),
          withPrice && h('span', { class: 'amount', 'data-testid': 'cost' }, `$${i + 1}.00`),
        ),
      );
    const page = (items: SerializedElement[]) => h('html', {}, h('body', {}, h('main', {}, h('ul', {}, items))));
    const original = annotate(page([cardOf(0, true)]));
    const origPrice = descendantsOf(original).find((n) => n.tag === 'span')!;
    const priceFp = fingerprint({ ...origPrice, attrs: { class: 'price', 'data-testid': 'price' } });
    const itemFp = fingerprint(descendantsOf(original).find((n) => n.tag === 'article')!);
    const dom = page(Array.from({ length: 24 }, (_, i) => cardOf(i, !(i >= 20))));
    const session = await open(dom, PAGE);
    const r = loadRecipe(
      recipe({
        item: { selectors: [testid('card')], fingerprint: itemFp },
        fields: [
          { name: 'title', type: 'text', scope: 'item', selectors: [css('h2')] },
          { name: 'price', type: 'number', scope: 'item', selectors: [testid('price')], fingerprint: priceFp },
        ],
      }),
    );
    const out = (await extractPage(session, r, { pageUrl: PAGE, page: 1, ladder: defaultLadder({ enabled: true }), promote: true })).tables[0]!;
    const price = out.fields[1]!;
    expect(price.outcome.kind).toBe('fuzzy');
    expect(price.status).toBe('partial');
    expect(price.missingRows).toEqual([20, 21, 22, 23]);
    expect(out.rows[5]!.price).toBe(6);
    expect(out.missingRequired).toEqual([]);
    expect(out.promotions[0]!.coverage).toBe(20);
  });

  it('turns down an item field fuzzy match that holds in fewer than half the containers', async () => {
    const cardOf = (i: number, withPrice: boolean) =>
      h('li', {}, h('article', { 'data-testid': 'card' }, h('h2', {}, `Product ${i + 1}`), withPrice && h('span', {}, `$${i + 1}.00`)));
    const dom = h('html', {}, h('body', {}, h('ul', {}, Array.from({ length: 10 }, (_, i) => cardOf(i, i < 3)))));
    const origPrice = descendantsOf(annotate(dom)).find((n) => n.tag === 'span')!;
    const session = await open(dom, PAGE);
    const r = loadRecipe(
      recipe({
        item: { selectors: [testid('card')] },
        fields: [{ name: 'price', type: 'text', scope: 'item', selectors: [testid('price')], fingerprint: fingerprint(origPrice) }],
      }),
    );
    const out = (await extractPage(session, r, { pageUrl: PAGE, page: 1, ladder: defaultLadder({ enabled: true }), promote: true })).tables[0]!;
    expect(out.fields[0]).toMatchObject({ status: 'missing', outcome: { kind: 'unresolved' } });
    expect(out.missingRequired).toEqual(['price']);
  });

  it('heals a positional-only recipe on tier 2 in the item that matches the item fingerprint', async () => {
    const reference = referenceRecipe();
    const field = (name: string, selector: string) => ({ ...reference.fields!.find((f) => f.name === name)!, selectors: [{ strategy: 'xpath' as const, value: selector, stability: 'fragile' as const }] });
    const positional = { ...reference, item: { ...reference.item!, selectors: [{ strategy: 'xpath' as const, value: '//ul/li/article', stability: 'fragile' as const }] }, fields: [field('title', './h2[1]'), field('price', './p[1]')] };
    const session = await open(catalogSnapshot(2, 1));
    const out = (await extractPage(session, positional, { pageUrl: CATALOG, page: 1, ladder: defaultLadder({ enabled: true }), promote: true })).tables[0]!;
    expect(out.missingRequired).toEqual([]);
    expect(out.fields.map((f) => [f.name, f.status, f.outcome.kind])).toEqual([
      ['title', 'healed', 'fuzzy'],
      ['price', 'healed', 'fuzzy'],
    ]);
    const rows = out.rows.map((r) => ({ title: r.title, price: r.price })).sort((a, b) => String(a.title).localeCompare(String(b.title)));
    expect(rows).toEqual(dataset.map((p) => ({ title: p.title, price: p.price })).sort((a, b) => a.title.localeCompare(b.title)));
  });

  it('keeps the old behavior without a ladder: candidates only, no promotion', async () => {
    const session = await open(catalogSnapshot(1));
    const out = (await extractPage(session, fingerprintedRecipe(), { pageUrl: CATALOG, page: 1 })).tables[0]!;
    expect(out.missingRequired).toEqual(['item']);
    expect(out.promotions).toEqual([]);
  });
});
