import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InteractiveSession } from '@webscoop/core';
import { startPlayground, type Playground } from '@webscoop/playground';
import { chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightBrowser } from '../src';

const hasDisplay = Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

describe.skipIf(!hasDisplay)('PlaywrightSession as InteractiveSession (integration)', () => {
  let playground: Playground;
  const dirs: string[] = [];
  const sessions: InteractiveSession[] = [];
  const browser = new PlaywrightBrowser({ executablePath: process.env.WEBSCOOP_CHROMIUM || undefined });

  async function open(opts: Parameters<PlaywrightBrowser['open']>[1] = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'webscoop-interactive-'));
    dirs.push(dir);
    const session = await browser.open(dir, opts);
    sessions.push(session);
    return session;
  }

  beforeAll(async () => {
    playground = await startPlayground({ port: 0 });
  });
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((s) => s.close().catch(() => {})));
  });
  afterAll(async () => {
    await playground?.stop();
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it('injects into every page, receives binding calls, dispatches, and observes navigation', async () => {
    const session = await open({ bypassCSP: true });
    const received: unknown[] = [];
    await session.expose('__webscoopHost', async (msg) => {
      received.push(msg);
      return { kind: 'ack', n: received.length };
    });
    await session.inject(`
      window.__webscoopPage = { dispatch(m) { document.documentElement.dataset.got = JSON.stringify(m); } };
      if (location.protocol.startsWith('http')) {
        const send = () => window.__webscoopHost({ kind: 'session.ready', url: location.href }).then((r) => { document.documentElement.dataset.reply = JSON.stringify(r); });
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', send); else send();
      }
    `);
    const navigations: string[] = [];
    session.onNavigated((url) => navigations.push(url));
    const catalog = `${playground.url}/catalog?tier=0`;
    await session.goto(catalog, { timeoutMs: 10_000 });
    await expect.poll(() => received.length).toBe(1);
    expect(received[0]).toEqual({ kind: 'session.ready', url: catalog });

    await session.dispatch({ kind: 'draft.state', n: 1 });
    const page = (session as unknown as { page: import('playwright').Page }).page;
    expect(await page.evaluate(() => document.documentElement.dataset.got)).toBe('{"kind":"draft.state","n":1}');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.reply)).toBe('{"kind":"ack","n":1}');

    await page.click('a.product-link');
    await expect.poll(() => received.length).toBe(2);
    expect(navigations).toEqual([catalog, `${playground.url}/p/p01`]);

    const [card] = await session.resolve({ strategy: 'testid', value: 'product-card', stability: 'stable' });
    await page.goBack();
    const [card2] = await session.resolve({ strategy: 'testid', value: 'product-card', stability: 'stable' });
    const box = await session.geometry(card2 ?? card!);
    expect(box.w).toBeGreaterThan(100);
    expect(box.h).toBeGreaterThan(100);
  });

  it('opens a DevTools port that connectOverCDP attaches to, and reports closing', async () => {
    const port = await freePort();
    const session = await open({ remoteDebuggingPort: port });
    await session.goto(`${playground.url}/catalog?tier=0`, { timeoutMs: 10_000 });
    const remote = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    try {
      const pages = remote.contexts().flatMap((c) => c.pages());
      expect(pages.map((p) => p.url())).toContain(`${playground.url}/catalog?tier=0`);
    } finally {
      await remote.close();
    }
    let closed = 0;
    session.onClosed(() => closed++);
    await session.close();
    expect(closed).toBe(1);
  });

  it('reports document title and evaluates strings and JSON objects', async () => {
    const session = await open();
    await session.goto(`${playground.url}/catalog?tier=0`, { timeoutMs: 10_000 });
    const title = await session.title();
    expect(typeof title).toBe('string');
    expect(title.length).toBeGreaterThan(0);

    const stringVal = await session.evaluate('"hello world"');
    expect(stringVal).toBe('hello world');

    const jsonVal = await session.evaluate('({ a: 1, b: "two", nested: { list: [1, 2, 3] } })');
    expect(jsonVal).toEqual({ a: 1, b: 'two', nested: { list: [1, 2, 3] } });
  });

  it('detects element occlusion and throws descriptive error (Task 2.5)', async () => {
    const session = await open();
    await session.goto(`${playground.url}/catalog?tier=0`, { timeoutMs: 10_000 });
    // Inject a button and an overlay modal covering it
    await session.evaluate(`
      const btn = document.createElement('button');
      btn.id = 'hidden-target';
      btn.textContent = 'Click Target';
      btn.style.cssText = 'position: fixed; top: 100px; left: 100px; width: 100px; height: 50px; z-index: 10;';
      document.body.appendChild(btn);

      const overlay = document.createElement('div');
      overlay.id = 'cookie-banner';
      overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000;';
      document.body.appendChild(overlay);
    `);

    const refs = await session.resolve({ strategy: 'css', value: '#hidden-target', stability: 'stable' });
    expect(refs.length).toBeGreaterThan(0);
    const targetRef = refs[0]!;

    await expect(session.click(targetRef)).rejects.toThrow(/covered by <div#cookie-banner>/);
  });

  it('aborts and unroutes network requests (Task 2.6)', async () => {
    const session = await open();
    await session.goto(`${playground.url}/catalog?tier=0`, { timeoutMs: 10_000 });

    if (session.route) {
      await session.route('**/*blocked-endpoint*', 'abort');

      const failed = await session.evaluate(`
        fetch('/blocked-endpoint').then(() => false).catch(() => true);
      `);
      expect(failed).toBe(true);

      if (session.unroute) {
        await session.unroute('**/*blocked-endpoint*');
      }
    }
  });
});
