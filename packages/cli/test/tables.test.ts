import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPlan, loadRecipe, renderPy, renderTs, saveRecipe, tablesOf, type RecipeInput, type Row, type RunReport } from '@webscoop/core';
import { FakeBrowser, h, type FakeInteractiveSession } from '@webscoop/core/testing';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { RowSink, summary } from '../src/commands/run';
import { resolveRepick } from '../src/commands/record';
import { interactiveRepick } from '../src/repick';
import { tempDir, testIo } from './helpers';

const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };
const PAGE = 'https://shop.test/c/shoes';
const css = (value: string) => ({ strategy: 'css' as const, value, stability: 'medium' as const });

const TITLE = { name: 'title', type: 'text' as const, selectors: [css('h2')] };

/** Tables `page` (the heading) and `products` (the cards). */
function results(tables?: RecipeInput['tables']): RecipeInput {
  return {
    schemaVersion: 1,
    name: 'results',
    url: 'https://shop.test/c/{category}',
    vars: [{ name: 'category', type: 'string', default: 'shoes' }],
    tables: tables ?? [
      { name: 'page', fields: [{ name: 'heading', type: 'text', selectors: [css('h1')] }] },
      { name: 'products', item: { selectors: [css('div.card')] }, fields: [TITLE, { name: 'link', type: 'url', selectors: [css('a')], key: true }] },
    ],
  };
}

function shopPage(n: number) {
  return h(
    'html',
    {},
    h(
      'body',
      {},
      h('h1', {}, 'Shoes'),
      Array.from({ length: n }, (_, i) => h('div', { class: 'card' }, h('h2', {}, `Shoe ${i}`), h('a', { href: `/p/${i}` }, 'x'))),
    ),
  );
}

async function home(recipes: RecipeInput[] = [results()]) {
  const dir = await tempDir();
  await mkdir(join(dir, 'recipes'), { recursive: true });
  for (const r of recipes) await writeFile(join(dir, 'recipes', `${r.name}.json`), saveRecipe(loadRecipe(r)));
  return dir;
}

const row = (page: number, index: number, extra: Record<string, unknown>): Row => ({ _page: page, _index: index, ...extra });

describe('RowSink', () => {
  const collect = () => {
    let out = '';
    return { stdout: { write: (s: string) => (out += s) }, out: () => out };
  };

  it('writes a plain array for one table', async () => {
    const io = collect();
    const sink = new RowSink(io.stdout, { jsonl: false, tables: ['items'] });
    sink.row('items', row(1, 0, { a: 1 }));
    sink.row('items', row(1, 1, { a: 2 }));
    await sink.finish(true);
    expect(JSON.parse(io.out())).toEqual([row(1, 0, { a: 1 }), row(1, 1, { a: 2 })]);
  });

  it('writes plain JSONL rows for one table', async () => {
    const io = collect();
    const sink = new RowSink(io.stdout, { jsonl: true, tables: ['items'] });
    sink.row('items', row(1, 0, { a: 1 }));
    await sink.finish(true);
    expect(io.out()).toBe(`${JSON.stringify(row(1, 0, { a: 1 }))}\n`);
  });

  it('writes an object keyed by table, in recipe order, for several tables', async () => {
    const io = collect();
    const sink = new RowSink(io.stdout, { jsonl: false, tables: ['page', 'products', 'questions'] });
    sink.row('products', row(1, 0, { title: 'a' }));
    sink.row('page', row(1, 0, { heading: 'h' }));
    await sink.finish(true);
    const out = JSON.parse(io.out());
    expect(Object.keys(out)).toEqual(['page', 'products', 'questions']);
    expect(out).toEqual({ page: [row(1, 0, { heading: 'h' })], products: [row(1, 0, { title: 'a' })], questions: [] });
  });

  it('adds _table to JSONL rows for several tables', async () => {
    const io = collect();
    const sink = new RowSink(io.stdout, { jsonl: true, tables: ['page', 'products'] });
    sink.row('page', row(1, 0, { heading: 'h' }));
    sink.row('products', row(1, 0, { title: 'a' }));
    await sink.finish(true);
    expect(io.out().trimEnd().split('\n').map((l) => JSON.parse(l))).toEqual([
      { _table: 'page', ...row(1, 0, { heading: 'h' }) },
      { _table: 'products', ...row(1, 0, { title: 'a' }) },
    ]);
  });

  it('keeps only the selected table, in the single table shapes', async () => {
    for (const jsonl of [false, true]) {
      const io = collect();
      const sink = new RowSink(io.stdout, { jsonl, tables: ['page', 'products'], only: 'products' });
      sink.row('page', row(1, 0, { heading: 'h' }));
      sink.row('products', row(1, 0, { title: 'a' }));
      await sink.finish(true);
      const parsed = jsonl ? JSON.parse(io.out()) : JSON.parse(io.out())[0];
      expect(parsed).toEqual(row(1, 0, { title: 'a' }));
    }
  });

  it('writes nothing on failure', async () => {
    const io = collect();
    const sink = new RowSink(io.stdout, { jsonl: false, tables: ['page', 'products'] });
    sink.row('page', row(1, 0, { heading: 'h' }));
    await sink.finish(false);
    expect(io.out()).toBe('');
  });
});

