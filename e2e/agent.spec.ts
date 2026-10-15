import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecipeInput } from '@webscoop/core';
import { expect, hasDisplay, LLM_FIXTURES, PDF_AGENT_RECIPE, test } from './fixtures';

test.skip(!hasDisplay, 'the CLI needs WAYLAND_DISPLAY or DISPLAY');

const mock = (name: string) => ({ WEBSCOOP_LLM_MOCK: join(LLM_FIXTURES, `${name}.json`), WEBSCOOP_LLM_ENDPOINT: undefined, WEBSCOOP_LLM_MODEL: undefined });

async function setup(scoop: { writeRecipe(r: RecipeInput): Promise<string>; playground: { port: number }; home: string }) {
  await scoop.writeRecipe(JSON.parse(await readFile(PDF_AGENT_RECIPE, 'utf8')) as RecipeInput);
  return { url: `http://127.0.0.1:${scoop.playground.port}/pdf-links`, dir: join(scoop.home, 'out') };
}

interface DownloadRow {
  file: string;
  name: string;
  url: string;
  bytes: number;
  _page: number;
  _index: number;
}

for (const [name, what] of [
  ['pdf-agent-link', 'the plain link'],
  ['pdf-agent-open', 'the window.open button'],
] as const) {
  test(`reaches the PDF through ${what} and prints it as a downloads row`, async ({ scoop }) => {
    const { url, dir } = await setup(scoop);
    const result = await scoop.run(['run', 'playground-pdf-agent', '--var', `url=${url}`, '--download-dir', dir], mock(name));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/agent: click \[e\d\] /);
    expect(result.stderr).toMatch(/agent: grab:0 ended: download after 1 turn/);
    const rows = JSON.parse(result.stdout) as DownloadRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.file).toMatch(/\.pdf$/);
    expect((await readdir(dir)).filter((f) => f.endsWith('.pdf'))).toHaveLength(1);
  });
}

test('exits 3 when the model says done without a download', async ({ scoop }) => {
  const { url, dir } = await setup(scoop);
  const result = await scoop.run(['run', 'playground-pdf-agent', '--var', `url=${url}`, '--download-dir', dir], mock('pdf-agent-done'));
  expect(result.code, result.stderr).toBe(3);
  expect(result.stderr).toContain('done-unmet');
  expect(result.stdout).toBe('');
});

test('exits 3 with --no-llm and sends no request', async ({ scoop }) => {
  const { url, dir } = await setup(scoop);
  const result = await scoop.run(['run', 'playground-pdf-agent', '--var', `url=${url}`, '--download-dir', dir, '--no-llm'], mock('pdf-agent-link'));
  expect(result.code, result.stderr).toBe(3);
  expect(result.stderr).toContain('--no-llm');
  expect(result.stderr).not.toContain('agent: click');
});

test('prints no agent lines with --quiet', async ({ scoop }) => {
  const { url, dir } = await setup(scoop);
  const result = await scoop.run(['run', 'playground-pdf-agent', '--var', `url=${url}`, '--download-dir', dir, '--quiet'], mock('pdf-agent-link'));
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).not.toContain('agent:');
});
