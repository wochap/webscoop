import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SelectorCandidate } from '@webscoop/core';
import { dataset, startPlayground, type Playground } from '@webscoop/playground';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SharedBrowser } from '../src';

const hasDisplay = Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);

const id = (value: string): SelectorCandidate => ({ strategy: 'id', value, stability: 'stable' });

type Page = import('playwright').Page;
const pageOf = (session: unknown) => (session as { page: Page }).page;

describe.skipIf(!hasDisplay)('SharedBrowser (integration)', () => {
  let playground: Playground;
  let profileDir: string;
  let browser: SharedBrowser;

  beforeAll(async () => {
    playground = await startPlayground({ port: 0 });
    profileDir = await mkdtemp(join(tmpdir(), 'webscoop-shared-'));
    browser = await SharedBrowser.launch({ executablePath: process.env.WEBSCOOP_CHROMIUM || undefined }, profileDir);
  });

  afterAll(async () => {
    await browser?.close();
    await playground?.stop();
    if (profileDir) await rm(profileDir, { recursive: true, force: true });
  });

  it('runs two sessions at once in their own tabs, and closing one leaves the other', async () => {
    const before = browser.pageCount;
    const [a, b] = await Promise.all([browser.newSession(), browser.newSession()]);
    expect(browser.pageCount).toBe(before + 2);
    const [infoA, infoB] = await Promise.all([
      a.goto(`${playground.url}/catalog?tier=0&delayMs=500`, { timeoutMs: 10_000 }),
      b.goto(`${playground.url}/catalog?tier=0&page=2&delayMs=500`, { timeoutMs: 10_000 }),
    ]);
    expect(infoA.status).toBe(200);
    expect(infoB.status).toBe(200);
    await a.close();
    expect(browser.pageCount).toBe(before + 1);
    expect(browser.isClosed).toBe(false);
    const again = await b.goto(`${playground.url}/catalog?tier=0`, { timeoutMs: 10_000 });
    expect(again.status).toBe(200);
    expect(await b.pageText()).toContain(dataset[0]!.title);
    await b.close();
    expect(browser.pageCount).toBe(before);
  });

  it('closes the popups a session opened, and only those', async () => {
    const a = await browser.newSession();
    const b = await browser.newSession();
    const before = browser.pageCount;
    await a.goto(`${playground.url}/catalog?tier=0`, { timeoutMs: 10_000 });
    const popup = pageOf(a).waitForEvent('popup');
    await pageOf(a).evaluate((url) => void window.open(url), `${playground.url}/catalog?tier=0`);
    await popup;
    expect(browser.pageCount).toBe(before + 1);
    await a.close();
    expect(browser.pageCount).toBe(before - 1);
    await b.close();
  });

  it('keeps the browser open on its placeholder page between sessions', async () => {
    const session = await browser.newSession();
    await session.close();
    expect(browser.pageCount).toBeGreaterThanOrEqual(1);
    expect(browser.isClosed).toBe(false);
  });

  it('bypasses CSP on one tab only, without a context-wide bypass', async () => {
    const strict = `${playground.url}/csp`;
    const open = await browser.newSession({ bypassCSP: true });
    const plain = await browser.newSession();
    try {
      await open.goto(strict, { timeoutMs: 10_000 });
      await plain.goto(strict, { timeoutMs: 10_000 });
      const source = 'document.documentElement.dataset.injected = "yes"';
      await open.inject(source);
      await plain.inject(source);
      expect(await pageOf(open).evaluate(() => document.documentElement.dataset.injected)).toBe('yes');
      // An inline script element is what the recorder bundle becomes; CSP blocks it on the plain tab.
      const inline = (page: Page) =>
        page.evaluate(() => {
          const script = document.createElement('script');
          script.textContent = 'document.documentElement.dataset.inline = "ran"';
          document.head.append(script);
          return document.documentElement.dataset.inline ?? null;
        });
      expect(await inline(pageOf(open))).toBe('ran');
      expect(await inline(pageOf(plain))).toBeNull();
      expect(await open.resolve(id('strict'))).toHaveLength(1);
    } finally {
      await open.close();
      await plain.close();
    }
  });
});
