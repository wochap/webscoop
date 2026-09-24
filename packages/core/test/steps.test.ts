import { describe, expect, it } from 'vitest';
import {
  annotate,
  candidatesResolver,
  defaultLadder,
  descendantsOf,
  fingerprint,
  loadRecipe,
  replaySteps,
  RunFailure,
  type Promotion,
  type Recipe,
  type RecipeInput,
  type Resolver,
  type SerializedElement,
  type StepReport,
} from '../src';
import { FakeBrowser, h, type FakePage } from '../src/testing';
import { catalog, cards, css, PAGE, recipe } from './helpers';

const accept = { selectors: [css('#accept')] };

/** A page whose products show only after the consent button is clicked. */
function gated(): SerializedElement {
  return h('html', {}, h('body', {}, h('div', { id: 'modal' }, h('button', { id: 'accept', class: 'consent' }, 'Accept all'))));
}

function withSteps(steps: RecipeInput['steps'], extra: Partial<RecipeInput> = {}): Recipe {
  return loadRecipe(recipe({ url: PAGE, vars: [{ name: 'q', type: 'string' }], steps, ...extra }));
}

async function open(pages: Record<string, FakePage>, url = PAGE) {
  const browser = new FakeBrowser(pages);
  const session = await browser.open('/p');
  await session.goto(url, { timeoutMs: 1000 });
  return { browser, session };
}

const consentPage = (): FakePage => ({ dom: gated(), on: { click: (el) => (el?.attrs.id === 'accept' ? catalog(cards(3)) : undefined) } });

