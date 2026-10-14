import { readFile } from 'node:fs/promises';
import { loadRecipe } from '@webscoop/core';
import { expect, hasDisplay, test } from './fixtures';
import type { HookState } from './recorder-fixture';
import { ws } from './sidebar';

test.skip(!hasDisplay, 'the recorder needs WAYLAND_DISPLAY or DISPLAY');

const video = (port: number, extra = '') => `http://127.0.0.1:${port}/video?id={id}${extra}`;

test('pick the playlist from the network picker, add it as a capture, test run it, and save it', async ({ scoop }) => {
  const port = scoop.playground.port;
  const r = await scoop.record([video(port), '--var', 'id=42', '--name', 'lesson-video']);
  await r.until((s) => s.host);
  // Empty, the Captures section is collapsed after the table content.
  expect((await r.query(ws('section-captures')))!.attrs['data-collapsed']).toBe('true');
  await r.clickPanel(ws('captures-pick'));
  // The player iframe's playlist arrives live and is listed first, with a teal badge naming the iframe's host.
  await expect.poll(() => r.query(ws('network-row')).then((row) => row?.attrs['data-url'] ?? null), { timeout: 15_000 }).toBe(`http://localhost:${port}/stream/42/playlist.m3u8`);
  expect((await r.query(`${ws('network-row')} ${ws('network-stream')}`))!.text).toBe('stream');
  expect((await r.query(`${ws('network-row')} ${ws('network-frame')}`))!.text).toBe(`localhost:${port}`);
  expect((await r.query(ws('network-group-label')))!.text).toBe('/video0.ts … video3.ts');

  await r.clickPanel(ws('network-row'));
  expect((await r.query(ws('capture-chip', '[data-kind="filename"]')))!.attrs['aria-pressed']).toBe('true');
  expect((await r.query(ws('capture-pattern')))!.value).toBe('/playlist\\.m3u8(\\?|$)');
  await r.clickPanel(ws('capture-add'));
  await r.until((s) => s.host?.draft.captures.length === 1);
  await expect.poll(() => r.query(ws('capture-badge')).then((b) => b?.text)).toBe('1 match');
  expect((await r.query(ws('footer-count')))!.text).toBe('0 tables · 1 capture');
  expect((await r.query(ws('sequence-summary')))?.text ?? (await r.query(ws('sequence-capture-wait')))!.text).toContain('wait for captures');

  await r.clickPanel(ws('footer-test'));
  const tested = await r.until((s: HookState) => s.host?.test?.captures[0]);
  expect(tested).toMatchObject({ name: 'videos', rowCount: 1, status: 'ok' });

  await r.key('Control+s');
  const saved = await r.until((s) => (s.host?.saved && !s.host.draft.dirty ? s.host.saved : undefined));
  expect((await r.closeWindow()).code).toBe(0);
  const recipe = loadRecipe(await readFile(saved.path!, 'utf8'));
  expect(recipe.captures).toEqual([{ name: 'videos', match: '/playlist\\.m3u8(\\?|$)', count: 1, optional: false }]);
  expect(recipe.tables).toBeUndefined();
  expect(recipe.fields).toBeUndefined();
});

test('a popup that fetches media: its compact network sheet hands the pick to the editor in the main window', async ({ scoop }) => {
  const port = scoop.playground.port;
  const r = await scoop.record([video(port, '&popup=1'), '--var', 'id=42', '--name', 'popup-video']);
  await r.until((s) => s.host);
  const [popup] = await Promise.all([r.page.context().waitForEvent('page'), r.click('#open-player')]);
  await popup.waitForLoadState();
  type Hook = { state(): HookState; click(selector: string, index: number): void; query(selector: string, index: number): { text: string } | null };
  const popupState = () => popup.evaluate(() => (window as unknown as { __webscoopTest: Hook }).__webscoopTest.state());
  const popupClick = (selector: string) => popup.evaluate((sel) => (window as unknown as { __webscoopTest: Hook }).__webscoopTest.click(sel, 0), selector);
  const popupText = (selector: string) => popup.evaluate((sel) => (window as unknown as { __webscoopTest: Hook }).__webscoopTest.query(sel, 0)?.text ?? null, selector);
  await expect.poll(async () => (await popupState().catch(() => null))?.host?.panelMode ?? null, { timeout: 15_000 }).toBe('owner');
  // A narrow popup shows the compact bar and its network sheet; a wide one, the Captures section's picker.
  const narrow = await popup.evaluate((sel) => (window as unknown as { __webscoopTest: { count(s: string): number } }).__webscoopTest.count(sel), ws('bar-network'));
  await popupClick(narrow > 0 ? ws('bar-network') : ws('captures-pick'));
  await expect.poll(() => popupText(`${ws('network-row')} ${ws('network-popup')}`).catch(() => null), { timeout: 15_000 }).toBe('popup');
  await popupClick(ws('network-row'));
  // The main window takes the panel and opens the editor on the picked request.
  await r.until((s) => s.ui.panelMode === 'owner');
  await expect.poll(() => r.query(ws('capture-editor')).then((e) => e?.attrs['data-mode'] ?? null), { timeout: 10_000 }).toBe('new');
  expect((await r.query(ws('capture-from')))!.text).toContain('playlist.m3u8');
  await popup.close();
  expect((await r.closeWindow()).code).toBe(0);
});
