import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRecipe, saveRecipe, type RecipeInput, type RunReport } from '@webscoop/core';
import { FakeBrowser, h } from '@webscoop/core/testing';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { summary } from '../src/commands/run';
import { maxPagesArg, pagesArg } from '../src/main';
import { tempDir, testIo } from './helpers';

const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };
const BASE = 'https://shop.test/list';

function recipe(pagination: RecipeInput['pagination']): RecipeInput {
  return {
    schemaVersion: 1,
    name: 'shop',
    url: `${BASE}?page={n}`,
    vars: [{ name: 'n', type: 'string' }],
    item: { selectors: [{ strategy: 'testid', value: 'card', stability: 'stable' }] },
    fields: [
      { name: 'title', type: 'text', scope: 'item', selectors: [{ strategy: 'css', value: 'h2', stability: 'medium' }] },
      { name: 'link', type: 'url', scope: 'item', selectors: [{ strategy: 'css', value: 'a', stability: 'medium' }], key: true },
    ],
    pagination,
  };
}

/** Page `p` lists items `(p - 1) * 3 + 1 - overlap` to `p * 3`. */
function page(p: number, overlap = 0) {
  const first = Math.max(1, (p - 1) * 3 + 1 - overlap);
  return h(
    'html',
    {},
    h(
      'body',
      {},
      Array.from({ length: p * 3 - first + 1 }, (_, i) => h('div', { 'data-testid': 'card' }, h('h2', {}, `Item ${first + i}`), h('a', { href: `/p/${first + i}` }, 'x'))),
    ),
  );
}

function site(pages: number, overlap = 0) {
  const browser = new FakeBrowser();
  for (let p = 1; p <= pages; p++) browser.setPage(`${BASE}?page=${p}`, page(p, p === 1 ? 0 : overlap));
  return browser;
}

async function home(r: RecipeInput) {
  const dir = await tempDir();
  await mkdir(join(dir, 'recipes'), { recursive: true });
  await writeFile(join(dir, 'recipes', `${r.name}.json`), saveRecipe(loadRecipe(r)));
  return dir;
}

const URL_KIND = { kind: 'url' as const, param: { name: 'n', start: 1, step: 1 } };

describe('pagination flags', () => {
  it('parses --pages and --max-pages', () => {
    expect(pagesArg('all')).toBe('all');
    expect(pagesArg('1')).toBe(1);
    expect(pagesArg('12')).toBe(12);
    for (const bad of ['many', '0', '-1', '2.5', '']) expect(() => pagesArg(bad)).toThrow();
    expect(maxPagesArg('500')).toBe(500);
    expect(() => maxPagesArg('0')).toThrow();
  });

  it('rejects --pages many naming the flag', async () => {
    const dir = await home(recipe({ ...URL_KIND, limit: 1 }));
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: site(3) });
    expect(await main(['run', 'shop', '--pages', 'many'], io)).toBe(ExitCode.Error);
    expect(io.err()).toContain('--pages');
    expect(io.browserCreated()).toBe(0);
  });

  it('walks every page with --pages all and reports pages and duplicates', async () => {
    const dir = await home(recipe({ ...URL_KIND, limit: 1 }));
    const browser = site(3, 1);
    browser.setPage(`${BASE}?page=4`, h('html', {}, h('body', {})));
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    expect(await main(['run', 'shop', '--pages', 'all', '--jsonl'], io)).toBe(ExitCode.Ok);
    const rows = io.out().trimEnd().split('\n').map((l) => JSON.parse(l) as { title: string; _page: number });
    expect(rows.map((r) => r.title)).toEqual(Array.from({ length: 9 }, (_, i) => `Item ${i + 1}`));
    expect(rows.map((r) => r._page)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);
    expect(io.err()).toContain('page 2: url');
    expect(io.err()).toContain('pagination stopped after page 3: no-new-items');
    expect(io.err()).toMatch(/9 rows from 3 pages, 2 duplicates dropped in \d+\.\d+s \(shop\)\n$/);
  });

  it('starts at the page given with --var and stops at --pages', async () => {
    const dir = await home(recipe({ ...URL_KIND, limit: 'all' }));
    const browser = site(5);
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    expect(await main(['run', 'shop', '--var', 'n=3', '--pages', '2'], io)).toBe(ExitCode.Ok);
    expect(browser.visited).toEqual([`${BASE}?page=3`, `${BASE}?page=4`]);
    expect(io.err()).not.toContain('pagination stopped');
  });

  it('exits 1 for a non-numeric page variable', async () => {
    const dir = await home(recipe({ ...URL_KIND, limit: 'all' }));
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: site(1) });
    expect(await main(['run', 'shop', '--var', 'n=x'], io)).toBe(ExitCode.Error);
    expect(io.err()).toContain('page variable n');
  });

  it('caps all with --max-pages and warns', async () => {
    const dir = await home(recipe({ ...URL_KIND, limit: 'all' }));
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: site(5) });
    expect(await main(['run', 'shop', '--max-pages', '2'], io)).toBe(ExitCode.Ok);
    expect(JSON.parse(io.out())).toHaveLength(6);
    expect(io.err()).toContain('warning: stopped at the page cap of 2 pages');
  });

  it('keeps test on the first page unless --pages is given', async () => {
    const dir = await home(recipe({ ...URL_KIND, limit: 'all' }));
    const first = site(3);
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: first });
    expect(await main(['test', 'shop'], io)).toBe(ExitCode.Ok);
    expect(first.visited).toEqual([`${BASE}?page=1`]);

    const two = site(3);
    expect(await main(['test', 'shop', '--pages', '2'], testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: two }))).toBe(ExitCode.Ok);
    expect(two.visited).toEqual([`${BASE}?page=1`, `${BASE}?page=2`]);
  });
});

describe('summary', () => {
  const report = (extra: Partial<RunReport>): RunReport => ({
    recipe: 'shop',
    startedAt: '',
    endedAt: '',
    durationMs: 1500,
    finalUrl: null,
    pageCount: 1,
    rowCount: 24,
    tables: [],
    item: null,
    fields: [],
    pagination: null,
    duplicateCount: 0,
    droppedCount: 0,
    stopReason: 'limit',
    pages: [],
    warnings: [],
    healed: 0,
    savedTo: null,
    guards: [],
    steps: [],
    ...extra,
  });

  it('counts pages, healed targets, and dropped duplicates', () => {
    expect(summary(report({}))).toBe('24 rows from 1 page in 1.50s (shop)');
    expect(summary(report({ pageCount: 3, duplicateCount: 2 }))).toBe('24 rows from 3 pages, 2 duplicates dropped in 1.50s (shop)');
    expect(summary(report({ pageCount: 3, healed: 1, duplicateCount: 1 }))).toBe('24 rows from 3 pages, 1 healed, 1 duplicate dropped in 1.50s (shop)');
  });

  it('counts rows dropped for missing fields only when non-zero', () => {
    expect(summary(report({ droppedCount: 6 }))).toBe('24 rows from 1 page, 6 rows dropped for missing fields in 1.50s (shop)');
    expect(summary(report({ droppedCount: 1, duplicateCount: 2 }))).toBe(
      '24 rows from 1 page, 2 duplicates dropped, 1 row dropped for missing fields in 1.50s (shop)',
    );
  });
});
