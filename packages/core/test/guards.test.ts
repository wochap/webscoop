import { describe, expect, it, vi } from 'vitest';
import {
  captchaDetector,
  detect,
  enabledDetectors,
  extractPage,
  guardContext,
  GuardBudget,
  GuardWaitAborted,
  loadRecipe,
  loginDetector,
  Recheck,
  recordEvents,
  RunEmitter,
  Runner,
  waitForClear,
  zeroFieldsDetector,
  type GuardBannerHandler,
  type GuardBannerInfo,
  type Notification,
  type PageInfo,
  type RecipeInput,
  type RunOptions,
  type SerializedElement,
  type Session,
} from '../src';
import { FakeBrowser, h, type FakePage } from '../src/testing';
import { catalog, cards, PAGE, recipe } from './helpers';

const LOGIN = 'https://shop.test/login?next=%2Fc%2Felectronics';
const HOME = 'https://shop.test/';

function loginForm(): SerializedElement {
  return h(
    'html',
    {},
    h('head', {}, h('title', {}, 'Sign in')),
    h('body', {}, h('form', { action: '/login', method: 'post' }, h('input', { name: 'username' }), h('input', { name: 'password', type: 'password' }), h('button', {}, 'Sign in'))),
  );
}

function challenge(): SerializedElement {
  return h(
    'html',
    {},
    h('body', {}, h('h1', {}, 'Verify you are human'), h('iframe', { src: 'https://challenges.test/turnstile/v0/api' }), h('form', { id: 'challenge-form' }, h('button', {}, 'I am human'))),
  );
}

function interstitial(): SerializedElement {
  return h('html', {}, h('body', {}, h('p', {}, 'Please wait while we check your browser.')));
}

/** A long page with no product cards: a redesign, not a wall. */
function redesign(): SerializedElement {
  const words = 'Our new store layout is here with curated collections and editorial picks for every season. ';
  return h('html', {}, h('body', {}, h('main', {}, Array.from({ length: 10 }, () => h('p', {}, words)))));
}

async function sessionOn(url: string, page: FakePage | SerializedElement): Promise<{ session: Session; info: PageInfo }> {
  const browser = new FakeBrowser({ [url]: page });
  const session = await browser.open('/p');
  const info = await session.goto(url, { timeoutMs: 1000 });
  return { session, info };
}

