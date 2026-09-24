import { MockLlm, mockFromScript, type MockScript } from '@webscoop/llm';
import { describe, expect, it, vi } from 'vitest';
import {
  annotate,
  buildPrompt,
  descendantsOf,
  estimateTokens,
  fingerprint,
  LlmError,
  MAX_CANDIDATES,
  modelResolver,
  pruneCandidates,
  recordEvents,
  RunEmitter,
  Runner,
  sampleOf,
  serializeCandidate,
  type HealTarget,
  type Recipe,
  type RecipeField,
} from '../src';
import { dataset } from '@webscoop/playground';
import { FakeBrowser, h } from '../src/testing';
import { catalogSnapshot, fingerprintedRecipe } from './healing-helpers';
import { CATALOG } from './recorder-helpers';

const field = (name: string, type: RecipeField['type'], extra: Partial<Extract<HealTarget, { kind: 'field' }>> = {}): HealTarget => ({
  kind: 'field',
  index: 0,
  name,
  scope: 'page',
  optional: false,
  type,
  selectors: [{ strategy: 'css', value: '.gone', stability: 'medium' }],
  ...extra,
});

const noCtx = { outerAncestors: [] as string[] };

describe('pruneCandidates', () => {
  it('keeps the prompt within 40 percent of the context window and at most 60 candidates', () => {
    const spans = Array.from({ length: 400 }, (_, i) => h('span', { class: `c${i}`, 'data-kind': 'price', title: `Item number ${i} of the long list` }, `Value ${i} `.repeat(12)));
    const root = annotate(h('html', {}, h('body', {}, h('main', {}, spans))));
    const target = field('price', 'text', { fingerprint: fingerprint(descendantsOf(root).find((n) => n.tag === 'span')!) });
    const llm = new MockLlm({ responses: [], contextTokens: 32_768 });
    const candidates = pruneCandidates(root, target, noCtx, llm);
    expect(candidates).toHaveLength(MAX_CANDIDATES);
    const prompt = buildPrompt(target, target.fingerprint, sampleOf(target), candidates.map((c) => c.node));
    expect(estimateTokens(prompt.map((m) => m.content).join('\n'))).toBeLessThanOrEqual(13_107);

    // A small window cuts the list by the token budget instead.
    const small = new MockLlm({ responses: [], contextTokens: 2000 });
    const few = pruneCandidates(root, target, noCtx, small);
    expect(few.length).toBeGreaterThan(0);
    expect(few.length).toBeLessThan(MAX_CANDIDATES);
    const fewPrompt = buildPrompt(target, target.fingerprint, sampleOf(target), few.map((c) => c.node));
    expect(estimateTokens(fewPrompt.map((m) => m.content).join('\n'))).toBeLessThanOrEqual(800);
  });

  it('lists only anchors for a url field', () => {
    const root = annotate(catalogSnapshot(0));
    const candidates = pruneCandidates(root, field('url', 'url'), noCtx, new MockLlm({ responses: [] }));
    expect(candidates.length).toBe(24);
    expect(new Set(candidates.map((c) => c.node.tag))).toEqual(new Set(['a']));
  });

  it('filters by field type and drops hidden, script, and style elements', () => {
    const root = annotate(
      h(
        'html',
        {},
        h('head', {}, h('title', {}, 'Shop'), h('style', {}, '.a { color: red }')),
        h(
          'body',
          {},
          h('div', { class: 'card' }, h('span', {}, '$5.00'), h('img', { src: '/a.png', alt: 'A' }), h('time', { datetime: '2026-01-02' })),
          h('div', { style: 'background-image: url(/b.png)' }),
          h('span', { hidden: '' }, 'hidden text'),
          h('div', { 'aria-hidden': 'true' }, h('span', {}, 'inside aria-hidden')),
          h('script', {}, 'var x = 1;'),
        ),
      ),
    );
    const tags = (type: RecipeField['type']) => pruneCandidates(root, field('f', type), noCtx, new MockLlm({ responses: [] })).map((c) => c.node.tag);
    expect(tags('text')).toEqual(['span']);
    expect(tags('number')).toEqual(['span']);
    expect(tags('image')).toEqual(['img', 'div']);
    expect(tags('date')).toEqual(['span', 'time']);
    expect(tags('html')).toEqual(['div', 'span', 'img', 'time', 'div']);
    const attr = pruneCandidates(root, field('f', 'text', { attr: 'datetime' }), noCtx, new MockLlm({ responses: [] }));
    expect(attr.map((c) => c.node.tag)).toEqual(['time']);
  });

  it('ranks by fingerprint score, best first', () => {
    const root = annotate(catalogSnapshot(2, 3));
    const recipe = fingerprintedRecipe();
    const price = recipe.fields.find((f) => f.name === 'price')!;
    const target = field('price', 'number', { fingerprint: price.fingerprint! });
    const candidates = pruneCandidates(root, target, noCtx, new MockLlm({ responses: [] }));
    const scores = candidates.map((c) => c.score!);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(candidates[0]!.node.tag).toBe('p');
  });
});

