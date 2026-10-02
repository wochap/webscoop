import { readFile } from 'node:fs/promises';
import type { Browser, Page } from '@playwright/test';
import { loadRecipe, type RecipeInput } from '@webscoop/core';
import { dataset } from '@webscoop/playground';
import { expect, hasDisplay, test, type Scoop } from './fixtures';
import type { HookState } from './recorder-fixture';

test.skip(!hasDisplay, 'the CLI and the recorder need WAYLAND_DISPLAY or DISPLAY');

const css = (value: string) => ({ selectors: [{ strategy: 'css' as const, value, stability: 'medium' as const }] });
const click = (selector: string) => ({ kind: 'click' as const, target: css(selector) });

/** The reactive login flow: click "Log in", then wait in the popup until the button is gone from every window. */
const loginWall = (recover = false) => ({
  name: 'login-wall',
  trigger: { appears: css('#spa-login') },
  ...(recover ? { recover: true } : {}),
  steps: [click('#spa-login'), { kind: 'await-user' as const, target: css('#spa-login'), until: 'disappears' as const, window: 'popup' as const, label: 'Log in to the portal' }],
});

const products = { name: 'products', item: { selectors: [{ strategy: 'testid' as const, value: 'product-card', stability: 'stable' as const }] }, fields: [{ name: 'title', type: 'text' as const, selectors: [{ strategy: 'css' as const, value: 'h2.product-title', stability: 'medium' as const }], key: true }] };

function spaRecipe(scoop: Scoop, name: string, query: string, extra: Partial<RecipeInput>): RecipeInput {
  return { schemaVersion: 2, name, url: `http://127.0.0.1:${scoop.playground.port}/spa${query}`, vars: [], tables: [products], sequence: [{ extract: 'products' }], ...extra } as RecipeInput;
}

/** Popups already logged in, per browser, so the next call waits for a new one. */
const handled = new WeakMap<Browser, Set<Page>>();