describe('guard detectors', () => {
  const shop = loadRecipe(recipe());

  it('raises login on a redirect to a login URL', async () => {
    const browser = new FakeBrowser({ [PAGE]: { dom: loginForm(), redirect: LOGIN }, [LOGIN]: loginForm() });
    const session = await browser.open('/p');
    const info = await session.goto(PAGE, { timeoutMs: 1000 });
    expect(info.url).toBe(LOGIN);
    const match = await loginDetector.matches(guardContext({ session, recipe: shop, info, intendedUrl: PAGE }));
    expect(match).toMatchObject({ kind: 'login' });
    expect(match!.reason).toContain('/login');
  });

  it('does not raise login from the URL alone when the intended URL is a login URL too', async () => {
    const { session, info } = await sessionOn('https://shop.test/account/login/catalog', catalog(cards(2)));
    expect(await loginDetector.matches(guardContext({ session, recipe: shop, info, intendedUrl: info.url }))).toBeNull();
  });

  it('raises login on a visible password field without items', async () => {
    const { session, info } = await sessionOn(PAGE, loginForm());
    expect(await loginDetector.matches(guardContext({ session, recipe: shop, info, intendedUrl: PAGE }))).toMatchObject({ kind: 'login' });
  });

  it('ignores a password field when items are present', async () => {
    const dom = catalog(cards(2));
    (dom.children[1] as SerializedElement).children.push(h('input', { type: 'password' }));
    const { session, info } = await sessionOn(PAGE, dom);
    expect(await loginDetector.matches(guardContext({ session, recipe: shop, info, intendedUrl: PAGE }))).toBeNull();
  });

  it('raises captcha on a turnstile iframe', async () => {
    const { session, info } = await sessionOn(PAGE, { dom: challenge(), status: 200 });
    const match = await captchaDetector.matches(guardContext({ session, recipe: shop, info, intendedUrl: PAGE }));
    expect(match).toMatchObject({ kind: 'captcha' });
    expect(match!.reason).toContain('turnstile');
  });

  it('raises captcha on a 403 page asking to verify', async () => {
    const dom = h('html', {}, h('body', {}, h('p', {}, 'Please verify your request to continue.')));
    const { session, info } = await sessionOn(PAGE, { dom, status: 403 });
    expect(await captchaDetector.matches(guardContext({ session, recipe: shop, info, intendedUrl: PAGE }))).toMatchObject({ kind: 'captcha' });
  });

  it('ignores a 403 page without challenge words', async () => {
    const dom = h('html', {}, h('body', {}, h('p', {}, 'Forbidden.')));
    const { session, info } = await sessionOn(PAGE, { dom, status: 403 });
    expect(await captchaDetector.matches(guardContext({ session, recipe: shop, info, intendedUrl: PAGE }))).toBeNull();
  });

  it('raises zero-fields on a short 503 page where nothing resolved', async () => {
    const { session, info } = await sessionOn(PAGE, { dom: interstitial(), status: 503 });
    const extraction = await extractPage(session, shop, { pageUrl: info.url, page: 1 });
    expect(await zeroFieldsDetector.matches(guardContext({ session, recipe: shop, info, intendedUrl: PAGE, extraction }))).toMatchObject({ kind: 'zero-fields' });
  });

  it('raises zero-fields on a short 200 page where nothing resolved', async () => {
    const { session, info } = await sessionOn(PAGE, interstitial());
    const extraction = await extractPage(session, shop, { pageUrl: info.url, page: 1 });
    expect(await zeroFieldsDetector.matches(guardContext({ session, recipe: shop, info, intendedUrl: PAGE, extraction }))).toMatchObject({ kind: 'zero-fields' });
  });

  it('raises no guard on a long 200 page without fields: a redesign', async () => {
    const { session, info } = await sessionOn(PAGE, redesign());
    expect((await session.pageText()).length).toBeGreaterThan(500);
    const extraction = await extractPage(session, shop, { pageUrl: info.url, page: 1 });
    const ctx = guardContext({ session, recipe: shop, info, intendedUrl: PAGE, extraction });
    expect(await detect(enabledDetectors(shop), 'load', ctx)).toBeNull();
    expect(await detect(enabledDetectors(shop), 'extract', ctx)).toBeNull();
  });

  it('raises no zero-fields on an empty short later page served with 200', async () => {
    const { session, info } = await sessionOn(PAGE, interstitial());
    const extraction = await extractPage(session, shop, { pageUrl: info.url, page: 2 });
    expect(await zeroFieldsDetector.matches(guardContext({ session, recipe: shop, info, intendedUrl: PAGE, extraction, laterPage: true }))).toBeNull();
  });

  it('reports captcha before login when both match', async () => {
    const dom = loginForm();
    (dom.children[1] as SerializedElement).children.push(h('div', { class: 'cf-turnstile' }));
    const { session, info } = await sessionOn(PAGE, dom);
    expect(await detect(enabledDetectors(shop), 'load', guardContext({ session, recipe: shop, info, intendedUrl: PAGE }))).toMatchObject({ kind: 'captcha' });
  });

  it('orders detectors captcha, login, zero-fields and filters disabled kinds', () => {
    expect(enabledDetectors(shop).map((d) => d.kind)).toEqual(['captcha', 'login', 'zero-fields']);
    const noCaptcha = loadRecipe(recipe({ guards: [{ kind: 'captcha', enabled: false }, { kind: 'login', enabled: true }, { kind: 'zero-fields', enabled: true }] }));
    expect(enabledDetectors(noCaptcha).map((d) => d.kind)).toEqual(['login', 'zero-fields']);
    expect(enabledDetectors(shop, false)).toEqual([]);
  });
});

/** A session whose `settle` reports the given URL; `check` decides whether the guard still matches. */
function settleSession(): Session {
  return { settle: async () => ({ url: PAGE, title: '', status: 200 }) } as unknown as Session;
}

