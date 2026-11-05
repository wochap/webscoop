import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InteractiveSession } from '@webscoop/core';
import { startPlayground, type Playground } from '@webscoop/playground';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { clickRipple, dragTrail, flashElement, injectVisualFeedback, PlaywrightBrowser } from '../src';

const hasDisplay = Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);

describe.skipIf(!hasDisplay)('Visual feedback injection (integration)', () => {
  let playground: Playground;
  const dirs: string[] = [];
  const sessions: InteractiveSession[] = [];
  const browser = new PlaywrightBrowser({ executablePath: process.env.WEBSCOOP_CHROMIUM || undefined });

  async function open() {
    const dir = await mkdtemp(join(tmpdir(), 'webscoop-visual-'));
    dirs.push(dir);
    const session = await browser.open(dir, { bypassCSP: true });
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

  it('injects visual feedback and executes flash, ripple, and trail on a page', async () => {
    const session = await open();
    await session.goto(`${playground.url}/catalog?tier=0`, { timeoutMs: 10_000 });

    await injectVisualFeedback(session);

    // Verify window.__webscoopVisuals exists
    const hasVisuals = await session.evaluate('Boolean(window.__webscoopVisuals)');
    expect(hasVisuals).toBe(true);

    // Test element flash
    const [heading] = await session.resolve({ strategy: 'css', value: 'h1', stability: 'stable' });
    expect(heading).toBeDefined();

    const startFlash = Date.now();
    await flashElement(session, heading!, 'test label');
    const elapsed = Date.now() - startFlash;
    expect(elapsed).toBeGreaterThanOrEqual(200);

    // Test click ripple
    await clickRipple(session, 150, 150);

    // Test drag trail
    await dragTrail(session, { x: 10, y: 10 }, { x: 100, y: 100 });
  });
});