describe('replaySteps', () => {
  it('clicks a consent button and settles on the revealed page', async () => {
    const { browser, session } = await open({ [PAGE]: consentPage() });
    const events: StepReport[] = [];
    const result = await replaySteps(session, withSteps([{ kind: 'click', target: accept }]), {
      page: 1,
      timeoutMs: 1000,
      cache: new Map(),
      onEvent: (r) => events.push(r),
    });
    expect(result.info?.url).toBe(PAGE);
    expect(browser.clicks).toEqual(['css=#accept >> nth=0']);
    expect(await session.resolve(css('article'))).toHaveLength(3);
    expect(result.steps).toEqual([{ index: 0, kind: 'click', page: 1, outcome: 'ok', heal: { kind: 'candidate', index: 0 }, candidate: css('#accept') }]);
    expect(events).toEqual(result.steps);
  });

  it('types a variable, presses Enter, and ends on the page the search navigated to', async () => {
    const form = h('html', {}, h('body', {}, h('input', { name: 'q' })));
    const results = 'https://shop.test/search?q=mouse';
    const { browser, session } = await open({
      [PAGE]: { dom: form, on: { press: (el, key) => (key === 'Enter' ? { redirect: `/search?q=${el?.attrs.value}` } : undefined) } },
      [results]: { dom: catalog(cards(2)) },
    });
    const navigated: string[] = [];
    const recipe = withSteps([
      { kind: 'type', target: { selectors: [css('input[name="q"]')] }, value: '{q}' },
      { kind: 'press', target: { selectors: [css('input[name="q"]')] }, value: 'Enter' },
    ]);
    const result = await replaySteps(session, recipe, {
      page: 1,
      vars: { q: 'mouse' },
      timeoutMs: 1000,
      cache: new Map(),
      onNavigated: async (info) => (navigated.push(info.url), info),
    });
    expect(browser.actions.map((a) => `${a.kind}:${a.value}`)).toEqual(['fill:mouse', 'press:Enter']);
    expect(result.info?.url).toBe(results);
    expect(navigated).toEqual([results]);
    expect(result.steps.map((s) => s.outcome)).toEqual(['ok', 'ok']);
  });

  it('chooses an option and presses a key on the focused element', async () => {
    const dom = h('html', {}, h('body', {}, h('select', { id: 'sort' }, h('option', { value: 'name' }, 'Name'), h('option', { value: 'price' }, 'Price'))));
    const { browser, session } = await open({ [PAGE]: { dom } });
    await replaySteps(session, withSteps([{ kind: 'select', target: { selectors: [css('#sort')] }, value: 'Price' }, { kind: 'press', value: 'Escape' }]), {
      page: 1,
      timeoutMs: 1000,
      cache: new Map(),
    });
    expect(browser.actions).toEqual([
      { kind: 'select', target: 'css=#sort >> nth=0', value: 'Price' },
      { kind: 'press', target: null, value: 'Escape' },
    ]);
  });

  it('waits a number of milliseconds, and for a target that shows up late', async () => {
    const { session } = await open({ [PAGE]: { dom: gated(), later: { afterMs: 40, dom: catalog(cards(2)) } } });
    const slept: number[] = [];
    const sleep = (ms: number) => (slept.push(ms), new Promise<void>((r) => setTimeout(r, ms)));
    const result = await replaySteps(session, withSteps([{ kind: 'wait', value: '5' }, { kind: 'wait', target: { selectors: [css('article')] } }]), {
      page: 1,
      timeoutMs: 1000,
      cache: new Map(),
      sleep,
      pollMs: 10,
    });
    expect(slept[0]).toBe(5);
    expect(slept.length).toBeGreaterThan(1);
    expect(result.steps.map((s) => s.outcome)).toEqual(['ok', 'ok']);
    expect(result.steps[1]!.candidate).toEqual(css('article'));
  });

  it('skips an optional step whose target is absent and fails a required one naming it', async () => {
    const { session } = await open({ [PAGE]: { dom: catalog(cards(2)) } });
    const skipped = await replaySteps(session, withSteps([{ kind: 'click', target: accept, optional: true }]), { page: 1, timeoutMs: 1000, cache: new Map() });
    expect(skipped.steps[0]).toMatchObject({ outcome: 'skipped', heal: { kind: 'unresolved' }, candidate: null, notes: ['found no element'] });

    const events: StepReport[] = [];
    const failing = replaySteps(session, withSteps([{ kind: 'type', target: accept, value: 'x' }]), {
      page: 1,
      timeoutMs: 1000,
      cache: new Map(),
      onEvent: (r) => events.push(r),
    });
    await expect(failing).rejects.toBeInstanceOf(RunFailure);
    await expect(failing).rejects.toMatchObject({ reason: 'missing-required', fields: ['step:0'] });
    expect(events[0]!.outcome).toBe('failed');
  });

  it('fails a required wait whose target never shows up within the timeout', async () => {
    const { session } = await open({ [PAGE]: { dom: gated() } });
    await expect(
      replaySteps(session, withSteps([{ kind: 'wait', target: { selectors: [css('article')] }, label: 'list' }]), { page: 1, timeoutMs: 30, cache: new Map(), pollMs: 5 }),
    ).rejects.toMatchObject({ reason: 'missing-required', fields: ['list'] });
  });

  it('runs first-page steps on page 1 only and every-page steps on every page', async () => {
    const { browser, session } = await open({ [PAGE]: { dom: h('html', {}, h('body', {}, h('button', { id: 'accept' }, 'A'), h('button', { id: 'tab' }, 'T'))) } });
    const recipe = withSteps([
      { kind: 'click', target: accept },
      { kind: 'click', target: { selectors: [css('#tab')] }, when: 'every-page' },
    ]);
    const cache = new Map();
    const one = await replaySteps(session, recipe, { page: 1, timeoutMs: 1000, cache });
    const two = await replaySteps(session, recipe, { page: 2, timeoutMs: 1000, cache });
    expect(one.steps.map((s) => s.index)).toEqual([0, 1]);
    expect(two.steps.map((s) => [s.index, s.page])).toEqual([[1, 2]]);
    expect(browser.clicks).toHaveLength(3);
  });

  it('reuses the selectors an every-page step settled on without running the ladder again', async () => {
    const { session } = await open({ [PAGE]: { dom: h('html', {}, h('body', {}, h('button', { id: 'tab' }, 'T'))) } });
    let ladderRuns = 0;
    const counting: Resolver = { name: 'counting', resolve: (t, c) => (ladderRuns++, candidatesResolver.resolve(t, c)) };
    const recipe = withSteps([{ kind: 'click', target: { selectors: [css('#tab')] }, when: 'every-page' }]);
    const cache = new Map();
    await replaySteps(session, recipe, { page: 1, timeoutMs: 1000, cache, ladder: [counting] });
    await replaySteps(session, recipe, { page: 2, timeoutMs: 1000, cache, ladder: [counting] });
    expect(ladderRuns).toBe(1);
    expect(cache.get(0)).toEqual([css('#tab')]);
  });

  it('heals a renamed consent button by fingerprint and promotes it', async () => {
    const recorded = annotate(gated().children[0] as SerializedElement);
    const button = descendantsOf(recorded).find((n) => n.tag === 'button')!;
    const renamed = h('html', {}, h('body', {}, h('div', { id: 'modal' }, h('button', { id: 'x7f3a', class: 'k2' }, 'Accept all'))));
    const { browser, session } = await open({ [PAGE]: { dom: renamed } });
    const promotions: Promotion[] = [];
    const recipe = withSteps([{ kind: 'click', target: { selectors: [css('#accept')], fingerprint: fingerprint(button) } }]);
    const result = await replaySteps(session, recipe, {
      page: 1,
      timeoutMs: 1000,
      cache: new Map(),
      ladder: defaultLadder({ enabled: true }),
      promote: true,
      onHealed: (p) => promotions.push(p),
    });
    expect(result.steps[0]).toMatchObject({ outcome: 'healed', heal: { kind: 'fuzzy' } });
    expect(browser.clicks).toHaveLength(1);
    expect(promotions).toHaveLength(1);
    expect(promotions[0]!.target).toMatchObject({ kind: 'step', index: 0 });
    expect(promotions[0]!.newPrimary).not.toEqual(css('#accept'));
  });
});