describe('prompt', () => {
  it('is identical for two runs on the same snapshot, and every line is under 160 characters', () => {
    const long = 'A very long product description that goes on and on '.repeat(6);
    const html = () =>
      h(
        'html',
        {},
        h(
          'body',
          {},
          h(
            'section',
            { id: 'products-with-a-rather-long-identifier', 'data-section-name': 'featured-products-of-the-week-and-more', 'aria-label': long },
            h('custom-element-with-a-long-tag-name', { 'data-a': long, 'data-b': long, title: long }, long),
            h('span', { 'data-qa': 'price' }, '$24.99'),
          ),
        ),
      );
    const build = () => {
      const root = annotate(html());
      const recipe = fingerprintedRecipe();
      const fp = { ...recipe.fields.find((f) => f.name === 'price')!.fingerprint!, textSample: long.slice(0, 80), name: long };
      const target = field('price', 'number', { fingerprint: fp });
      const candidates = pruneCandidates(root, target, noCtx, new MockLlm({ responses: [] }));
      return buildPrompt(target, target.fingerprint, sampleOf(target), candidates.map((c) => c.node));
    };
    const first = build();
    expect(build()).toEqual(first);
    const lines = first.flatMap((m) => m.content.split('\n'));
    for (const line of lines) expect(line.length, line).toBeLessThan(160);
    expect(first[0]!.role).toBe('system');
    expect(first[1]!.content).toContain('Field: price\nType: number\n');
    expect(first[1]!.content).toContain('Last value: ');
    expect(first[1]!.content).toMatch(/^#\d+ <span data-qa="price"> "\$24\.99" @ html>body>region$/m);
  });

  it('serializes tag, role, key attributes, own text, and four ancestors', () => {
    const root = annotate(catalogSnapshot(0));
    const price = descendantsOf(root).find((n) => n.attrs['data-testid'] === 'price')!;
    expect(serializeCandidate(price)).toBe('<p role="paragraph" data-testid="price"> "$24.99" @ main>list>listitem>article');
    const link = descendantsOf(root).find((n) => n.tag === 'a')!;
    expect(serializeCandidate(link)).toBe('<a role="link" href="/p/p##"> "View details" @ main>list>listitem>article');
  });
});

/** Answers per field; `item` picks the card of the product the recipe was recorded on. */
type Entry = Extract<MockScript, unknown[]>[number];

const TIER3_SCRIPT: Entry[] = [
  { match: 'Field: item', pick: 'data-product-id="p01"', reason: 'card of the recorded product', repeat: true },
  { match: 'Field: price', pick: 'data-qa="price"', reason: 'price with currency', repeat: true },
  { match: 'Field: rating', pick: 'data-qa="rating"', reason: 'rating out of 5', repeat: true },
  { match: 'Field: url', pick: '^<a ', reason: 'product link', repeat: true },
  { match: 'Field: title', pick: 'role="heading"', reason: 'product heading', repeat: true },
  { match: 'Field: image', pick: '^<img ', reason: 'product image', repeat: true },
];

function run(recipe: Recipe, llm: MockLlm, opts: { tier?: number; enabled?: boolean; log?: (m: string) => void } = {}) {
  const emitter = new RunEmitter();
  const log = recordEvents(emitter);
  const saved: Recipe[] = [];
  const runner = new Runner({
    recipe,
    browser: new FakeBrowser({ [CATALOG]: catalogSnapshot(opts.tier ?? 3, 5) }),
    profileDir: '/p',
    emitter,
    healing: { enabled: true, writeBack: true, resolvers: [modelResolver(llm, { enabled: opts.enabled ?? true, ...(opts.log ? { log: opts.log } : {}) })] },
    saveRecipe: async (r) => (saved.push(r), '/recipes/playground-catalog.json'),
  });
  return { result: runner.run(), log, saved };
}

/** The tier 3 script with the price answer replaced. */
const withPrice = (price: Entry): Entry[] => TIER3_SCRIPT.map((e) => (e.match === 'Field: price' ? price : e));

describe('modelResolver on tier 3', () => {
  it('heals through the model rung, reports the reason, and writes back', async () => {
    const llm = mockFromScript(TIER3_SCRIPT);
    const t = run(fingerprintedRecipe(), llm);
    const result = await t.result;
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    const price = result.report.fields.find((f) => f.name === 'price')!;
    expect(price.outcome).toEqual({ kind: 'model', rationale: 'price with currency' });
    expect(price.status).toBe('healed');
    expect(result.report.item?.outcome).toEqual({ kind: 'model', rationale: 'card of the recorded product' });
    const healed = t.log.of('field.healed').find((e) => e.target === 'price')!;
    expect(healed.outcome).toEqual({ kind: 'model', rationale: 'price with currency' });
    expect(t.saved).toHaveLength(1);
    expect(t.saved[0]!.fields.find((f) => f.name === 'price')!.selectors[0]).toEqual(healed.newPrimary);
    // Every price read through the promoted selectors is that card's price.
    expect(result.rows).toHaveLength(24);
    for (const row of result.rows) {
      const product = dataset.find((p) => new URL(p.url, CATALOG).href === row.url)!;
      expect(row.price).toBe(product.price);
    }
    // Each target asks the model at most once.
    const asked = llm.requests.map((r) => /^Field: (\w+)$/m.exec(r.prompt)![1]);
    expect(new Set(asked).size).toBe(asked.length);
    expect(asked).toContain('price');
    expect(llm.requests[0]!.opts).toMatchObject({ json: true, noThinking: true, maxTokens: 200 });
  });

  it('ignores a pick below confidence 0.5', async () => {
    const llm = mockFromScript(withPrice({ match: 'Field: price', pick: 'data-qa="price"', confidence: 0.3, reason: 'maybe' }));
    const result = await run(fingerprintedRecipe(), llm).result;
    expect(result.ok).toBe(false);
    const price = result.report.fields.find((f) => f.name === 'price')!;
    expect(price).toMatchObject({ status: 'missing', outcome: { kind: 'unresolved' } });
    expect(price.notes).toEqual([expect.stringMatching(/confidence 0\.3 below 0\.5 \(maybe\)/)]);
  });

  it('records the reason for a null pick', async () => {
    const llm = mockFromScript(withPrice({ match: 'Field: price', reply: { index: null, confidence: 0.9, reason: 'no price on the card' } }));
    const result = await run(fingerprintedRecipe(), llm).result;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fields).toContain('price');
    expect(result.report.fields.find((f) => f.name === 'price')!.notes).toEqual(['model: no pick (no price on the card)']);
  });

  it('rejects an index outside the list', async () => {
    const llm = mockFromScript(withPrice({ match: 'Field: price', reply: { index: 99, confidence: 0.9, reason: 'x' } }));
    const result = await run(fingerprintedRecipe(), llm).result;
    const price = result.report.fields.find((f) => f.name === 'price')!;
    expect(price.outcome).toEqual({ kind: 'unresolved' });
    expect(price.notes![0]).toMatch(/picked #99, outside candidates #1 to #\d+/);
  });

  it('rejects a pick for a number field whose text has no digits', async () => {
    const recipe = fingerprintedRecipe();
    // Without a fingerprint only the type check stands between the pick and acceptance.
    const price = recipe.fields.find((f) => f.name === 'price')!;
    delete price.fingerprint;
    const llm = mockFromScript(withPrice({ match: 'Field: price', pick: 'role="heading"', reason: 'the title' }));
    const result = await run(recipe, llm).result;
    const report = result.report.fields.find((f) => f.name === 'price')!;
    expect(report.outcome).toEqual({ kind: 'unresolved' });
    expect(report.notes).toEqual([expect.stringContaining('its text has no number')]);
  });

  it('rejects a confident pick of another field by the score floor (tier 4)', async () => {
    const script = TIER3_SCRIPT.map((e) => (e.match === 'Field: rating' ? { match: 'Field: rating', pick: 'data-qa="price"', reason: 'a number' } : e));
    const result = await run(fingerprintedRecipe(), mockFromScript(script), { tier: 4 }).result;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fields).toEqual(['rating']);
    const rating = result.report.fields.find((f) => f.name === 'rating')!;
    expect(rating).toMatchObject({ status: 'missing', outcome: { kind: 'unresolved' } });
    expect(rating.notes![0]).toMatch(/fingerprint score 0\.\d\d below 0\.4/);
  });

  it('skips the model for the remaining targets after an adapter error', async () => {
    const recipe = fingerprintedRecipe();
    // On tier 0 only the two dead fields without fingerprints reach the model rung.
    for (const name of ['price', 'rating']) {
      const f = recipe.fields.find((x) => x.name === name)!;
      f.selectors = [{ strategy: 'css', value: `.gone-${name}`, stability: 'medium' }];
      delete f.fingerprint;
    }
    const llm = new MockLlm({ responses: [{ reply: new LlmError('network', 'connect ECONNREFUSED 127.0.0.1:11434') }, { reply: '{"index": 1, "confidence": 1, "reason": "x"}' }] });
    const log = vi.fn();
    const result = await run(recipe, llm, { tier: 0, log }).result;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fields).toEqual(['price', 'rating']);
    expect(llm.requests).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/language model failed on price, skipping the model for the rest of this run: connect ECONNREFUSED/);
    expect(result.report.fields.find((f) => f.name === 'price')!.notes).toEqual([expect.stringContaining('no usable answer')]);
    expect(result.report.fields.find((f) => f.name === 'rating')!.notes).toBeUndefined();
  });

  it('keeps asking after a malformed answer, which is not an endpoint failure', async () => {
    const recipe = fingerprintedRecipe();
    for (const name of ['price', 'rating']) {
      const f = recipe.fields.find((x) => x.name === name)!;
      f.selectors = [{ strategy: 'css', value: `.gone-${name}`, stability: 'medium' }];
      delete f.fingerprint;
    }
    const llm = new MockLlm({ responses: [{ reply: 'nope' }, { reply: 'still nope' }, { reply: '{"index": null, "confidence": 1, "reason": "none"}' }] });
    const log = vi.fn();
    await run(recipe, llm, { tier: 0, log }).result;
    expect(llm.requests).toHaveLength(3);
    expect(log).not.toHaveBeenCalled();
  });

  it('sends nothing when disabled or when the recipe opts out', async () => {
    const off = new MockLlm({ responses: [{ reply: '{}', repeat: true }] });
    const disabled = await run(fingerprintedRecipe(), off, { enabled: false }).result;
    expect(disabled.ok).toBe(false);
    expect(off.requests).toHaveLength(0);

    const gated = mockFromScript(TIER3_SCRIPT);
    const recipe = { ...fingerprintedRecipe(), healing: { ...fingerprintedRecipe().healing, llm: false } };
    const optedOut = await run(recipe, gated).result;
    expect(optedOut.ok).toBe(false);
    if (!optedOut.ok) expect(optedOut.fields).toContain('item');
    expect(gated.requests).toHaveLength(0);
  });
});
