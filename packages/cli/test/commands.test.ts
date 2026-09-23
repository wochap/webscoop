import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { saveRecipe, loadRecipe, type RecipeInput } from '@webscoop/core';
import { FakeBrowser, h } from '@webscoop/core/testing';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { tempDir, testIo } from './helpers';

const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };
const PAGE = 'https://shop.test/c/shoes';

function recipe(overrides: Partial<RecipeInput> = {}): RecipeInput {
  return {
    schemaVersion: 1,
    name: 'shop',
    url: 'https://shop.test/c/{category}',
    vars: [{ name: 'category', type: 'string', default: 'shoes' }],
    item: { selectors: [{ strategy: 'testid', value: 'card', stability: 'stable' }] },
    fields: [
      { name: 'title', type: 'text', scope: 'item', selectors: [{ strategy: 'css', value: 'h2', stability: 'medium' }] },
      { name: 'price', type: 'number', scope: 'item', selectors: [{ strategy: 'css', value: '.price', stability: 'medium' }] },
      { name: 'link', type: 'url', scope: 'item', selectors: [{ strategy: 'css', value: 'a', stability: 'medium' }] },
    ],
    ...overrides,
  };
}

function shopPage(n: number, withPrice: (i: number) => boolean = () => true) {
  return h(
    'html',
    {},
    h(
      'body',
      {},
      Array.from({ length: n }, (_, i) =>
        h('div', { 'data-testid': 'card' }, h('h2', {}, ` Shoe  ${i} `), withPrice(i) && h('span', { class: 'price' }, `$1,${i}00.00`), h('a', { href: `/p/${i}` }, 'x')),
      ),
    ),
  );
}

async function home(recipes: RecipeInput[] = [recipe()]) {
  const dir = await tempDir();
  await mkdir(join(dir, 'recipes'), { recursive: true });
  for (const r of recipes) await writeFile(join(dir, 'recipes', `${r.name}.json`), saveRecipe(loadRecipe(r)));
  return dir;
}