describe('waitForClear', () => {
  it('clears once the check stops matching, after N ticks', async () => {
    let ticks = 0;
    const check = vi.fn(async () => (++ticks < 3 ? { kind: 'login' as const, reason: 'still there' } : null));
    const onTick = vi.fn();
    const result = await waitForClear(check, settleSession(), { budget: new GuardBudget(10_000), pollMs: 1, onTick });
    expect(result).toMatchObject({ cleared: true, info: { url: PAGE } });
    expect(check).toHaveBeenCalledTimes(3);
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it('gives up when the budget is exhausted', async () => {
    const result = await waitForClear(async () => ({ kind: 'captcha', reason: 'x' }), settleSession(), { budget: new GuardBudget(40), pollMs: 5 });
    expect(result.cleared).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(35);
  });

  it('gives up at once with a zero budget', async () => {
    const check = vi.fn(async () => null);
    const result = await waitForClear(check, settleSession(), { budget: new GuardBudget(0) });
    expect(result).toEqual({ cleared: false, waitedMs: 0 });
    expect(check).not.toHaveBeenCalled();
  });

  it('shares one budget across two guards', async () => {
    let clock = 0;
    const now = () => clock;
    const budget = new GuardBudget(100);
    let ticks = 0;
    // Every poll costs 10 fake milliseconds.
    const session = { settle: async () => ((clock += 10), { url: PAGE, title: '', status: 200 }) } as unknown as Session;
    const first = await waitForClear(async () => (++ticks < 3 ? { kind: 'login', reason: 'x' } : null), session, { budget, pollMs: 1, now });
    expect(first).toMatchObject({ cleared: true, waitedMs: 30 });
    expect(budget.remainingMs).toBe(70);
    const second = await waitForClear(async () => ({ kind: 'captcha', reason: 'x' }), session, { budget, pollMs: 1, now });
    expect(second).toEqual({ cleared: false, waitedMs: 70 });
    expect(budget.exhausted).toBe(true);
  });

  it('rejects when aborted mid-wait', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(
      waitForClear(async () => ({ kind: 'login', reason: 'x' }), settleSession(), { budget: new GuardBudget(60_000), pollMs: 5, signal: controller.signal }),
    ).rejects.toBeInstanceOf(GuardWaitAborted);
  });

  it('re-evaluates at once on a recheck', async () => {
    const recheck = new Recheck();
    let fixed = false;
    setTimeout(() => {
      fixed = true;
      recheck.trigger();
    }, 10);
    const started = Date.now();
    const result = await waitForClear(async () => (fixed ? null : { kind: 'login', reason: 'x' }), settleSession(), { budget: new GuardBudget(60_000), pollMs: 30_000, recheck });
    expect(result.cleared).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('keeps polling when the page is mid-navigation', async () => {
    let calls = 0;
    const session = {
      settle: async () => {
        if (++calls === 1) throw new Error('Execution context was destroyed');
        return { url: PAGE, title: '', status: 200 };
      },
    } as unknown as Session;
    expect(await waitForClear(async () => null, session, { budget: new GuardBudget(10_000), pollMs: 1 })).toMatchObject({ cleared: true });
    expect(calls).toBe(2);
  });
});

function setupRun(pages: Record<string, FakePage | SerializedElement>, extra: Omit<Partial<RunOptions>, 'recipe'> & { recipe?: RecipeInput } = {}) {
  const browser = new FakeBrowser(pages);
  const emitter = new RunEmitter();
  const log = recordEvents(emitter);
  const notifications: Notification[] = [];
  const shown = vi.fn(async () => {});
  const saveRecipe = vi.fn(async () => '/recipes/shop.json');
  const { recipe: input, ...rest } = extra;
  const runner = new Runner({
    recipe: loadRecipe(input ?? recipe()),
    browser,
    profileDir: '/p',
    emitter,
    saveRecipe,
    guards: {
      enabled: true,
      timeoutMs: 5_000,
      pollMs: 1,
      notify: { notify: async (n) => void notifications.push(n) },
      window: { show: shown, hide: async () => {} },
    },
    ...rest,
  });
  /** Play the user: once a guard is raised, run `act` against the run's own session. */
  const onRaised = (act: (session: Session) => Promise<unknown>) =>
    emitter.on('guard.raised', () => void Promise.resolve().then(() => act(browser.sessions.at(-1)!)));
  return { browser, emitter, log, notifications, shown, runner, onRaised, saveRecipe };
}

describe('runner guards', () => {
  it('pauses on a login redirect, resumes when the user logs in, and reports the guard', async () => {
    const t = setupRun({ [PAGE]: { dom: loginForm(), redirect: LOGIN }, [LOGIN]: loginForm() });
    t.onRaised(async (session) => {
      t.browser.setPage(PAGE, catalog(cards(3)));
      await session.goto(PAGE, { timeoutMs: 1000 });
    });
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(3);
    expect(t.runner.states).toEqual(['idle', 'opening', 'navigating', 'guarded', 'navigating', 'extracting', 'done']);
    expect(t.log.sequence().slice(0, 6)).toEqual(['run.start', 'page.loaded', 'guard.raised', 'guard.cleared', 'page.loaded', 'field.resolved']);
    expect(t.log.of('guard.raised')).toEqual([{ kind: 'login', page: 1, url: LOGIN, reason: expect.stringContaining('login page') }]);
    expect(t.notifications).toHaveLength(1);
    expect(t.notifications[0]).toMatchObject({ urgency: 'critical', title: expect.stringContaining('shop'), body: expect.stringMatching(/login.*page 1/) });
    expect(t.shown).toHaveBeenCalledTimes(1);
    expect(t.browser.sessions[0]!.focused).toBe(1);
    const [entry] = result.report.guards;
    expect(entry).toMatchObject({ kind: 'login', page: 1, url: LOGIN, cleared: true });
    expect(entry!.waitedMs).toBeGreaterThanOrEqual(0);
    expect(result.report.guards).toHaveLength(1);
  });

  it('navigates back to the intended page when the user lands elsewhere after logging in', async () => {
    const t = setupRun({ [PAGE]: { dom: loginForm(), redirect: LOGIN }, [LOGIN]: loginForm(), [HOME]: h('html', {}, h('body', {}, 'Welcome back')) });
    t.onRaised(async (session) => {
      t.browser.setPage(PAGE, catalog(cards(2)));
      await session.goto(HOME, { timeoutMs: 1000 });
    });
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(t.browser.visited).toEqual([PAGE, HOME, PAGE]);
    expect(result.report.finalUrl).toBe(PAGE);
  });

  it('fails with paused when nobody clears the guard, keeping no rows and writing nothing back', async () => {
    const t = setupRun({ [PAGE]: { dom: loginForm(), redirect: LOGIN }, [LOGIN]: loginForm() }, {
      guards: { enabled: true, timeoutMs: 30, pollMs: 5 },
    });
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'paused', rows: [] });
    expect(!result.ok && result.message).toMatch(/login guard on page 1.*http/);
    expect(t.runner.states).toEqual(['idle', 'opening', 'navigating', 'guarded', 'failed']);
    expect(t.log.names()).toContain('guard.timeout');
    expect(result.report.guards).toEqual([expect.objectContaining({ kind: 'login', cleared: false })]);
    expect(t.saveRecipe).not.toHaveBeenCalled();
    expect(t.browser.openSessions).toBe(0);
  });

  it('fails at once after the notification with a zero timeout', async () => {
    const t = setupRun({ [PAGE]: loginForm() });
    const runner = new Runner({ ...(t.runner as unknown as { opts: RunOptions }).opts, guards: { enabled: true, timeoutMs: 0, notify: { notify: async (n) => void t.notifications.push(n) } } });
    const result = await runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'paused' });
    expect(t.notifications).toHaveLength(1);
    expect(result.report.guards[0]).toMatchObject({ waitedMs: 0, cleared: false });
  });

  it('re-extracts after a zero-fields guard clears', async () => {
    const t = setupRun({ [PAGE]: { dom: interstitial(), status: 503 } });
    t.onRaised(async (session) => {
      t.browser.setPage(PAGE, catalog(cards(4)));
      await session.goto(PAGE, { timeoutMs: 1000 });
    });
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(4);
    expect(t.runner.states).toEqual(['idle', 'opening', 'navigating', 'extracting', 'guarded', 'extracting', 'done']);
    expect(t.log.of('guard.raised')[0]).toMatchObject({ kind: 'zero-fields', page: 1 });
  });

  it('keeps the missing-field policy on a redesign', async () => {
    const t = setupRun({ [PAGE]: redesign() });
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'missing-required' });
    expect(t.log.names()).not.toContain('guard.raised');
  });

  it('raises nothing on a normal page', async () => {
    const t = setupRun({ [PAGE]: catalog(cards(3)) });
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(result.report.guards).toEqual([]);
    expect(t.notifications).toEqual([]);
  });

  it('extracts a challenge page as is when the recipe disables captcha', async () => {
    const dom = catalog(cards(2));
    (dom.children[1] as SerializedElement).children.push(h('iframe', { src: 'https://challenges.test/turnstile' }));
    const t = setupRun({ [PAGE]: { dom, status: 403 } }, {
      recipe: recipe({ guards: [{ kind: 'captcha', enabled: false }, { kind: 'login', enabled: true }, { kind: 'zero-fields', enabled: true }] }),
    });
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(t.log.names()).not.toContain('guard.raised');
  });

  it('behaves as if no guard existed when the run disables guards', async () => {
    const t = setupRun({ [PAGE]: loginForm() }, { guards: { enabled: false, timeoutMs: 5_000 } });
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'missing-required' });
    expect(t.log.names()).not.toContain('guard.raised');
  });

  it('pauses on page 3 of a paginated run and continues with page 4', async () => {
    const paged = (n: number) => `${PAGE}?page=${n}`;
    const pageOf = (n: number) => catalog(cards(2, (i) => ({ title: `P${n}-${i}` })));
    const t = setupRun(
      { [paged(1)]: pageOf(1), [paged(2)]: pageOf(2), [paged(3)]: { dom: challenge(), status: 403 }, [paged(4)]: pageOf(4) },
      { recipe: recipe({ pagination: { kind: 'url', param: { name: 'page', start: 1, step: 1 }, limit: 4 } }) },
    );
    t.emitter.on('guard.raised', () => {
      // Pages 1 and 2 were emitted before the pause.
      expect(t.log.of('row.emitted').map((e) => e.page)).toEqual([1, 1, 2, 2]);
    });
    t.onRaised(async (session) => {
      t.browser.setPage(paged(3), pageOf(3));
      await session.goto(paged(3), { timeoutMs: 1000 });
    });
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(result.rows.map((r) => r._page)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(result.report.guards).toEqual([expect.objectContaining({ kind: 'captcha', page: 3, url: paged(3), cleared: true })]);
  });

  it('keeps the rows of completed pages when a later guard times out', async () => {
    const paged = (n: number) => `${PAGE}?page=${n}`;
    const t = setupRun(
      { [paged(1)]: catalog(cards(2)), [paged(2)]: { dom: challenge(), status: 403 } },
      { recipe: recipe({ pagination: { kind: 'url', param: { name: 'page', start: 1, step: 1 }, limit: 3 } }), guards: { enabled: true, timeoutMs: 10, pollMs: 2 } },
    );
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'paused' });
    expect(result.rows).toHaveLength(2);
  });

  it('shows the banner, re-checks at once on Continue, and hides it', async () => {
    const shown: GuardBannerInfo[] = [];
    let cont: (() => void) | undefined;
    const hide = vi.fn(async () => {});
    const banner: GuardBannerHandler = {
      show: async (_session, info) => {
        shown.push(info);
        return { onContinue: (cb) => (cont = cb), onAbort: () => {} };
      },
      hide,
    };
    const t = setupRun({ [PAGE]: loginForm() }, { guards: { enabled: true, timeoutMs: 60_000, pollMs: 60_000, banner } });
    t.onRaised(async (session) => {
      t.browser.setPage(PAGE, catalog(cards(1)));
      await session.goto(PAGE, { timeoutMs: 1000 });
      // The banner shows after `guard.raised`.
      while (!cont) await new Promise((resolve) => setTimeout(resolve, 1));
      cont();
    });
    const started = Date.now();
    const result = await t.runner.run();
    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(shown).toEqual([expect.objectContaining({ kind: 'login', page: 1, url: PAGE, deadline: expect.any(Number) })]);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('ends with aborted when the banner aborts', async () => {
    const banner: GuardBannerHandler = {
      show: async () => ({ onContinue: () => {}, onAbort: (cb) => void setTimeout(cb, 5) }),
      hide: async () => {},
    };
    const t = setupRun({ [PAGE]: loginForm() }, { guards: { enabled: true, timeoutMs: 60_000, pollMs: 60_000, banner } });
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
  });

  it('ends with aborted when the run is interrupted while paused', async () => {
    const controller = new AbortController();
    const t = setupRun({ [PAGE]: loginForm() }, { signal: controller.signal });
    t.onRaised(async () => controller.abort());
    const result = await t.runner.run();
    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
    expect(t.browser.openSessions).toBe(0);
  });
});
