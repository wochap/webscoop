import { describe, expect, it } from 'vitest';
import {
  annotate,
  candidatesResolver,
  defaultLadder,
  descendantsOf,
  fingerprint,
  loadRecipe,
  runFlow,
  RunFailure,
  RunWindows,
  type FlowContext,
  type Promotion,
  type Recipe,
  type RecipeInput,
  type Resolver,
  type SerializedElement,
  type Session,
  type Step,
  type StepReport,
} from '../src';
import { FakeBrowser, h, type FakePage } from '../src/testing';
import { catalog, cards, css, PAGE, recipe } from './helpers';

const accept = { selectors: [css('#accept')] };

/** A page whose products show only after the consent button is clicked. */
function gated(): SerializedElement {
  return h('html', {}, h('body', {}, h('div', { id: 'modal' }, h('button', { id: 'accept', class: 'consent' }, 'Accept all'))));
}

type StepInput = Omit<Step, 'window' | 'optional'> & Partial<Pick<Step, 'window' | 'optional'>>;

function withSteps(steps: StepInput[], extra: Partial<RecipeInput> = {}): Recipe {
  return loadRecipe(recipe({ url: PAGE, vars: [{ name: 'q', type: 'string' }], flows: [{ name: 'setup', steps }], sequence: [{ flow: 'setup' }, { extract: 'items' }], ...extra }));
}

/** Run the recipe's first flow on a session, as the runner would. */
function replaySteps(session: Session, recipe: Recipe, ctx: Omit<FlowContext, 'windows'> & { windows?: RunWindows }) {
  return runFlow(recipe, recipe.flows[0]!, session, { windows: new RunWindows(session), ...ctx });
}

async function open(pages: Record<string, FakePage>, url = PAGE) {
  const browser = new FakeBrowser(pages);
  const session = await browser.open('/p');
  await session.goto(url, { timeoutMs: 1000 });
  return { browser, session };
}

const consentPage = (): FakePage => ({ dom: gated(), on: { click: (el) => (el?.attrs.id === 'accept' ? catalog(cards(3)) : undefined) } });