describe('webscoop run', () => {
  it('prints a JSON array on stdout and logs on stderr', async () => {
    const dir = await home();
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shopPage(3) }) });
    expect(await main(['run', 'shop'], io)).toBe(ExitCode.Ok);
    const rows = JSON.parse(io.out());
    expect(rows).toEqual([
      { _page: 1, _index: 0, title: 'Shoe 0', price: 1000, link: 'https://shop.test/p/0' },
      { _page: 1, _index: 1, title: 'Shoe 1', price: 1100, link: 'https://shop.test/p/1' },
      { _page: 1, _index: 2, title: 'Shoe 2', price: 1200, link: 'https://shop.test/p/2' },
    ]);
    expect(io.err()).toMatch(/3 rows from 1 page in \d+\.\d+s \(shop\)\n$/);
  });

  it('streams JSONL', async () => {
    const dir = await home();
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shopPage(4) }) });
    expect(await main(['run', 'shop', '--jsonl'], io)).toBe(ExitCode.Ok);
    const lines = io.out().trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[3]!)).toMatchObject({ _index: 3, title: 'Shoe 3' });
  });

  it('writes to --out instead of stdout', async () => {
    const dir = await home();
    const io = testIo({
      env: { ...DISPLAY, WEBSCOOP_HOME: dir },
      cwd: dir,
      browser: new FakeBrowser({ [PAGE]: shopPage(2) }),
    });
    expect(await main(['run', 'shop', '--out', 'out/rows.json'], io)).toBe(ExitCode.Ok);
    expect(io.out()).toBe('');
    expect(JSON.parse(await readFile(join(dir, 'out/rows.json'), 'utf8'))).toHaveLength(2);
  });

  it('substitutes --var values with URL encoding', async () => {
    const dir = await home();
    const browser = new FakeBrowser({ 'https://shop.test/c/running%20shoes': shopPage(1) });
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    expect(await main(['run', 'shop', '--var', 'category=running shoes'], io)).toBe(ExitCode.Ok);
    expect(browser.visited).toEqual(['https://shop.test/c/running%20shoes']);
  });

  it('exits 1 naming a variable with no value', async () => {
    const dir = await home([recipe({ vars: [{ name: 'category', type: 'string' }] })]);
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
    expect(await main(['run', 'shop'], io)).toBe(ExitCode.Error);
    expect(io.err()).toContain('category');
    expect(io.browserCreated()).toBe(0);
  });

  it('exits 1 without a display before any browser code runs', async () => {
    const dir = await home();
    const io = testIo({ env: { WEBSCOOP_HOME: dir } });
    expect(await main(['run', 'shop'], io)).toBe(ExitCode.Error);
    expect(io.err()).toContain('display is required');
    expect(io.browserCreated()).toBe(0);
  });

  it('exits 1 and prints every error for an invalid recipe', async () => {
    const dir = await tempDir();
    const file = join(dir, 'bad.json');
    const bad = recipe({ vars: [] }) as unknown as { fields: { type: string }[] };
    bad.fields[0]!.type = 'money';
    await writeFile(file, JSON.stringify(bad));
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, cwd: dir });
    expect(await main(['run', './bad.json'], io)).toBe(ExitCode.Error);
    expect(io.err()).toContain('$.url');
    expect(io.err()).toContain('$.fields[0].type');
    expect(io.out()).toBe('');
  });

  it('runs a recipe by path without consulting the recipes directory', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'my.json'), saveRecipe(loadRecipe(recipe({ name: 'mine' }))));
    const io = testIo({
      env: { ...DISPLAY, WEBSCOOP_HOME: join(dir, 'home') },
      cwd: dir,
      browser: new FakeBrowser({ [PAGE]: shopPage(1) }),
    });
    expect(await main(['run', './my.json'], io)).toBe(ExitCode.Ok);
    expect(JSON.parse(io.out())).toHaveLength(1);
  });

  it('exits 1 for an unknown recipe name', async () => {
    const dir = await home();
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
    expect(await main(['run', 'nope'], io)).toBe(ExitCode.Error);
    expect(io.err()).toContain('no recipe named "nope"');
  });

  it('exits 3 with no stdout when a required field is missing everywhere', async () => {
    const dir = await home();
    const io = testIo({
      env: { ...DISPLAY, WEBSCOOP_HOME: dir },
      browser: new FakeBrowser({ [PAGE]: shopPage(3, () => false) }),
    });
    expect(await main(['run', 'shop', '--jsonl'], io)).toBe(ExitCode.Unresolved);
    expect(io.out()).toBe('');
    expect(io.err()).toContain('price');
  });

  it('warns and exits 0 when a required field is missing on some rows', async () => {
    const dir = await home();
    const io = testIo({
      env: { ...DISPLAY, WEBSCOOP_HOME: dir },
      browser: new FakeBrowser({ [PAGE]: shopPage(3, (i) => i !== 1) }),
    });
    expect(await main(['run', 'shop'], io)).toBe(ExitCode.Ok);
    expect(JSON.parse(io.out())[1].price).toBeNull();
    expect(io.err()).toMatch(/warning: .*price.*row 1/);
  });

  it('prints the full report with --report', async () => {
    const dir = await home();
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shopPage(2) }) });
    expect(await main(['run', 'shop', '--report'], io)).toBe(ExitCode.Ok);
    expect(io.err()).toContain('"rowCount": 2');
    expect(io.err()).toContain('"candidateIndex": 0');
  });

  it('exits 1 when the profile is locked by another process', async () => {
    const dir = await home();
    await mkdir(join(dir, 'profiles', 'shop'), { recursive: true });
    await writeFile(join(dir, 'profiles', 'shop', '.webscoop.lock'), `${process.ppid}\n`);
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shopPage(1) }) });
    expect(await main(['run', 'shop', '--lock-timeout', '100'], io)).toBe(ExitCode.Error);
    expect(io.err()).toContain('profile "shop" is locked by process');
    expect(io.browserCreated()).toBe(0);
  });

  it('closes the browser, releases the lock, and exits 1 on interrupt', async () => {
    const dir = await home();
    const browser = new FakeBrowser({ [PAGE]: { dom: shopPage(1), delayMs: 0 } });
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    const originalOpen = browser.open.bind(browser);
    browser.open = async (profileDir) => {
      const session = await originalOpen(profileDir);
      io.interrupt();
      return session;
    };
    expect(await main(['run', 'shop'], io)).toBe(ExitCode.Error);
    expect(io.err()).toContain('interrupted');
    expect(browser.openSessions).toBe(0);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(dir, 'profiles', 'shop', '.webscoop.lock'))).toBe(false);
  });
});

