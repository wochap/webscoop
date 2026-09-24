import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRecipe, saveRecipe, type RecipeInput } from '@webscoop/core';
import { FakeBrowser, h } from '@webscoop/core/testing';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { healingFromFlags } from '../src/commands/run';
import { tempDir, testIo } from './helpers';

const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };
const PAGE = 'https://shop.test/c/shoes';
const sel = (strategy: 'css' | 'testid', value: string) => ({ strategy, value, stability: strategy === 'testid' ? ('stable' as const) : ('medium' as const) });

/** Price has a dead first selector; the second still works, so the run heals it. */
function recipe(overrides: Partial<RecipeInput> = {}): RecipeInput {
  return {
    schemaVersion: 1,
    name: 'shop',
    url: 'https://shop.test/c/{category}',
    vars: [{ name: 'category', type: 'string', default: 'shoes' }],
    item: { selectors: [sel('testid', 'card')] },
    fields: [
      { name: 'title', type: 'text', scope: 'item', selectors: [sel('css', 'h2')] },
      { name: 'price', type: 'number', scope: 'item', selectors: [sel('css', '.old-price'), sel('css', '.price')] },
    ],
    ...overrides,
  };
}

function shopPage(n: number) {
  return h(
    'html',
    {},
    h(
      'body',
      {},
      Array.from({ length: n }, (_, i) => h('div', { 'data-testid': 'card' }, h('h2', {}, `Shoe ${i}`), h('span', { class: 'price', 'data-testid': 'price' }, `$${i + 1}.00`))),
    ),
  );
}

async function home(recipes: RecipeInput[] = [recipe()]) {
  const dir = await tempDir();
  await mkdir(join(dir, 'recipes'), { recursive: true });
  for (const r of recipes) await writeFile(join(dir, 'recipes', `${r.name}.json`), saveRecipe(loadRecipe(r)));
  return dir;
}

const io = (dir: string, n = 3, cwd?: string) => testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shopPage(n) }), ...(cwd ? { cwd } : {}) });

describe('run healing flags', () => {
  it('maps --no-heal and --no-save', () => {
    expect(healingFromFlags({})).toEqual({ enabled: true, writeBack: true });
    expect(healingFromFlags({ heal: true, save: true })).toEqual({ enabled: true, writeBack: true });
    expect(healingFromFlags({ save: false })).toEqual({ enabled: true, writeBack: false });
    expect(healingFromFlags({ heal: false })).toEqual({ enabled: false, writeBack: false });
    expect(healingFromFlags({ heal: false, save: true })).toEqual({ enabled: false, writeBack: false });
  });

  it('heals, writes the recipe back, and counts healed fields in the summary', async () => {
    const dir = await home();
    const t = io(dir);
    expect(await main(['run', 'shop'], t)).toBe(ExitCode.Ok);
    expect(JSON.parse(t.out())).toHaveLength(3);
    const file = join(dir, 'recipes', 'shop.json');
    const saved = loadRecipe(await readFile(file, 'utf8'));
    expect(saved.fields[1]!.selectors[0]).toEqual(sel('css', '.price'));
    expect(saved.fields[1]!.selectors).toContainEqual(sel('testid', 'price'));
    expect(saved.fields[1]!.selectors).not.toContainEqual(sel('css', '.old-price'));
    expect(saved.fields[0]).toEqual(loadRecipe(recipe()).fields[0]);
    expect(t.err()).toContain('healed price: candidate 1: css=.price (was css=.old-price)');
    expect(t.err()).toContain(`recipe written to ${file}`);
    expect(t.err()).toMatch(/3 rows from 1 page, 1 healed in \d+\.\d+s \(shop\)\n$/);
  });

  it('writes a recipe loaded by path back to that path', async () => {
    const dir = await tempDir();
    const file = join(dir, 'mine.json');
    await writeFile(file, saveRecipe(loadRecipe(recipe())));
    const t = io(dir, 2, dir);
    expect(await main(['run', './mine.json'], t)).toBe(ExitCode.Ok);
    expect(loadRecipe(await readFile(file, 'utf8')).fields[1]!.selectors[0]).toEqual(sel('css', '.price'));
    await expect(readFile(join(dir, 'recipes', 'shop.json'), 'utf8')).rejects.toThrow();
  });

  it('leaves the file unchanged with --no-save', async () => {
    const dir = await home();
    const file = join(dir, 'recipes', 'shop.json');
    const before = await readFile(file, 'utf8');
    const t = io(dir);
    expect(await main(['run', 'shop', '--no-save'], t)).toBe(ExitCode.Ok);
    expect(JSON.parse(t.out())).toHaveLength(3);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(t.err()).toContain('1 healed');
  });

  it('exits 3 with --no-heal when only the second selector works', async () => {
    const dir = await home();
    const file = join(dir, 'recipes', 'shop.json');
    const before = await readFile(file, 'utf8');
    const t = io(dir);
    expect(await main(['run', 'shop', '--no-heal'], t)).toBe(ExitCode.Unresolved);
    expect(t.out()).toBe('');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('opens the browser with bypassCSP and the recorder bundle only with --interactive', async () => {
    const dir = await home([recipe({ fields: [{ name: 'title', type: 'text', scope: 'item', selectors: [sel('css', 'h2')] }] })]);
    const browser = new FakeBrowser({ [PAGE]: shopPage(1) });
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir, WEBSCOOP_E2E_CDP_PORT: '9333' }, browser });
    expect(await main(['run', 'shop', '--interactive'], t)).toBe(ExitCode.Ok);
    expect(browser.openOptions[0]).toEqual({ bypassCSP: true, remoteDebuggingPort: 9333 });
    expect(await main(['run', 'shop'], t)).toBe(ExitCode.Ok);
    expect(browser.openOptions[1]).toBeUndefined();
  });
});

