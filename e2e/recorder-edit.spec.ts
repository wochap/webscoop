import { readFile } from 'node:fs/promises';
import { loadRecipe } from '@webscoop/core';
import { expect, hasDisplay, test } from './fixtures';
import { sidebar, ws } from './sidebar';

test.skip(!hasDisplay, 'the recorder needs WAYLAND_DISPLAY or DISPLAY');

test('--edit shows six fields with counts, test runs 24 rows, and Ctrl+S saves it unchanged', async ({ scoop }) => {
  const original = loadRecipe(await readFile(scoop.recipePath, 'utf8'));
  const r = await scoop.record(['--edit', 'playground-catalog']);
  const panel = sidebar(r);
  const counted = await r.until((s) => (s.host?.draft.tables[0]!.fields.every((f) => f.count !== null) ? s : undefined));
  expect(counted.host!.draft.tables[0]!.fields.map((f) => [f.name, f.count])).toEqual([
    ['title', 24],
    ['price', 24],
    ['url', 24],
    ['image', 24],
    ['rating', 24],
    ['category', 1],
  ]);
  expect(await r.count(ws('field'))).toBe(6);
  const results = await panel.testRun();
  expect(results.tables[0]!.rowCount).toBe(24);
  expect(results.tables[0]!.fields.map((f) => f.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  expect(await r.count(ws('results-row'))).toBe(24);
  await panel.save();
  const result = await r.closeWindow();
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).not.toContain('unsaved');
  expect(loadRecipe(await readFile(scoop.recipePath, 'utf8'))).toEqual(original);
});