describe('webscoop recipes', () => {
  it('prints nothing for an empty directory', async () => {
    const dir = await tempDir();
    const io = testIo({ env: { WEBSCOOP_HOME: dir } });
    expect(await main(['recipes'], io)).toBe(ExitCode.Ok);
    expect(io.out()).toBe('');
    const json = testIo({ env: { WEBSCOOP_HOME: dir } });
    expect(await main(['recipes', '--json'], json)).toBe(ExitCode.Ok);
    expect(json.out()).toBe('');
  });

  it('lists two recipes as a table and as JSON', async () => {
    const dir = await home([recipe(), recipe({ name: 'books', url: 'https://books.test/', vars: [] , item: undefined, fields: [{ name: 'h', type: 'text', scope: 'page', selectors: [{ strategy: 'css', value: 'h1', stability: 'medium' }] }] })]);
    const when = new Date('2026-01-02T03:04:05Z');
    await utimes(join(dir, 'recipes', 'books.json'), when, when);
    const io = testIo({ env: { WEBSCOOP_HOME: dir } });
    expect(await main(['recipes'], io)).toBe(ExitCode.Ok);
    const lines = io.out().trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^NAME\s+FIELDS\s+MODIFIED\s+URL$/);
    expect(lines[1]).toMatch(/^books\s+1\s+2026-01-02T03:04:05Z\s+https:\/\/books\.test\/$/);
    expect(lines[2]).toMatch(/^shop\s+3\s+/);

    const json = testIo({ env: { WEBSCOOP_HOME: dir } });
    expect(await main(['recipes', '--json'], json)).toBe(ExitCode.Ok);
    const list = JSON.parse(json.out());
    expect(list.map((r: { name: string }) => r.name)).toEqual(['books', 'shop']);
    expect(list[0]).toMatchObject({ url: 'https://books.test/', fields: 1, modified: '2026-01-02T03:04:05.000Z' });
  });
});

describe('webscoop doctor', () => {
  it('prints the isolated paths and exits 0 when everything is present', async () => {
    const dir = await tempDir();
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
    expect(await main(['doctor'], io)).toBe(ExitCode.Ok);
    expect(io.out()).toContain(join(dir, 'recipes'));
    expect(io.out()).toContain(join(dir, 'profiles'));
    expect(io.out()).toContain(join(dir, 'config.json'));
    expect(io.out()).toContain('WAYLAND_DISPLAY=wayland-1');
    expect(io.out()).toContain('llm         not configured');
  });

  it('exits 1 without a display', async () => {
    const dir = await tempDir();
    const io = testIo({ env: { WEBSCOOP_HOME: dir } });
    expect(await main(['doctor'], io)).toBe(ExitCode.Error);
    expect(io.out()).toMatch(/display\s+missing/);
  });

  it('exits 1 when Chromium is missing', async () => {
    const dir = await tempDir();
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, chromium: { installed: false, error: 'not found' } });
    expect(await main(['doctor'], io)).toBe(ExitCode.Error);
    expect(io.out()).toMatch(/chromium\s+missing/);
  });

  it('reports the configured LLM endpoint', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'config.json'), JSON.stringify({ llm: { endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen3.5:9b' } }));
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
    expect(await main(['doctor'], io)).toBe(ExitCode.Ok);
    expect(io.out()).toContain('http://127.0.0.1:11434/v1 (model qwen3.5:9b)');
  });
});

describe('webscoop', () => {
  it('exits 1 on bad arguments', async () => {
    const io = testIo({});
    expect(await main(['run'], io)).toBe(ExitCode.Error);
    expect(io.err()).toContain("missing required argument 'recipe'");
  });

  it('prints help with the exit code table', async () => {
    const io = testIo({});
    expect(await main(['--help'], io)).toBe(ExitCode.Ok);
    expect(io.out()).toContain('Exit codes:');
  });
});
