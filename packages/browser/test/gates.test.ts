import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@webscoop/core';
import { startPlayground, type Playground } from '@webscoop/playground';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightBrowser } from '../src';

const hasDisplay = Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);

describe.skipIf(!hasDisplay)('playground gates in a browser', () => {
  let playground: Playground;
  let profileDir: string;
  let session: Session;
  let page: Page;

  beforeAll(async () => {
    playground = await startPlayground({ port: 0 });
    profileDir = await mkdtemp(join(tmpdir(), 'webscoop-gates-'));
    const browser = new PlaywrightBrowser({ executablePath: process.env.WEBSCOOP_CHROMIUM || undefined });
    session = await browser.open(profileDir);
    page = (session as unknown as { page: Page }).page;
  });

  afterAll(async () => {
    await session?.close();
    await playground?.stop();
    if (profileDir) await rm(profileDir, { recursive: true, force: true });
  });

  const products = () => page.locator('[data-product-id]').count();
  const open = (query: string) => session.goto(`${playground.url}/catalog?${query}`, { timeoutMs: 10_000 });

  it('shows the cookie-gated list only after Accept all, then remembers consent', async () => {
    await open('gate=cookie&tier=0');
    await page.evaluate(() => localStorage.removeItem('ws_consent'));
    await open('gate=cookie&tier=0');
    expect(await products()).toBe(0);
    // The backdrop takes the click meant for anything under it.
    expect(await page.evaluate(() => document.elementFromPoint(5, 5)?.getAttribute('class'))).toBe('consent-backdrop');
    await page.click('#consent-accept');
    expect(await products()).toBe(24);
    expect(await page.locator('[role="dialog"]').count()).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('ws_consent'))).toBe('1');
    await open('gate=cookie&tier=0');
    expect(await page.locator('[role="dialog"]').count()).toBe(0);
    expect(await products()).toBe(24);
    await page.evaluate(() => localStorage.removeItem('ws_consent'));
  });

  it('submits the search form on Enter with the query', async () => {
    await open('gate=search&tier=0');
    expect(await products()).toBe(0);
    await page.fill('input[name="q"]', 'mouse');
    await Promise.all([page.waitForURL(/q=mouse/), page.press('input[name="q"]', 'Enter')]);
    expect(new URL(page.url()).searchParams.get('gate')).toBe('search');
    expect(await page.locator('h2').allTextContents()).toEqual(['Wireless Mouse']);
    expect(await page.inputValue('input[name="q"]')).toBe('mouse');
  });

  it('needs the Products tab click on every page', async () => {
    for (const pageNo of [1, 2]) {
      await open(`gate=tabs&tier=0&paginate=url&page=${pageNo}`);
      expect(await products()).toBe(0);
      expect(await page.getByRole('tab', { name: 'About' }).getAttribute('aria-selected')).toBe('true');
      await page.getByRole('tab', { name: 'Products' }).click();
      expect(await products()).toBe(8);
      expect(await page.getByRole('tab', { name: 'Products' }).getAttribute('aria-selected')).toBe('true');
      expect(await page.getByRole('tabpanel', { name: 'About' }).isHidden()).toBe(true);
    }
    expect(await page.locator('[data-product-id]').first().getAttribute('data-product-id')).toBe('p09');
  });
});