describe('webscoop test', () => {
  it('prints the field table, no rows, and exits 0 for a healthy recipe', async () => {
    const dir = await home([recipe({ fields: [{ name: 'title', type: 'text', scope: 'item', selectors: [sel('css', 'h2')] }] })]);
    const t = io(dir);
    expect(await main(['test', 'shop'], t)).toBe(ExitCode.Ok);
    expect(t.out()).toBe(['FIELD  STATUS  MATCHES  RESOLVED BY', 'item   ok      3        candidate 0: testid=card', 'title  ok      3/3      candidate 0: css=h2', ''].join('\n'));
  });

  it('heals without writing back and reports the rung', async () => {
    const dir = await home();
    const file = join(dir, 'recipes', 'shop.json');
    const before = await readFile(file, 'utf8');
    const t = io(dir);
    expect(await main(['test', 'shop', '--json'], t)).toBe(ExitCode.Ok);
    const rows = JSON.parse(t.out());
    expect(rows.map((r: { name: string; status: string }) => [r.name, r.status])).toEqual([
      ['item', 'ok'],
      ['title', 'ok'],
      ['price', 'healed'],
    ]);
    expect(rows[2]).toMatchObject({ matches: 3, rows: 3, outcome: { kind: 'candidate', index: 1 }, resolvedBy: 'candidate 1: css=.price' });
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('exits 3 and shows missing for a dead required field', async () => {
    const dir = await home([recipe({ fields: [{ name: 'title', type: 'text', scope: 'item', selectors: [sel('css', 'h2')] }, { name: 'price', type: 'number', scope: 'item', selectors: [sel('css', '.gone')] }] })]);
    const t = io(dir);
    expect(await main(['test', 'shop', '--json'], t)).toBe(ExitCode.Unresolved);
    const rows = JSON.parse(t.out());
    expect(rows.find((r: { name: string }) => r.name === 'price')).toMatchObject({ status: 'missing', matches: 0, resolvedBy: 'unresolved' });
    expect(t.out()).not.toContain('Shoe');
  });
});

describe('record --repick', () => {
  it('exits 1 naming an unknown field before opening a browser', async () => {
    const dir = await home();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
    expect(await main(['record', '--edit', 'shop', '--repick', 'colour'], t)).toBe(ExitCode.Error);
    expect(t.err()).toContain('has no field named "colour"');
    expect(t.err()).toContain('fields: title, price');
    expect(t.browserCreated()).toBe(0);
  });

  it('needs --edit', async () => {
    const t = testIo({ env: DISPLAY });
    expect(await main(['record', 'https://shop.test/', '--repick', 'price'], t)).toBe(ExitCode.Error);
    expect(t.err()).toContain('--repick needs --edit');
  });
});

describe('help', () => {
  it('lists the healing flags, the test command, and --repick', async () => {
    const t = testIo({});
    await main(['--help'], t);
    expect(t.out()).toContain('test [options] <recipe>');
    for (const flag of ['--no-heal', '--no-save', '--interactive', '--repick <field>']) expect(t.out()).toContain(flag);
    const run = testIo({});
    await main(['run', '--help'], run);
    for (const flag of ['--no-heal', '--no-save', '--interactive']) expect(run.out()).toContain(flag);
    const record = testIo({});
    await main(['record', '--help'], record);
    expect(record.out()).toContain('--repick <field>');
    const test = testIo({});
    await main(['test', '--help'], test);
    expect(test.out()).toContain('--json');
  });
});
