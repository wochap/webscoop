import { readFile } from 'node:fs/promises';
import { loadRecipe } from '@webscoop/core';
import { expect, hasDisplay, test } from './fixtures';
import { template, ws } from './sidebar';

test.skip(!hasDisplay, 'the recorder needs WAYLAND_DISPLAY or DISPLAY');

test('edit the URL template, see Reopen flagged, and reopen the new URL', async ({ scoop }) => {
  const port = scoop.playground.port;
  const r = await scoop.record([template(port), '--var', 'tier=0', '--name', 'url-edit']);
  expect(await r.count(ws('recipe-reopen-dot'))).toBe(0);
  await r.fill(ws('recipe-url'), template(port, '&x=1'));
  await r.until((s) => s.host?.draft.url === template(port, '&x=1'));
  expect(await r.count(ws('recipe-reopen-dot'))).toBe(1);
  expect((await r.query(ws('recipe-open-differs')))!.text).toContain('&x=1 added');
  await r.clickPanel(ws('recipe-reopen'));
  await r.until((s) => s.host?.url === `http://127.0.0.1:${port}/catalog?tier=0&x=1` && s.host.openedUrl === s.host.url);
  expect(await r.count(ws('recipe-reopen-dot'))).toBe(0);
  const result = await r.closeWindow();
  expect(result.code, result.stderr).toBe(0);
});

test('turn on Humanize input and save: the recipe has browser.humanize true', async ({ scoop }) => {
  const r = await scoop.record(['--edit', scoop.recipe.name]);
  expect((await r.query(ws('recipe-humanize')))!.attrs['aria-checked']).toBe('false');
  await r.clickPanel(ws('recipe-humanize'));
  await r.until((s) => s.host?.draft.browser?.humanize === true);
  await r.key('Control+s');
  const saved = await r.until((s) => (s.host?.saved && !s.host.draft.dirty ? s.host.saved : undefined));
  expect((await r.closeWindow()).code).toBe(0);
  expect(loadRecipe(await readFile(saved.path!, 'utf8')).browser).toEqual({ humanize: true });
});