describe('webscoop run with tables', () => {
  const run = async (args: string[], cwd?: string) => {
    const dir = await home();
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, cwd: cwd ?? dir, browser: new FakeBrowser({ [PAGE]: shopPage(3) }) });
    return { dir, io, code: await main(['run', 'results', ...args], io) };
  };

  it('prints one object keyed by table and names every table in the summary', async () => {
    const { io, code } = await run([]);
    expect(code).toBe(ExitCode.Ok);
    const out = JSON.parse(io.out());
    expect(Object.keys(out)).toEqual(['page', 'products']);
    expect(out.page).toEqual([{ _page: 1, _index: 0, heading: 'Shoes' }]);
    expect(out.products).toHaveLength(3);
    expect(io.err()).toMatch(/page: 1, products: 3 rows from 1 page in \d+\.\d+s \(results\)\n$/);
  });

  it('streams JSONL rows carrying _table', async () => {
    const { io, code } = await run(['--jsonl']);
    expect(code).toBe(ExitCode.Ok);
    const tables = io.out().trimEnd().split('\n').map((l) => JSON.parse(l)._table);
    expect(tables).toEqual(['page', 'products', 'products', 'products']);
  });

  it('prints one table as a plain array with --table', async () => {
    const { io, code } = await run(['--table', 'products']);
    expect(code).toBe(ExitCode.Ok);
    const out = JSON.parse(io.out());
    expect(Array.isArray(out)).toBe(true);
    expect(out.map((r: Row) => r.title)).toEqual(['Shoe 0', 'Shoe 1', 'Shoe 2']);
  });

  it('exits 1 on an unknown --table before the browser opens', async () => {
    const dir = await home();
    const io = testIo({ env: { WEBSCOOP_HOME: dir } });
    expect(await main(['run', 'results', '--table', 'ads'], io)).toBe(ExitCode.Error);
    expect(io.err()).toContain('"ads"');
    expect(io.err()).toContain('page, products');
    expect(io.browserCreated()).toBe(0);
  });

  it('writes one file per table into a directory given with a trailing separator', async () => {
    const { dir, io, code } = await run(['--out', 'data/']);
    expect(code).toBe(ExitCode.Ok);
    expect(io.out()).toBe('');
    expect((await readdir(join(dir, 'data'))).sort()).toEqual(['page.json', 'products.json']);
    expect(JSON.parse(await readFile(join(dir, 'data', 'page.json'), 'utf8'))).toEqual([{ _page: 1, _index: 0, heading: 'Shoes' }]);
    expect(JSON.parse(await readFile(join(dir, 'data', 'products.json'), 'utf8'))).toHaveLength(3);
  });

  it('writes JSONL files per table into an existing directory', async () => {
    const dir = await home();
    await mkdir(join(dir, 'existing'));
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, cwd: dir, browser: new FakeBrowser({ [PAGE]: shopPage(2) }) });
    expect(await main(['run', 'results', '--jsonl', '--out', 'existing'], io)).toBe(ExitCode.Ok);
    const lines = (await readFile(join(dir, 'existing', 'products.jsonl'), 'utf8')).trimEnd().split('\n');
    expect(lines.map((l) => JSON.parse(l))).toMatchObject([{ title: 'Shoe 0' }, { title: 'Shoe 1' }]);
    expect(lines.every((l) => !l.includes('_table'))).toBe(true);
    expect((await readFile(join(dir, 'existing', 'page.jsonl'), 'utf8')).trimEnd().split('\n')).toHaveLength(1);
  });

  it('keeps the single table shapes for a one entry tables recipe', async () => {
    const dir = await home([results([{ name: 'products', item: { selectors: [css('div.card')] }, fields: [TITLE] }])]);
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shopPage(2) }) });
    expect(await main(['run', 'results'], io)).toBe(ExitCode.Ok);
    expect(JSON.parse(io.out())).toEqual([
      { _page: 1, _index: 0, title: 'Shoe 0' },
      { _page: 1, _index: 1, title: 'Shoe 1' },
    ]);
    expect(io.err()).toMatch(/2 rows from 1 page/);
  });

  it('documents --table and directory output in --help', async () => {
    const io = testIo({});
    expect(await main(['run', '--help'], io)).toBe(ExitCode.Ok);
    expect(io.out()).toContain('--table <name>');
    expect(io.out()).toContain('<table>.json (or <table>.jsonl) per table');
  });
});

