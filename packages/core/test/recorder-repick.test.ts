import { describe, expect, it } from 'vitest';
import { annotate, detach, draftFromRecipe, fingerprint, RecorderController, selectionOf, type Recipe } from '../src';
import { FakeBrowser } from '../src/testing';
import { catalogSnapshot, fingerprintedRecipe, tier0Nodes } from './healing-helpers';
import { css } from './helpers';
import { byClass, CATALOG, cardPath, MemoryStorage } from './recorder-helpers';

const PRICE = 1;

function brokenPrice(): Recipe {
  const recipe = fingerprintedRecipe();
  return { ...recipe, fields: recipe.fields!.map((f, i) => (i === PRICE ? { ...f, selectors: [css('.gone')] } : f)) };
}

async function setup(reason: 'run' | 'cli', dom = catalogSnapshot(0)) {
  const browser = new FakeBrowser({ [CATALOG]: dom });
  const session = await browser.open('/profile');
  await session.goto(CATALOG, { timeoutMs: 1000 });
  const storage = new MemoryStorage();
  const controller = new RecorderController({
    session,
    storage,
    bundle: '/* recorder */',
    draft: draftFromRecipe(brokenPrice()),
    mode: { kind: 'repick', fieldIndex: PRICE, reason },
    pathFor: (name) => `/recipes/${name}.json`,
  });
  const page = annotate(dom);
  const pick = (node: ReturnType<typeof byClass>, containerPath: number[] | null) =>
    session.callHost({ kind: 'picker.select', url: CATALOG, selection: selectionOf(node, { containerPath }), snapshot: detach(page) });
  return { browser, session, storage, controller, page, pick };
}

describe('recorder re-pick mode', () => {
  it('starts focused on the field with its old selector, fingerprint, sample, and threshold', async () => {
    const t = await setup('run');
    expect(t.controller.state.repick).toBe(PRICE);
    expect(t.controller.state.repickContext).toEqual({
      field: 'price',
      index: PRICE,
      oldSelector: css('.gone'),
      fingerprint: fingerprint(tier0Nodes().price!),
      sample: '$24.99',
      threshold: 0.7,
      reason: 'run',
      picked: null,
    });
  });

  it('attaches to the open page without navigating, and scores and confirms a pick', async () => {
    const t = await setup('run');
    await t.controller.attach();
    expect(t.browser.visited).toEqual([CATALOG]);
    expect(t.session.injected).toEqual(['/* recorder */']);
    await t.session.callHost({ kind: 'session.ready', url: CATALOG });
    await t.controller.idle();

    const price = byClass(t.page, 'product-price', 3);
    await t.pick(price, cardPath(price));
    const ctx = t.controller.state.repickContext!;
    expect(ctx.picked?.selector).toEqual({ strategy: 'testid', value: 'price', stability: 'stable' });
    expect(ctx.picked?.score).toBeGreaterThanOrEqual(0.7);
    expect(ctx.picked?.sample).toBe('24.99');
    expect(t.controller.state.repick).toBe(PRICE);

    const outcome = t.controller.awaitRepick();
    await t.session.callHost({ kind: 'repick.confirm' });
    expect(await outcome).toMatchObject({ kind: 'picked' });
    const picked = (await outcome) as Extract<Awaited<typeof outcome>, { kind: 'picked' }>;
    expect(picked.selectors[0]).toEqual({ strategy: 'testid', value: 'price', stability: 'stable' });
    expect(picked.selectors.every((s) => !('count' in s))).toBe(true);
    expect(picked.fingerprint?.textSample).toBe('$1,299.00');
    expect(t.storage.files.size).toBe(0);

    await t.controller.detach();
    expect(t.session.dispatchedOf('session.detach')).toHaveLength(1);
  });

  it('refuses to confirm before a pick', async () => {
    const t = await setup('run');
    await t.controller.attach();
    const reply = (await t.session.callHost({ kind: 'repick.confirm' })) as { state: { error: string } };
    expect(reply.state.error).toContain('pick the new location of price first');
  });

  it('resolves skip and abort from the page, and abort when the browser closes', async () => {
    for (const kind of ['skip', 'abort'] as const) {
      const t = await setup('run');
      await t.controller.attach();
      await t.session.callHost({ kind: `repick.${kind}` });
      expect(await t.controller.awaitRepick()).toEqual({ kind });
    }
    const t = await setup('run');
    await t.controller.attach();
    await t.session.userClose();
    expect(await t.controller.awaitRepick()).toEqual({ kind: 'abort' });
  });

  it('saves the recipe on confirm from the command line', async () => {
    const t = await setup('cli');
    await t.controller.start();
    const price = byClass(t.page, 'product-price', 0);
    await t.pick(price, cardPath(price));
    await t.session.callHost({ kind: 'repick.confirm' });
    expect((await t.controller.awaitRepick()).kind).toBe('picked');
    const saved = await t.storage.load('playground-catalog');
    expect(saved.fields![PRICE]!.selectors[0]).toEqual({ strategy: 'testid', value: 'price', stability: 'stable' });
    expect(saved.fields![PRICE]!.fingerprint?.textSample).toBe('$24.99');
    expect(t.controller.state.saved?.path).toBe('/recipes/playground-catalog.json');
  });

  it('rejects a mode for a field that does not exist', () => {
    expect(
      () =>
        new RecorderController({
          session: {} as never,
          storage: new MemoryStorage(),
          bundle: '',
          draft: draftFromRecipe(brokenPrice()),
          mode: { kind: 'repick', fieldIndex: 42, reason: 'cli' },
        }),
    ).toThrow('no field at index 42');
  });
});