/** Wait for a login popup of the run's browser not handled yet, and log in there, as the user would. */
async function logInPopup(browser: Browser, n: number, timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  const seen = handled.get(browser) ?? new Set<Page>();
  handled.set(browser, seen);
  for (;;) {
    for (const page of browser.contexts().flatMap((c) => c.pages())) {
      if (seen.has(page) || page.isClosed() || !page.url().includes('/spa/login')) continue;
      seen.add(page);
      await page.locator('#spa-user-input').fill('u');
      await page.locator('#spa-password-input').fill('p');
      await page.locator('#spa-sign-in').click();
      return page;
    }
    if (Date.now() > deadline) throw new Error(`no login popup number ${n}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('a reactive login flow waits for the user in the popup, then the menu flow runs and the catalog is extracted', async ({ scoop }) => {
  await scoop.writeRecipe(spaRecipe(scoop, 'spa-login', '', { flows: [{ name: 'open-catalog', steps: [click('#spa-catalog')] }, loginWall()], sequence: [{ flow: 'open-catalog' }, { extract: 'products' }] }));
  const g = await scoop.guardedRun(['spa-login', '--no-notify', '--guard-timeout', '60000']);
  await expect.poll(() => g.run.err(), { timeout: 30_000 }).toMatch(/flow login-wall \(reactive\) on page 1/);
  // The banner shows in the popup that needs the user, not in the main window.
  const deadline = Date.now() + 30_000;
  let popup: Page | undefined;
  while (!popup) {
    popup = g.browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('/spa/login'));
    if (!popup && Date.now() > deadline) throw new Error('the login popup did not open');
    await new Promise((r) => setTimeout(r, 100));
  }
  await expect.poll(() => popup!.evaluate(() => document.querySelectorAll('webscoop-root').length), { timeout: 10_000 }).toBe(1);
  const main = g.browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().endsWith('/spa'))!;
  expect(await main.evaluate(() => document.querySelectorAll('webscoop-root').length)).toBe(0);
  await logInPopup(g.browser, 1);
  const result = await g.run.done;
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).map((r: { title: string }) => r.title)).toEqual(dataset.slice(0, 8).map((p) => p.title));
  expect(result.stderr).toMatch(/flow open-catalog \(called\) on page 1/);
  expect(result.stderr).toMatch(/reactive flows fired 1 time/);
});

test('a session that expires mid-run fires the reactive flow again, which recovers the page state before going on', async ({ scoop }) => {
  test.setTimeout(150_000);
  const report = { name: 'report', fields: [{ name: 'total', type: 'text' as const, selectors: [{ strategy: 'css' as const, value: '#spa-report-total', stability: 'medium' as const }] }] };
  await scoop.writeRecipe(
    spaRecipe(scoop, 'spa-expiry', '?ttl=6', {
      tables: [products, report],
      flows: [
        { name: 'open-catalog', steps: [click('#spa-catalog')] },
        // The wait outlives the session, so the step after it finds the "Log in" button again.
        { name: 'open-report', steps: [{ kind: 'wait', value: '7000' }, click('#spa-report-open')] },
        loginWall(true),
      ],
      sequence: [{ flow: 'open-catalog' }, { extract: 'products' }, { flow: 'open-report' }, { extract: 'report' }],
    }),
  );
  const g = await scoop.guardedRun(['spa-expiry', '--no-notify', '--guard-timeout', '120000']);
  await logInPopup(g.browser, 1);
  await logInPopup(g.browser, 2, 60_000).catch((error: Error) => {
    throw new Error(`${error.message}\n${g.run.err()}`);
  });
  const result = await g.run.done;
  expect(result.code, result.stderr).toBe(0);
  const out = JSON.parse(result.stdout) as Record<string, Record<string, unknown>[]>;
  expect(out.products).toHaveLength(8);
  expect(out.report).toHaveLength(1);
  expect(result.stderr.match(/flow login-wall \(reactive\)/g)).toHaveLength(2);
  // Recovery reloaded the SPA and replayed the catalog flow before the report step.
  expect(result.stderr.match(/flow open-catalog \(called\)/g)).toHaveLength(2);
  expect(result.stderr).toMatch(/reactive flows fired 2 times/);
});

test('a session that expires on page 2 of click pagination fails with pagination-lost, keeping page 1', async ({ scoop }) => {
  test.setTimeout(150_000);
  await scoop.writeRecipe(
    // The session ends during page 2's pause, after page 1 was extracted.
    spaRecipe(scoop, 'spa-paged', '?ttl=7', {
      flows: [{ name: 'open-catalog', steps: [click('#spa-catalog')] }, { name: 'pause', steps: [{ kind: 'wait', value: '3000' }] }, loginWall(true)],
      sequence: [{ flow: 'open-catalog' }, { paginate: { kind: 'next', target: css('#spa-next'), limit: 'all', do: [{ flow: 'pause' }, { extract: 'products' }] } }],
    }),
  );
  const g = await scoop.guardedRun(['spa-paged', '--no-notify', '--guard-timeout', '120000']);
  await logInPopup(g.browser, 1);
  await logInPopup(g.browser, 2, 60_000).catch((error: Error) => {
    throw new Error(`${error.message}\n${g.run.err()}`);
  });
  const result = await g.run.done;
  expect(result.code, result.stderr).toBe(1);
  expect(result.stderr).toMatch(/run failed \(pagination-lost\).*page 2/);
  expect(JSON.parse(result.stdout).map((r: { _page: number }) => r._page)).toEqual(Array(8).fill(1));
});

test('recording: a login popup takes the panel, steps recorded there get window popup, and closing it hands the panel back', async ({ scoop }) => {
  const port = scoop.playground.port;
  const r = await scoop.record([`http://127.0.0.1:${port}/spa`, '--name', 'spa-recorded']);
  await r.browse();
  const [popup] = await Promise.all([r.page.context().waitForEvent('page'), r.click('#spa-login')]);
  await popup.waitForLoadState();
  const popupState = () => popup.evaluate(() => (window as unknown as { __webscoopTest: { state(): HookState } }).__webscoopTest.state());
  // The popup owns the panel; the main window shows the rail.
  await expect.poll(async () => (await popupState().catch(() => null))?.host?.panelMode ?? null, { timeout: 15_000 }).toBe('owner');
  await expect.poll(() => r.state().then((s) => s.ui.panelMode)).toBe('rail');
  await popup.keyboard.press('b');
  await popup.locator('#spa-user-input').click();
  await popup.keyboard.type('u');
  await popup.locator('#spa-password-input').click();
  await popup.keyboard.type('p');
  await expect.poll(async () => (await popupState()).host?.draft.flows[0]?.steps.filter((s) => s.window === 'popup').length ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await popup.locator('#spa-sign-in').click();
  // The popup closed itself: the main window owns the panel again and shows the menu.
  await r.until((s) => s.ui.panelMode === 'owner' && s.host?.draft.flows[0]?.steps.length);
  await r.key('b');
  await r.key('Control+s');
  const saved = await r.until((s) => (s.host?.saved && !s.host.draft.dirty ? s.host.saved : undefined));
  expect((await r.closeWindow()).code).toBe(0);
  const recipe = loadRecipe(await readFile(saved.path!, 'utf8'));
  const steps = recipe.flows[0]!.steps;
  expect(steps[0]).toMatchObject({ kind: 'click', window: 'same' });
  expect(steps.filter((s) => s.kind === 'fill').every((s) => s.window === 'popup')).toBe(true);
  expect(steps.some((s) => s.kind === 'fill' && s.window === 'popup')).toBe(true);
});
