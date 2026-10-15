import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRecipe, saveRecipe, type RecipeInput } from '@webscoop/core';
import { FakeBrowser, h, type FakePage } from '@webscoop/core/testing';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { tempDir, testIo } from './helpers';

const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };
const URL_ = 'https://h.test/report';

const grab = (extra: Record<string, unknown> = {}): RecipeInput => ({
  schemaVersion: 2,
  name: 'grab-pdf',
  description: 'download the PDF a page offers',
  url: '{url}',
  vars: [{ name: 'url', type: 'string', raw: true }],
  flows: [{ name: 'grab', steps: [{ kind: 'agent', goal: 'Download the PDF', until: 'download', ...extra }] }],
  sequence: [{ flow: 'grab' }],
});

const page = (): FakePage => ({
  dom: h('html', {}, h('body', {}, h('a', { id: 'pdf', href: '#' }, 'Get the PDF'))),
  on: { click: (el) => (el?.attrs.id === 'pdf' ? { download: { url: '/r.pdf', name: 'r.pdf', bytes: 7 } } : undefined) },
});

async function setup(script: unknown, recipe: RecipeInput = grab()) {
  const dir = await tempDir();
  await mkdir(join(dir, 'recipes'), { recursive: true });
  await writeFile(join(dir, 'recipes', `${recipe.name}.json`), saveRecipe(loadRecipe(recipe)));
  await writeFile(join(dir, 'mock.json'), JSON.stringify(script));
  return dir;
}

const click = { reply: { action: 'click', ref: 'e1', reason: 'the PDF link' } };

describe('agent steps in run', () => {
  it('prints the actions on stderr and a downloads row with the file', async () => {
    const dir = await setup([click]);
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir, WEBSCOOP_LLM_MOCK: join(dir, 'mock.json') }, browser: new FakeBrowser({ [URL_]: page() }) });
    expect(await main(['run', 'grab-pdf', '--var', `url=${URL_}`], io)).toBe(ExitCode.Ok);
    expect(io.err()).toContain('agent: click [e1] link "Get the PDF" href=# (the PDF link)');
    expect(io.err()).toContain('agent: grab:0 ended: download after 1 turn');
    const rows = JSON.parse(io.out()) as { file: string; name: string; bytes: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'r.pdf', bytes: 7 });
    expect(rows[0]!.file).toMatch(/r\.pdf$/);
  });

  it('prints no agent lines with --quiet', async () => {
    const dir = await setup([click]);
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir, WEBSCOOP_LLM_MOCK: join(dir, 'mock.json') }, browser: new FakeBrowser({ [URL_]: page() }) });
    expect(await main(['run', 'grab-pdf', '--var', `url=${URL_}`, '--quiet'], io)).toBe(ExitCode.Ok);
    expect(io.err()).not.toContain('agent:');
  });

  it('carries the transcript in --report', async () => {
    const dir = await setup([click]);
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir, WEBSCOOP_LLM_MOCK: join(dir, 'mock.json') }, browser: new FakeBrowser({ [URL_]: page() }) });
    expect(await main(['run', 'grab-pdf', '--var', `url=${URL_}`, '--report'], io)).toBe(ExitCode.Ok);
    const start = io.err().indexOf('{\n');
    const report = JSON.parse(io.err().slice(start, io.err().lastIndexOf('}') + 1));
    expect(report.steps[0].agent).toMatchObject({ turns: 1, end: 'download', actions: [{ action: 'click', ref: 'e1', reason: 'the PDF link' }] });
  });

  it('exits 3 when the model says done twice without a download', async () => {
    const dir = await setup([{ reply: { action: 'done', reason: 'x' }, repeat: true }]);
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir, WEBSCOOP_LLM_MOCK: join(dir, 'mock.json') }, browser: new FakeBrowser({ [URL_]: page() }) });
    expect(await main(['run', 'grab-pdf', '--var', `url=${URL_}`], io)).toBe(3);
    expect(io.err()).toContain('missing-required');
    expect(io.err()).toContain('done-unmet');
  });

  it('exits 3 with --no-llm, names the step and the flag, and sends no request', async () => {
    const dir = await setup([click]);
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir, WEBSCOOP_LLM_MOCK: join(dir, 'mock.json') }, browser: new FakeBrowser({ [URL_]: page() }) });
    expect(await main(['run', 'grab-pdf', '--var', `url=${URL_}`, '--no-llm', '--quiet'], io)).toBe(3);
    expect(io.err()).toMatch(/agent step grab:0 cannot run:.*--no-llm/);
  });

  it('skips an optional agent step with --no-llm', async () => {
    const dir = await setup([click], grab({ optional: true }));
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir, WEBSCOOP_LLM_MOCK: join(dir, 'mock.json') }, browser: new FakeBrowser({ [URL_]: page() }) });
    expect(await main(['run', 'grab-pdf', '--var', `url=${URL_}`, '--no-llm'], io)).toBe(ExitCode.Ok);
    expect(io.err()).toContain('--no-llm');
  });
});

describe('recipes --json for agent recipes', () => {
  it('lists agent and downloads as true', async () => {
    const dir = await setup([click]);
    const io = testIo({ env: { WEBSCOOP_HOME: dir } });
    expect(await main(['recipes', '--json'], io)).toBe(ExitCode.Ok);
    const [entry] = JSON.parse(io.out());
    expect(entry).toMatchObject({ name: 'grab-pdf', agent: true, downloads: true, tables: [] });
  });

  it('leaves both keys out of a recipe without them', async () => {
    const dir = await setup([click], { ...grab(), flows: [], sequence: [], captures: [{ name: 'videos', match: 'x' }] } as RecipeInput);
    const io = testIo({ env: { WEBSCOOP_HOME: dir } });
    expect(await main(['recipes', '--json'], io)).toBe(ExitCode.Ok);
    const [entry] = JSON.parse(io.out());
    expect('agent' in entry).toBe(false);
    expect('downloads' in entry).toBe(false);
  });
});