describe('summary with tables', () => {
  const report = (tables: RunReport['tables'], rowCount: number) =>
    ({ recipe: 'results', durationMs: 3100, pageCount: 2, rowCount, tables, healed: 0, guards: [], duplicateCount: 0, droppedCount: 0, steps: [] }) as unknown as RunReport;
  const table = (name: string, rowCount: number) => ({ name, rowCount, duplicateCount: 0, droppedCount: 0, item: null, fields: [] });

  it('lists the count of every table in place of the total', () => {
    expect(summary(report([table('page', 2), table('products', 40)], 42))).toBe('page: 2, products: 40 rows from 2 pages in 3.10s (results)');
  });

  it('keeps the total for one table', () => {
    expect(summary(report([table('items', 40)], 40))).toBe('40 rows from 2 pages in 3.10s (results)');
  });
});

describe('multi-table fences', () => {
  it('refuses export of a multi-table recipe', async () => {
    const dir = await home();
    const io = testIo({ env: { WEBSCOOP_HOME: dir } });
    expect(await main(['export', 'results'], io)).toBe(ExitCode.Error);
    expect(io.err()).toContain('export does not support multi-table recipes yet');
    expect(io.out()).toBe('');
  });

  it('exports a one entry tables recipe exactly like its shorthand', async () => {
    const products = { name: 'products', item: { selectors: [css('div.card')] }, fields: [{ ...TITLE, scope: 'item' as const }] };
    const { tables: _tables, ...rest } = results([products]);
    const shorthand: RecipeInput = { ...rest, item: products.item, fields: products.fields };
    const dir = await home([results([products])]);
    const io = testIo({ env: { WEBSCOOP_HOME: dir } });
    expect(await main(['export', 'results'], io)).toBe(ExitCode.Ok);
    const opts = { version: '0.0.0', now: new Date('2026-01-01T00:00:00Z'), headless: false };
    for (const render of [renderTs, renderPy]) {
      expect(render(buildPlan(loadRecipe(results([products]))), opts)).toBe(render(buildPlan(loadRecipe(shorthand)), opts));
    }
  });
});

async function sessionOf(browser: FakeBrowser): Promise<FakeInteractiveSession> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const s = browser.sessions[0];
    if (s && s.exposed.size > 0 && browser.visited.length > 0) return s;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

type ReadyState = { state: { draft: { tables: { name: string; fields: { name: string }[] }[]; activeTable: number }; repickContext: { table: string; field: string } | null } };

/** Tables `page` and `products` both with a `title` field, and `questions` with its own. */
function shared(): RecipeInput {
  return results([
    { name: 'page', fields: [TITLE, { name: 'heading', type: 'text', selectors: [css('h1')] }] },
    { name: 'products', item: { selectors: [css('div.card')] }, fields: [TITLE, { name: 'link', type: 'url', selectors: [css('a')] }] },
    { name: 'questions', item: { selectors: [css('div.q')] }, fields: [{ name: 'question', type: 'text', selectors: [css('h3')] }] },
  ]);
}

