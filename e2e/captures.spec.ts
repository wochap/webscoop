import { readFile } from 'node:fs/promises';
import type { RecipeInput } from '@webscoop/core';
import { expect, hasDisplay, test, VIDEO_RECIPE } from './fixtures';

test.skip(!hasDisplay, 'the CLI needs WAYLAND_DISPLAY or DISPLAY');

interface CaptureRow {
  url: string;
  method: string;
  status: number | null;
  mime: string | null;
  frame: string | null;
  _page: number;
  _index: number;
}

async function writeVideo(scoop: { writeRecipe(r: RecipeInput): Promise<string>; playground: { port: number } }): Promise<string[]> {
  const recipe = JSON.parse(await readFile(VIDEO_RECIPE, 'utf8')) as RecipeInput;
  await scoop.writeRecipe(recipe);
  return ['--var', `port=${scoop.playground.port}`, '--var', 'id=42'];
}

test('captures the playlist a cross-origin player fetches, once, with its frame', async ({ scoop }) => {
  const vars = await writeVideo(scoop);
  const port = scoop.playground.port;
  const result = await scoop.run(['run', 'playground-video', ...vars]);
  expect(result.code, result.stderr).toBe(0);
  const rows = JSON.parse(result.stdout) as CaptureRow[];
  expect(rows).toEqual([
    {
      url: `http://localhost:${port}/stream/42/playlist.m3u8`,
      method: 'GET',
      status: 200,
      mime: 'application/vnd.apple.mpegurl',
      frame: `http://localhost:${port}/video/player?id=42`,
      _page: 1,
      _index: 0,
    },
  ]);
  expect(result.stderr).toMatch(/1 URL captured/);
});

test('waits for a playlist that comes after the sequence ends', async ({ scoop }) => {
  const recipe = JSON.parse(await readFile(VIDEO_RECIPE, 'utf8')) as RecipeInput;
  await scoop.writeRecipe({ ...recipe, url: `${recipe.url}&delay=2000` });
  const result = await scoop.run(['run', 'playground-video', '--var', `port=${scoop.playground.port}`, '--var', 'id=42']);
  expect(result.code, result.stderr).toBe(0);
  expect((JSON.parse(result.stdout) as CaptureRow[]).map((r) => r._index)).toEqual([0]);
});

test('exits 3 naming the capture when the player fetches nothing', async ({ scoop }) => {
  const recipe = JSON.parse(await readFile(VIDEO_RECIPE, 'utf8')) as RecipeInput;
  await scoop.writeRecipe({ ...recipe, url: `${recipe.url}&noplay=1` });
  const result = await scoop.run(['run', 'playground-video', '--var', `port=${scoop.playground.port}`, '--var', 'id=42', '--timeout', '3000']);
  expect(result.code).toBe(3);
  expect(result.stderr).toContain('videos (count 1, 0 found)');
});

test('streams capture rows as JSONL', async ({ scoop }) => {
  const vars = await writeVideo(scoop);
  const result = await scoop.run(['run', 'playground-video', ...vars, '--jsonl']);
  expect(result.code, result.stderr).toBe(0);
  const lines = result.stdout.trimEnd().split('\n').map((l) => JSON.parse(l) as CaptureRow);
  expect(lines).toHaveLength(1);
  expect(lines[0]!.url).toMatch(/\/stream\/42\/playlist\.m3u8$/);
});

test('webscoop test shows the videos row', async ({ scoop }) => {
  const vars = await writeVideo(scoop);
  const result = await scoop.run(['test', 'playground-video', ...vars]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/^videos\s+ok\s+1\s+\/playlist\\\.m3u8/m);
});
