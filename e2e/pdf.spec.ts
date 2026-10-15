import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecipeInput } from '@webscoop/core';
import { PlaywrightBrowser } from '@webscoop/browser';
import { expect, hasDisplay, test } from './fixtures';

test.skip(!hasDisplay, 'the CLI needs WAYLAND_DISPLAY or DISPLAY');

const CONTROLS = ['pdf-plain', 'pdf-download-attr', 'pdf-blank', 'pdf-open', 'pdf-attachment', 'pdf-octet'];

const clickRecipe = (port: number, id: string): RecipeInput =>
  ({
    schemaVersion: 2,
    name: id,
    url: `http://127.0.0.1:${port}/pdf-links`,
    vars: [],
    flows: [{ name: 'open', steps: [{ kind: 'click', target: { selectors: [{ strategy: 'id', value: id, stability: 'stable' }] } }] }],
    sequence: [{ flow: 'open' }],
  }) as RecipeInput;

for (const id of CONTROLS) {
  test(`download mode saves the PDF of ${id}`, async ({ scoop }) => {
    await scoop.writeRecipe(clickRecipe(scoop.playground.port, id));
    const dir = join(scoop.home, 'out');
    const result = await scoop.run(['run', id, '--download-dir', dir]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/saved .*\.pdf/);
    expect((await readdir(dir)).filter((f) => f.endsWith('.pdf'))).toHaveLength(1);
  });
}

test('download mode saves a PDF the recipe URL points at', async ({ scoop }) => {
  await scoop.writeRecipe({
    schemaVersion: 2,
    name: 'pdf-url',
    url: `http://127.0.0.1:${scoop.playground.port}/pdf`,
    vars: [],
    flows: [{ name: 'fetch', steps: [{ kind: 'download' }] }],
    sequence: [{ flow: 'fetch' }],
  } as RecipeInput);
  const dir = join(scoop.home, 'out');
  const result = await scoop.run(['run', 'pdf-url', '--download-dir', dir]);
  expect(result.code, result.stderr).toBe(0);
  expect((await readdir(dir)).filter((f) => f.endsWith('.pdf'))).toHaveLength(1);
});

test('the window.open case leaves the run on its original page', async ({ scoop }) => {
  const port = scoop.playground.port;
  const browser = new PlaywrightBrowser({ executablePath: process.env.WEBSCOOP_CHROMIUM || undefined });
  const session = await browser.open(await mkdtemp(join(tmpdir(), 'webscoop-pdf-')), { pdf: 'download', downloadDir: join(scoop.home, 'out') });
  try {
    await session.goto(`http://127.0.0.1:${port}/pdf-links`, { timeoutMs: 30_000 });
    const [button] = await session.resolve({ strategy: 'id', value: 'pdf-open', stability: 'stable' });
    const mark = session.downloadMark();
    await session.click(button!);
    const saved = await session.nextDownload({ since: mark, timeoutMs: 15_000 });
    expect(saved.name).toMatch(/\.pdf$/);
    expect(await session.url()).toBe(`http://127.0.0.1:${port}/pdf-links`);
  } finally {
    await session.close();
  }
});

test('view mode keeps the viewer: the recipe URL stays on /pdf and nothing is saved', async ({ scoop }) => {
  const port = scoop.playground.port;
  const dir = join(scoop.home, 'out');
  const browser = new PlaywrightBrowser({ executablePath: process.env.WEBSCOOP_CHROMIUM || undefined });
  const session = await browser.open(await mkdtemp(join(tmpdir(), 'webscoop-pdf-')), { pdf: 'view', downloadDir: dir });
  try {
    const info = await session.goto(`http://127.0.0.1:${port}/pdf`, { timeoutMs: 30_000 });
    expect(info.download).toBeUndefined();
    expect(await session.url()).toBe(`http://127.0.0.1:${port}/pdf`);
  } finally {
    await session.close();
  }
  expect(await readdir(dir).catch(() => [])).toEqual([]);
});
