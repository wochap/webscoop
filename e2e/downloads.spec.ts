import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecipeInput } from '@webscoop/core';
import { REPORT_CSV } from '@webscoop/playground';
import { expect, hasDisplay, test } from './fixtures';

test.skip(!hasDisplay, 'the CLI needs WAYLAND_DISPLAY or DISPLAY');

interface DownloadRow {
  file: string;
  name: string;
  url: string;
  bytes: number;
  _page: number;
  _index: number;
}

test('a recipe whose URL downloads saves the file with a targetless download step and prints its row', async ({ scoop }) => {
  const port = scoop.playground.port;
  await scoop.writeRecipe({
    schemaVersion: 2,
    name: 'export-url',
    url: `http://127.0.0.1:${port}/files/report.csv`,
    vars: [{ name: 'id', type: 'string' }],
    flows: [{ name: 'fetch', steps: [{ kind: 'download', value: '{id}.csv' }] }],
    sequence: [{ flow: 'fetch' }],
  } as RecipeInput);
  const dir = join(scoop.home, 'out');
  const result = await scoop.run(['run', 'export-url', '--var', 'id=r1', '--download-dir', dir]);
  expect(result.code, result.stderr).toBe(0);
  const rows = JSON.parse(result.stdout) as DownloadRow[];
  expect(rows).toEqual([{ file: join(dir, 'r1.csv'), name: 'r1.csv', url: `http://127.0.0.1:${port}/files/report.csv`, bytes: REPORT_CSV.length, _page: 1, _index: 0 }]);
  expect(await readFile(rows[0]!.file, 'utf8')).toBe(REPORT_CSV);
  expect(result.stderr).toMatch(/1 file saved/);
});

test('a download step clicks a link and saves what it downloads, next to an earlier file of the same name', async ({ scoop }) => {
  const port = scoop.playground.port;
  await scoop.writeRecipe({
    schemaVersion: 2,
    name: 'download-link',
    url: `http://127.0.0.1:${port}/files`,
    vars: [],
    flows: [{ name: 'fetch', steps: [{ kind: 'download', target: { selectors: [{ strategy: 'id', value: 'download-report', stability: 'stable' }] } }] }],
    sequence: [{ flow: 'fetch' }],
  } as RecipeInput);
  const dir = join(scoop.home, 'out');
  const first = await scoop.run(['run', 'download-link', '--download-dir', dir]);
  expect(first.code, first.stderr).toBe(0);
  expect((JSON.parse(first.stdout) as DownloadRow[]).map((r) => r.file)).toEqual([join(dir, 'report.csv')]);
  const second = await scoop.run(['run', 'download-link', '--download-dir', dir]);
  expect(second.code, second.stderr).toBe(0);
  const rows = JSON.parse(second.stdout) as DownloadRow[];
  expect(rows.map((r) => r.file)).toEqual([join(dir, 'report (1).csv')]);
  expect(await readFile(rows[0]!.file, 'utf8')).toBe(REPORT_CSV);
});