describe('recorder guard mode', () => {
  async function guardSetup() {
    const browser = new FakeBrowser({ [CATALOG]: catalogSnapshot(0) });
    const session = await browser.open('/profile');
    await session.goto(CATALOG, { timeoutMs: 1000 });
    const controller = new RecorderController({
      session,
      storage: new MemoryStorage(),
      bundle: '/* recorder */',
      draft: draftFromRecipe(fingerprintedRecipe()),
      mode: { kind: 'guard' },
    });
    await controller.attach();
    return { session, controller };
  }
  const ctx = { kind: 'login' as const, reason: 'redirected to a login page', page: 1, url: CATALOG, deadline: Date.now() + 60_000 };

  it('shows the guard context and fires continue on guard.continue', async () => {
    const t = await guardSetup();
    const hooks = await t.controller.showGuard(ctx);
    expect(t.controller.state.guardContext).toEqual(ctx);
    expect(t.session.dispatchedOf('draft.state').at(-1)).toMatchObject({ state: { guardContext: ctx } });
    let continued = 0;
    let aborted = 0;
    hooks.onContinue(() => continued++);
    hooks.onAbort(() => aborted++);
    await t.session.callHost({ kind: 'guard.continue' });
    expect([continued, aborted]).toEqual([1, 0]);
  });

  it('fires abort on guard.abort and on the browser closing', async () => {
    const t = await guardSetup();
    let aborted = 0;
    (await t.controller.showGuard(ctx)).onAbort(() => aborted++);
    await t.session.callHost({ kind: 'guard.abort' });
    expect(aborted).toBe(1);
    await t.session.userClose();
    expect(aborted).toBe(2);
  });

  it('hides the banner, stops firing, and refuses guard messages afterwards', async () => {
    const t = await guardSetup();
    let continued = 0;
    (await t.controller.showGuard(ctx)).onContinue(() => continued++);
    await t.controller.hideGuard();
    expect(t.controller.state.guardContext).toBeNull();
    expect(t.session.dispatchedOf('draft.state').at(-1)).toMatchObject({ state: { guardContext: null } });
    const reply = await t.session.callHost({ kind: 'guard.continue' });
    expect(continued).toBe(0);
    expect(reply).toMatchObject({ kind: 'draft.state', state: { error: 'the run is not waiting on a guard' } });
  });

  it('tells pages loaded after detach to remove the recorder', async () => {
    const t = await guardSetup();
    await t.controller.detach();
    expect(await t.session.callHost({ kind: 'session.ready', url: CATALOG })).toEqual({ kind: 'session.detach' });
  });
});