describe('record with tables', () => {
  it('opens a multi-table recipe with --edit with every table and the first active', async () => {
    const dir = await home();
    const browser = new FakeBrowser({ [PAGE]: shopPage(3) });
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    const run = main(['record', '--edit', 'results'], io);
    const session = await Promise.race([sessionOf(browser), run.then((code) => Promise.reject(new Error(`exited ${code}: ${io.err()}`)))]);
    const reply = (await session.callHost({ kind: 'session.ready', url: PAGE })) as ReadyState;
    expect(reply.state.draft.tables.map((t) => t.name)).toEqual(['page', 'products']);
    expect(reply.state.draft.activeTable).toBe(0);
    await session.userClose();
    expect(await run).toBe(ExitCode.Ok);
    expect(io.err()).toContain('recording results (edit)');
  });

  it('resolves --repick by table.field and by a bare name one table has', () => {
    const recipe = loadRecipe(shared());
    expect(resolveRepick(recipe, 'products.title')).toEqual({ table: 'products', fieldIndex: 0 });
    expect(resolveRepick(recipe, 'page.heading')).toEqual({ table: 'page', fieldIndex: 1 });
    expect(resolveRepick(recipe, 'link')).toEqual({ table: 'products', fieldIndex: 1 });
    expect(resolveRepick(recipe, 'question')).toEqual({ table: 'questions', fieldIndex: 0 });
    expect(resolveRepick(loadRecipe(results()), 'heading')).toEqual({ table: 'page', fieldIndex: 0 });
  });

  it('exits 1 for an unknown table, an unknown field, and an ambiguous name, naming them', async () => {
    const dir = await home([shared()]);
    const cases: [string, string[]][] = [
      ['title', ['field "title" is in several tables of recipe "results" (page, products)', 'products.title']],
      ['nope.title', ['has no table named "nope"', 'tables: page, products, questions']],
      ['products.price', ['table "products" of recipe "results" has no field named "price"', 'fields: title, link']],
      ['price', ['has no field named "price"', 'page.title, page.heading, products.title']],
    ];
    for (const [spec, texts] of cases) {
      const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
      expect(await main(['record', '--edit', 'results', '--repick', spec], io)).toBe(ExitCode.Error);
      for (const text of texts) expect(io.err()).toContain(text);
      expect(io.browserCreated()).toBe(0);
    }
  });

  it('passes the table to the session for --repick table.field', async () => {
    const dir = await home([shared()]);
    const browser = new FakeBrowser({ [PAGE]: shopPage(3) });
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    const run = main(['record', '--edit', 'results', '--repick', 'products.title'], io);
    const session = await Promise.race([sessionOf(browser), run.then((code) => Promise.reject(new Error(`exited ${code}: ${io.err()}`)))]);
    const reply = (await session.callHost({ kind: 'session.ready', url: PAGE })) as ReadyState;
    expect(reply.state.draft.activeTable).toBe(1);
    expect(reply.state.repickContext).toMatchObject({ table: 'products', field: 'title' });
    await session.callHost({ kind: 'repick.abort' });
    expect(await run).toBe(ExitCode.Ok);
    expect(io.err()).toContain('the recipe is unchanged');
  });

  it("passes the event's table in a run's interactive re-pick", async () => {
    const recipe = loadRecipe(shared());
    const browser = new FakeBrowser({ [PAGE]: shopPage(3) });
    const session = await browser.open('/profile');
    await session.goto(PAGE, { timeoutMs: 1000 });
    const io = testIo({});
    const handler = interactiveRepick(io, { storage: { list: async () => [], load: async () => recipe, save: async () => {} }, bundle: '', vars: {}, timeoutMs: 1000 });
    const title = tablesOf(recipe)[1]!.fields[0]!;
    const outcome = handler({
      page: 1,
      target: { kind: 'field', index: 0, table: 'products', name: 'title', scope: 'item', optional: false, selectors: title.selectors },
      name: 'title',
      oldSelector: title.selectors[0]!,
      fingerprint: null,
      sample: null,
      session,
      recipe,
    });
    const fake = session as FakeInteractiveSession;
    const deadline = Date.now() + 5000;
    while (fake.exposed.size === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    const reply = (await fake.callHost({ kind: 'session.ready', url: PAGE })) as ReadyState;
    expect(reply.state.draft.activeTable).toBe(1);
    expect(reply.state.repickContext).toMatchObject({ table: 'products', field: 'title' });
    await fake.callHost({ kind: 'repick.skip' });
    expect(await outcome).toEqual({ kind: 'skip' });
  });
});
