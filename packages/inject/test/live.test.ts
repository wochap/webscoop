import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PlaywrightBrowser } from '@webscoop/browser';
import { emptyDraft, RecorderController, type InteractiveSession, type RecorderState } from '@webscoop/core';
import { startPlayground, type Playground } from '@webscoop/playground';
import { build } from 'esbuild';
import type { Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../core/test/recorder-helpers';
import { bundleOptions } from '../bundle.config.mjs';

const hasDisplay = Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);
const SHOTS = resolve(import.meta.dirname, '../../../test-results/inject');

interface Hook {
  state(): { host: RecorderState | null; ui: { picking: boolean }; mode: string };
  query(selector: string): { text: string; value: string; rect: { x: number; y: number; w: number; h: number }; fontFamily: string; backgroundColor: string } | null;
  submit(selector: string, value: string): void;
  tag(): string;
  boxes(): { variant: string; light: boolean; rect: { x: number; y: number; w: number; h: number } }[];
  fontsReady(): Promise<number>;
  click(selector: string): void;
}

describe.skipIf(!hasDisplay)('injected recorder (live browser)', () => {
  let playground: Playground;
  let bundle: string;
  const dirs: string[] = [];
  let session: InteractiveSession | undefined;

  beforeAll(async () => {
    playground = await startPlayground({ port: 0 });
    const out = await build({ ...bundleOptions({ e2e: true, outfile: 'recorder.e2e.js' }), write: false });
    bundle = out.outputFiles[0]!.text;
    await mkdir(SHOTS, { recursive: true });
  });
  afterEach(async () => {
    await session?.close().catch(() => {});
    session = undefined;
  });
  afterAll(async () => {
    await playground?.stop();
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  async function open(query: string): Promise<{ page: Page; controller: RecorderController }> {
    const dir = await mkdtemp(join(tmpdir(), 'webscoop-inject-'));
    dirs.push(dir);
    session = await new PlaywrightBrowser({ executablePath: process.env.WEBSCOOP_CHROMIUM || undefined }).open(dir, { bypassCSP: true });
    const controller = new RecorderController({
      session,
      storage: new MemoryStorage(),
      bundle,
      draft: emptyDraft({ name: 'shop', url: `${playground.url}/catalog?${query}`, vars: [] }),
    });
    await controller.start();
    const page = (session as unknown as { page: Page }).page;
    await page.waitForFunction(() => (window as unknown as { __webscoopTest?: { state(): { host: unknown } } }).__webscoopTest?.state().host != null);
    return { page, controller };
  }

  const hook = <T>(page: Page, fn: (h: Hook) => T | Promise<T>) =>
    page.evaluate(`(${fn.toString()})(window.__webscoopTest)`) as Promise<T>;

  it('shows the panel above the hostile header and cookie modal, with its own font', async () => {
    const { page } = await open('tier=0&chrome=hostile');
    const width = await page.evaluate(() => document.documentElement.clientWidth);
    const panel = await hook(page, (h) => h.query('[data-ws="body"]'));
    expect(panel!.rect.x).toBe(width - 400);
    // Topmost element at a point inside the panel, level with the fixed header and over the modal backdrop.
    const top = await page.evaluate(([x]) => [document.elementFromPoint(x!, 30)?.tagName, document.elementFromPoint(x!, 400)?.tagName], [width - 200]);
    expect(top).toEqual(['WEBSCOOP-ROOT', 'WEBSCOOP-ROOT']);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).marginRight)).toBe('400px');
    const cardRight = await page.evaluate(() => Math.max(...Array.from(document.querySelectorAll('article')).map((a) => a.getBoundingClientRect().right)));
    expect(cardRight).toBeLessThanOrEqual(width - 400);
    expect(await hook(page, (h) => h.fontsReady())).toBeGreaterThanOrEqual(2);
    const title = await hook(page, (h) => h.query('.ws-logo'));
    expect(title!.fontFamily).toContain('Webscoop Inter');
    expect(title!.fontFamily).not.toContain('Georgia');
    const root = await hook(page, (h) => h.query('[data-ws="save"]'));
    expect(root!.backgroundColor).toBe('rgb(145, 132, 217)');
    await page.screenshot({ path: join(SHOTS, 'hostile-panel.png') });
  });

  it('swaps the halo on light and dark hosts', async () => {
    const { page } = await open('tier=0');
    await page.keyboard.press('p');
    const box = (await page.locator('h2.product-title').first().boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await expect.poll(() => hook(page, (h) => h.boxes().filter((b) => b.variant === 'hover'))).toHaveLength(1);
    expect((await hook(page, (h) => h.boxes()))[0]!.light).toBe(true);
    await page.screenshot({ path: join(SHOTS, 'halo-light.png') });

    await page.addStyleTag({ content: 'body, .product-card { background: #10121c !important; color: #eee !important; }' });
    await page.mouse.move(box.x + 12, box.y + box.height / 2 + 30);
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await expect.poll(async () => (await hook(page, (h) => h.boxes())).find((b) => b.variant === 'hover')?.light).toBe(false);
    await page.screenshot({ path: join(SHOTS, 'halo-dark.png') });
    await page.keyboard.press('Escape');
    expect(await hook(page, (h) => h.state().ui.picking)).toBe(false);
  });

  it('picks a link inside a card without navigating or firing host handlers', async () => {
    const { page } = await open('tier=0&chrome=hostile');
    await page.click('#cookie-accept');
    await page.evaluate(() => ((window as unknown as { __hostClicks: unknown[] }).__hostClicks = []));
    const before = page.url();
    await page.keyboard.press('p');
    expect(await hook(page, (h) => h.state().mode)).toBe('picking');
    await page.locator('a.product-link').nth(2).scrollIntoViewIfNeeded();
    const link = (await page.locator('a.product-link').nth(2).boundingBox())!;
    await page.mouse.move(link.x + 5, link.y + link.height / 2);
    await page.mouse.click(link.x + 5, link.y + link.height / 2);
    await expect.poll(() => hook(page, (h) => h.state().host?.selected?.selection.tag)).toBe('a');
    expect(page.url()).toBe(before);
    expect(await page.evaluate(() => (window as unknown as { __hostClicks: unknown[] }).__hostClicks)).toEqual([]);
    const selected = await hook(page, (h) => h.state().host!.selected!);
    expect(selected.selection.attrs.href).toBe('/p/p03');
    expect(selected.selection.candidates.find((c) => c.strategy === 'css')?.count).toBe(24);
  });

  it('Alt+click selects through the cookie modal backdrop', async () => {
    const { page } = await open('tier=0&chrome=hostile');
    await page.keyboard.press('p');
    await page.locator('h2.product-title').nth(1).scrollIntoViewIfNeeded();
    const title = (await page.locator('h2.product-title').nth(1).boundingBox())!;
    const x = title.x + 8;
    const y = title.y + title.height / 2;
    expect(await page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.closest('#cookie-backdrop') != null, [x, y])).toBe(true);
    await page.keyboard.down('Alt');
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    await page.keyboard.up('Alt');
    await expect.poll(() => hook(page, (h) => h.state().host?.selected?.selection.tag)).toBe('h2');
    const state = await hook(page, (h) => h.state().host!);
    expect(state.selected!.selection.text).toBe('Mechanical Keyboard');
    expect(state.proposal!.proposed.count).toBe(24);
    expect(await page.evaluate(() => (window as unknown as { __hostClicks: unknown[] }).__hostClicks)).toEqual([]);
    expect(await page.locator('#cookie-backdrop').count()).toBe(1);
  });

  async function pickTitle(page: Page, nth: number) {
    await page.keyboard.press('p');
    await page.locator('h2.product-title').nth(nth).scrollIntoViewIfNeeded();
    const title = (await page.locator('h2.product-title').nth(nth).boundingBox())!;
    await page.mouse.move(title.x + 8, title.y + title.height / 2);
    await page.mouse.click(title.x + 8, title.y + title.height / 2);
    await expect.poll(() => hook(page, (h) => h.state().host?.proposal?.proposed.count ?? null)).toBe(24);
  }

  it('prefills the list parent and item fields and recounts after an edit', async () => {
    const { page } = await open('tier=0');
    await pickTitle(page, 1);
    expect(await hook(page, (h) => h.query('[data-ws="level-input-within"]')!.value)).toBe('role=list');
    expect(await hook(page, (h) => h.query('[data-ws="level-input-item"]')!.value)).toBe('role=article');
    expect(await hook(page, (h) => h.query('[data-ws="items-count"]')!.text)).toBe('24');
    expect((await hook(page, (h) => h.boxes())).filter((b) => b.variant === 'list')).toHaveLength(1);

    await hook(page, (h) => h.submit('[data-ws="level-input-item"]', 'css=li.product-item:nth-child(-n+5)'));
    await expect.poll(() => hook(page, (h) => h.query('[data-ws="items-count"]')!.text)).toBe('5');
    expect(await hook(page, (h) => h.query('[data-ws="level-input-item"]')!.value)).toBe('css=li.product-item:nth-child(-n+5)');
    await expect.poll(async () => (await hook(page, (h) => h.boxes())).filter((b) => b.variant === 'sibling').length).toBe(5);

    await hook(page, (h) => h.submit('[data-ws="level-input-item"]', '.no-such-card'));
    await expect.poll(() => hook(page, (h) => h.query('[data-ws="level-error-item"]')?.text ?? null)).toContain('matches nothing');
    expect(await hook(page, (h) => h.query('[data-ws="items-count"]')!.text)).toBe('5');
    await page.screenshot({ path: join(SHOTS, 'list-fields.png') });
  });

  it('picks the list parent only among ancestors of the item and says why others are refused', async () => {
    const { page } = await open('tier=0');
    await pickTitle(page, 1);
    await hook(page, (h) => h.click('[data-ws="level-pick-within"]'));
    await expect.poll(() => hook(page, (h) => h.state().ui.picking)).toBe(true);
    expect(await hook(page, (h) => h.state().host!.levelPick?.level)).toBe('within');

    const heading = (await page.locator('h1').boundingBox())!;
    await page.mouse.move(heading.x + 5, heading.y + heading.height / 2);
    await expect.poll(() => hook(page, (h) => h.tag())).toContain('outside the list');
    expect((await hook(page, (h) => h.boxes())).some((b) => b.variant === 'blocked')).toBe(true);
    await page.mouse.click(heading.x + 5, heading.y + heading.height / 2);
    expect(await hook(page, (h) => h.state().ui.picking)).toBe(true);
    expect(await hook(page, (h) => h.state().host!.proposal!.within!.tag)).toBe('ul');

    // The gap between cards belongs to the list itself, an ancestor of every card.
    const [a, b] = [(await page.locator('li.product-item').nth(0).boundingBox())!, (await page.locator('li.product-item').nth(1).boundingBox())!];
    const gap = { x: (a.x + a.width + b.x) / 2, y: a.y + a.height / 2 };
    await page.mouse.move(gap.x, gap.y);
    await expect.poll(() => hook(page, (h) => h.tag())).not.toContain('outside the list');
    await page.mouse.click(gap.x, gap.y);
    await expect.poll(() => hook(page, (h) => h.state().host!.levelPick)).toBeNull();
    expect(await hook(page, (h) => h.state().ui.picking)).toBe(false);
    expect(await hook(page, (h) => h.state().host!.proposal!.within!.tag)).toBe('ul');
    expect(await hook(page, (h) => h.state().host!.proposal!.proposed.count)).toBe(24);
  });

  it('removes itself on detach, gives the page its clicks and margin back, and attaches again', async () => {
    const { page, controller } = await open('tier=0&chrome=hostile');
    await page.click('#cookie-accept');
    await page.keyboard.press('p');
    expect(await hook(page, (h) => h.state().ui.picking)).toBe(true);
    await controller.detach();
    await expect.poll(() => page.evaluate(() => document.querySelector('webscoop-root, webscoop-overlay, webscoop-drawer'))).toBeNull();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).marginRight)).toBe('0px');
    expect(await page.evaluate(() => '__webscoopPage' in window || '__webscoopTest' in window)).toBe(false);

    await page.evaluate(() => ((window as unknown as { __hostClicks: unknown[] }).__hostClicks = []));
    await page.locator('h2.product-title').nth(1).click();
    expect(await page.evaluate(() => (window as unknown as { __hostClicks: { tag: string }[] }).__hostClicks.map((c) => c.tag))).toEqual(['h2']);
    await page.keyboard.press('p');
    await page.locator('h2.product-title').nth(2).click();
    expect(await page.evaluate(() => (window as unknown as { __hostClicks: unknown[] }).__hostClicks)).toHaveLength(2);

    const again = new RecorderController({
      session: session!,
      storage: new MemoryStorage(),
      bundle,
      draft: emptyDraft({ name: 'shop', url: `${playground.url}/catalog?tier=0`, vars: [] }),
    });
    await again.attach();
    await page.waitForFunction(() => (window as unknown as { __webscoopTest?: { state(): { host: unknown } } }).__webscoopTest?.state().host != null);
    expect(await page.evaluate(() => document.querySelectorAll('webscoop-root').length)).toBe(1);
    await again.detach();
    await expect.poll(() => page.evaluate(() => document.querySelectorAll('webscoop-root').length)).toBe(0);
  });

  it('records a click in browse mode while the click still does what it does', async () => {
    const { page, controller } = await open('tier=0&gate=cookie');
    expect(await page.locator('article').count()).toBe(0);
    await page.keyboard.press('b');
    expect(await hook(page, (h) => h.state().mode)).toBe('browsing');
    await page.click('#consent-accept');
    await expect.poll(() => page.locator('article').count()).toBe(24);
    await controller.idle();
    await expect.poll(() => controller.draft.steps.length).toBe(1);
    const [step] = controller.draft.steps;
    expect(step!.kind).toBe('click');
    expect(step!.target!.fingerprint!.textSample).toBe('Accept all');
    // Panel clicks are not steps.
    await hook(page, (h) => h.click('[data-ws="browse-stop"]'));
    expect(await hook(page, (h) => h.state().ui.picking)).toBe(false);
    expect(controller.draft.steps).toHaveLength(1);
  });

  it('records typing and Enter as two steps and keeps the panel on the results page', async () => {
    const { page, controller } = await open('tier=0&gate=search');
    await page.keyboard.press('b');
    await page.click('input[name="q"]');
    await page.keyboard.type('mouse');
    await page.keyboard.press('Enter');
    await page.waitForURL(/q=mouse/);
    await page.waitForFunction(() => (window as unknown as { __webscoopTest?: { state(): { host: unknown } } }).__webscoopTest?.state().host != null);
    await controller.idle();
    expect(controller.draft.steps.map((s) => [s.kind, s.value])).toEqual([
      ['type', 'mouse'],
      ['press', 'Enter'],
    ]);
    expect(await hook(page, (h) => h.query('[data-ws="steps"]'))).not.toBeNull();
  });
});
