import { readFile } from 'node:fs/promises';
import { loadRecipe, paginateOf, paginationOf } from '@webscoop/core';
import { expect, hasDisplay, test } from './fixtures';
import { sidebar, template, ws } from './sidebar';

test.skip(!hasDisplay, 'the recorder needs WAYLAND_DISPLAY or DISPLAY');

test('marking a ?page=2 link proposes url pagination, saved and run', async ({ scoop }) => {
  const port = scoop.playground.port;
  const r = await scoop.record([template(port), '--var', 'tier=0', '--name', 'paged']);
  const panel = sidebar(r);
  await panel.titlesAsList();
  await r.page.evaluate(() => {
    const link = document.createElement('a');
    link.id = 'next-page';
    link.href = '/catalog?tier=0&page=2';
    link.textContent = 'Next page';
    document.querySelector('main')!.append(link);
  });
  await r.pick('#next-page');
  await r.clickPanel(ws('pick-pagination'));
  const pagination = await r.until((s) => s.host?.draft.pagination);
  expect(pagination).toMatchObject({ kind: 'url', param: { name: 'page', start: 1, step: 1 }, table: 'items' });
  await r.until((s) => s.host?.draft.sequence.blocks.some((b) => 'paginate' in b));
  await r.clickPanel(ws('paginate-toggle'));
  await r.clickPanel(ws('paginate-limit-n'));
  await r.until((s) => s.host?.draft.pagination?.limit === 3);
  const path = await panel.save();
  expect((await r.closeWindow()).code).toBe(0);

  const recipe = loadRecipe(await readFile(path, 'utf8'));
  expect(paginationOf(recipe)).toMatchObject({ kind: 'url', param: { name: 'page', start: 1, step: 1 }, limit: 3 });
  expect(paginateOf(recipe)!.target!.selectors.length).toBeGreaterThan(0);
  expect(paginateOf(recipe)!.do).toEqual([{ extract: 'items' }]);
  // The unpaginated catalog ignores `page`: every page repeats the first, so dedup keeps 24 rows.
  const run = await scoop.run(['run', 'paged']);
  expect(run.code, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toHaveLength(24);
  expect(run.stderr).toContain('page 2 loaded: http://127.0.0.1:');
  expect(run.stderr).toMatch(/[?&]page=3 \(HTTP 200\)/);
  expect(run.stderr).toMatch(/24 rows from 3 pages, 48 duplicates dropped in/);
});