describe('runFlow', () => {
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
    expect(result.steps).toEqual([{ flow: 'setup', index: 0, kind: 'click', page: 1, outcome: 'ok', heal: { kind: 'candidate', index: 0 }, candidate: css('#accept') }]);
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
      { kind: 'fill', target: { selectors: [css('input[name="q"]')] }, value: '{q}' },
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

  it('fills a native select by option label and presses a key on the focused element', async () => {
    const dom = h('html', {}, h('body', {}, h('select', { id: 'sort' }, h('option', { value: 'name' }, 'Name'), h('option', { value: 'price' }, 'Price'))));
    const { browser, session } = await open({ [PAGE]: { dom } });
    await replaySteps(session, withSteps([{ kind: 'fill', target: { selectors: [css('#sort')] }, value: 'Price' }, { kind: 'press', value: 'Escape' }]), {
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
    const failing = replaySteps(session, withSteps([{ kind: 'fill', target: accept, value: 'x' }]), {
      page: 1,
      timeoutMs: 1000,
      cache: new Map(),
      onEvent: (r) => events.push(r),
    });
    await expect(failing).rejects.toBeInstanceOf(RunFailure);
    await expect(failing).rejects.toMatchObject({ reason: 'missing-required', fields: ['setup:0'] });
    await expect(failing).rejects.toThrow(/flow "setup"/);
    expect(events[0]!.outcome).toBe('failed');
  });

  it('fails a required wait whose target never shows up within the timeout', async () => {
    const { session } = await open({ [PAGE]: { dom: gated() } });
    await expect(
      replaySteps(session, withSteps([{ kind: 'wait', target: { selectors: [css('article')] }, label: 'list' }]), { page: 1, timeoutMs: 30, cache: new Map(), pollMs: 5 }),
    ).rejects.toMatchObject({ reason: 'missing-required', fields: ['list'] });
  });

  it('reuses the selectors a step settled on in later runs without running the ladder again', async () => {
    const { session } = await open({ [PAGE]: { dom: h('html', {}, h('body', {}, h('button', { id: 'tab' }, 'T'))) } });
    let ladderRuns = 0;
    const counting: Resolver = { name: 'counting', resolve: (t, c) => (ladderRuns++, candidatesResolver.resolve(t, c)) };
    const recipe = withSteps([{ kind: 'click', target: { selectors: [css('#tab')] } }]);
    const cache = new Map();
    await replaySteps(session, recipe, { page: 1, timeoutMs: 1000, cache, ladder: [counting] });
    const two = await replaySteps(session, recipe, { page: 2, timeoutMs: 1000, cache, ladder: [counting] });
    expect(ladderRuns).toBe(1);
    expect(cache.get('setup:0')).toEqual({ selectors: [css('#tab')] });
    expect(two.steps.map((s) => [s.index, s.page])).toEqual([[0, 2]]);
  });

  it('runs a checkpoint before each step', async () => {
    const { session } = await open({ [PAGE]: { dom: h('html', {}, h('body', {}, h('button', { id: 'accept' }, 'A'))) } });
    let checkpoints = 0;
    await replaySteps(session, withSteps([{ kind: 'click', target: accept }, { kind: 'wait', value: '1' }]), { page: 1, timeoutMs: 1000, cache: new Map(), checkpoint: async () => void checkpoints++ });
    expect(checkpoints).toBe(2);
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
    expect(promotions[0]!.target).toMatchObject({ kind: 'step', flow: 'setup', index: 0 });
    expect(promotions[0]!.newPrimary).not.toEqual(css('#accept'));
  });
});

describe('runFlow windows', () => {
  const LOGIN = 'https://shop.test/login';
  const loginButton = { selectors: [css('#login')] };
  const user = { selectors: [css('#user')] };

  /** A page whose "Log in" button opens a login popup with a user input. */
  function withPopup(): Record<string, FakePage> {
    return {
      [PAGE]: { dom: h('html', {}, h('body', {}, h('button', { id: 'login' }, 'Log in'))), on: { click: (el) => (el?.attrs.id === 'login' ? { popup: '/login' } : undefined) } },
      [LOGIN]: { dom: h('html', {}, h('body', {}, h('input', { id: 'user' }))) },
    };
  }

  it('fills the input of the popup an earlier step opened', async () => {
    const { browser, session } = await open(withPopup());
    const result = await replaySteps(session, withSteps([{ kind: 'click', target: loginButton }, { kind: 'fill', target: user, value: 'u', window: 'popup' }]), { page: 1, timeoutMs: 1000, cache: new Map() });
    expect(result.steps.map((s) => s.outcome)).toEqual(['ok', 'ok']);
    expect(browser.popups).toHaveLength(1);
    expect(browser.actions).toEqual([{ kind: 'fill', target: 'css=#user >> nth=0', value: 'u' }]);
    expect(await browser.popups[0]!.url()).toBe(LOGIN);
  });

  it('fails a required popup step with missing-required when no popup opens in time', async () => {
    const { session } = await open({ [PAGE]: { dom: h('html', {}, h('body', {}, h('button', { id: 'login' }, 'Log in'))) } });
    const run = replaySteps(session, withSteps([{ kind: 'click', target: loginButton }, { kind: 'fill', target: user, value: 'u', window: 'popup', label: 'user' }]), { page: 1, timeoutMs: 30, cache: new Map() });
    await expect(run).rejects.toMatchObject({ reason: 'missing-required', fields: ['user'] });
    await expect(run).rejects.toThrow(/found no popup within 30 ms/);
  });

  it('does not use a popup opened before the flow started', async () => {
    const { browser, session } = await open(withPopup());
    const windows = new RunWindows(session);
    await session.click((await session.resolve(css('#login')))[0]!);
    expect(browser.popups).toHaveLength(1);
    const run = replaySteps(session, withSteps([{ kind: 'fill', target: user, value: 'u', window: 'popup', optional: true }]), { page: 1, timeoutMs: 20, cache: new Map(), windows });
    expect((await run).steps[0]).toMatchObject({ outcome: 'skipped' });
  });
});

describe('runFlow await-user after its popup closed', () => {
  it('checks the condition with the flow window when the popup it names already closed itself', async () => {
    const LOGIN = 'https://shop.test/login';
    const browser = new FakeBrowser({
      [PAGE]: { dom: h('html', {}, h('body', {}, h('button', { id: 'login' }, 'Log in'))), on: { click: () => ({ popup: '/login' }) } },
      [LOGIN]: { dom: h('html', {}, h('body', {}, h('input', { id: 'user' }))) },
    });
    const session = await browser.open('/p');
    await session.goto(PAGE, { timeoutMs: 1000 });
    const recipe = withSteps([
      { kind: 'click', target: { selectors: [css('#login')] } },
      { kind: 'await-user', target: { selectors: [css('#login')] }, until: 'disappears', window: 'popup' },
    ]);
    // The user logs in at once: the popup closes and the button goes away before the step starts.
    session.onPopup((popup) => void (popup as typeof session).userClose().then(() => session.replaceDom(h('html', {}, h('body', {}, h('p', {}, 'in'))))));
    const result = await replaySteps(session, recipe, { page: 1, timeoutMs: 200, cache: new Map(), pollMs: 5 });
    expect(result.steps.map((s) => s.outcome)).toEqual(['ok', 'ok']);
  });
});
