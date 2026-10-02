import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { dataset, SPA_COOKIE, spaLoggedIn, spaSession, startPlayground, type Playground } from '../src';

const hasDisplay = Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);

const running: Playground[] = [];
async function start() {
  const pg = await startPlayground({ port: 0 });
  running.push(pg);
  return pg;
}
afterEach(async () => {
  await Promise.all(running.splice(0).map((pg) => pg.stop()));
});

const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ');

describe('spa session', () => {
  it('holds a session forever without ttl and until its expiry with one', () => {
    expect(spaLoggedIn(undefined)).toBe(false);
    expect(spaLoggedIn(spaSession(null))).toBe(true);
    expect(spaLoggedIn(spaSession(5, 1000), 5999)).toBe(true);
    expect(spaLoggedIn(spaSession(5, 1000), 6000)).toBe(false);
  });

  it('logs in with any non-empty user and password, and reports the session', async () => {
    const pg = await start();
    const form = (user: string, password: string) => fetch(`${pg.url}/spa/login?ttl=1`, { method: 'POST', body: new URLSearchParams({ user, password }) });
    expect((await form('', 'p')).status).toBe(400);
    const ok = await form('u', 'p');
    expect(ok.status).toBe(204);
    const cookie = cookieOf(ok);
    expect(cookie.startsWith(`${SPA_COOKIE}=`)).toBe(true);
    const session = async () => (await (await fetch(`${pg.url}/spa/session`, { headers: { cookie } })).json()) as { loggedIn: boolean };
    expect(await session()).toEqual({ loggedIn: true });
    await new Promise((r) => setTimeout(r, 1100));
    expect(await session()).toEqual({ loggedIn: false });
  });

  it('serves the login popup with user and password inputs and a Sign in button', async () => {
    const pg = await start();
    const html = await (await fetch(`${pg.url}/spa/login?ttl=5`)).text();
    expect(html).toContain('name="user"');
    expect(html).toContain('type="password"');
    expect(html).toContain('Sign in');
    expect(html).toContain('action="/spa/login?ttl=5"');
  });
});

describe.skipIf(!hasDisplay)('spa in a browser (integration)', () => {
  async function withPage(work: (page: Page, pg: Playground) => Promise<void>) {
    const pg = await start();
    const dir = await mkdtemp(join(tmpdir(), 'webscoop-spa-'));
    const context = await chromium.launchPersistentContext(dir, { headless: false, executablePath: process.env.WEBSCOOP_CHROMIUM || undefined });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await work(page, pg);
    } finally {
      await context.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  const logIn = async (page: Page) => {
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#spa-login')]);
    await popup.waitForLoadState();
    expect(popup.viewportSize()?.width).toBeLessThanOrEqual(520);
    await popup.fill('#spa-user-input', 'u');
    await popup.fill('#spa-password-input', 'p');
    await Promise.all([popup.waitForEvent('close'), popup.click('#spa-sign-in')]);
  };

  it('logs in through the popup and shows the menu within a second, at the same URL', async () => {
    await withPage(async (page, pg) => {
      await page.goto(`${pg.url}/spa`);
      expect(await page.locator('#spa-catalog').count()).toBe(0);
      await logIn(page);
      await page.locator('#spa-catalog').waitFor({ timeout: 1000 });
      expect(page.url()).toBe(`${pg.url}/spa`);
      // A reload keeps the session and opens no section.
      await page.reload();
      expect(await page.locator('#spa-pick').count()).toBe(1);
    });
  }, 30_000);

  it('pages the catalog with Next without changing the URL, and disables Next on the last page', async () => {
    await withPage(async (page, pg) => {
      await page.goto(`${pg.url}/spa`);
      await logIn(page);
      await page.click('#spa-catalog');
      expect(await page.locator('[data-testid="product-card"]').count()).toBe(8);
      await page.click('#spa-next');
      await page.click('#spa-next');
      expect(await page.locator('#spa-page').textContent()).toBe(`Page 3 of ${Math.ceil(dataset.length / 8)}`);
      expect(page.url()).toBe(`${pg.url}/spa`);
      expect(await page.locator('#spa-next').isDisabled()).toBe(true);
      await page.click('#spa-report-open');
      expect(await page.locator('#spa-report-heading').textContent()).toBe('Monthly report');
    });
  }, 30_000);

  it('shows the Log in button again once the session expires', async () => {
    await withPage(async (page, pg) => {
      await page.goto(`${pg.url}/spa?ttl=2`);
      await logIn(page);
      await page.click('#spa-catalog');
      await page.locator('#spa-login').waitFor({ timeout: 4000 });
      expect(await page.locator('[data-testid="product-card"]').count()).toBe(0);
      expect(page.url()).toBe(`${pg.url}/spa?ttl=2`);
    });
  }, 30_000);
});
