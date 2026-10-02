import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { saveRecipe, loadRecipe, type RecipeInput } from '@webscoop/core';
import { FakeBrowser, h } from '@webscoop/core/testing';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { tempDir, testIo } from './helpers';
import { doctorCommand } from '../src/commands/doctor';

const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };
const PAGE = 'https://shop.test/c/shoes';

function recipe(overrides: Partial<RecipeInput> = {}): RecipeInput {
  return {
    schemaVersion: 2, sequence: [{ extract: 'items' }],
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

  it('warns about an encoded --var value used in the URL and still runs', async () => {
    const dir = await home();
    const browser = new FakeBrowser({ 'https://shop.test/c/red%2520shoes': shopPage(1) });
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    expect(await main(['run', 'shop', '--var', 'category=red%20shoes'], io)).toBe(ExitCode.Ok);
    expect(io.err()).toContain('warning: --var category="red%20shoes" is URL-encoded again ("%" becomes "%25"); pass the decoded text "red shoes"');
    const test = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ 'https://shop.test/c/top%2Bllms': shopPage(1) }) });
    expect(await main(['test', 'shop', '--var', 'category=top+llms'], test)).toBe(ExitCode.Ok);
    expect(test.err()).toContain('warning: --var category="top+llms" is URL-encoded, so "+" stays a literal plus; for a space pass "top llms"');
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
    const rows = JSON.parse(io.out());
    expect(rows).toHaveLength(2);
    expect(rows.every((row: { price: unknown }) => row.price !== null)).toBe(true);
    expect(io.err()).toMatch(/warning: dropped 1 row on page 1: .*price.*row 1/);
    expect(io.err()).toContain('1 row dropped for missing fields');
  });

  it('prints the full report with --report', async () => {
    const dir = await home();
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shopPage(2) }) });
    expect(await main(['run', 'shop', '--report'], io)).toBe(ExitCode.Ok);
    expect(io.err()).toContain('"rowCount": 2');
    expect(io.err()).toContain('"candidateIndex": 0');
  });

  it('prints only the rows with --quiet on a clean run', async () => {
    const dir = await home();
    const normal = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shopPage(3) }) });
    expect(await main(['run', 'shop'], normal)).toBe(ExitCode.Ok);
    const quiet = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shopPage(3) }) });
    expect(await main(['run', 'shop', '--quiet'], quiet)).toBe(ExitCode.Ok);
    expect(quiet.err()).toBe('');
    expect(quiet.out()).toBe(normal.out());
  });

  it('treats -q like --quiet', async () => {
    const dir = await home();
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shopPage(2) }) });
    expect(await main(['run', 'shop', '-q'], io)).toBe(ExitCode.Ok);
    expect(io.err()).toBe('');
    expect(JSON.parse(io.out())).toHaveLength(2);
  });

  it('still logs a failure with --quiet and exits 3', async () => {
    const dir = await home();
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shopPage(3, () => false) }) });
    expect(await main(['run', 'shop', '--quiet'], io)).toBe(ExitCode.Unresolved);
    expect(io.err()).toMatch(/run failed \(.*\).*price/s);
    expect(io.err()).not.toContain('running shop');
  });

  it('mutes dropped-row warnings and partial fields with --quiet', async () => {
    const dir = await home();
    const browser = () => new FakeBrowser({ [PAGE]: shopPage(3, (i) => i !== 1) });
    const normal = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: browser() });
    expect(await main(['run', 'shop', '--no-save'], normal)).toBe(ExitCode.Ok);
    expect(normal.err()).toMatch(/warning: dropped 1 row on page 1: .*price.*row 1/);
    expect(normal.err()).toMatch(/field price: partial/);
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: browser() });
    expect(await main(['run', 'shop', '--quiet'], io)).toBe(ExitCode.Ok);
    expect(io.err()).toBe('');
    expect(JSON.parse(io.out())).toHaveLength(2);
  });

  it('still logs guard lines with --quiet', async () => {
    const dir = await home();
    const login = 'https://shop.test/login?next=%2Fc%2Fshoes';
    const form = () => h('html', {}, h('body', {}, h('form', {}, h('input', { name: 'username' }), h('input', { type: 'password', name: 'password' }), h('button', {}, 'Sign in'))));
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: { dom: form(), redirect: login }, [login]: form() }) });
    expect(await main(['run', 'shop', '--quiet', '--guard-timeout', '0'], io)).toBe(ExitCode.Paused);
    expect(io.err()).toContain('guard login on page 1');
    expect(io.err()).toContain('waiting for you in the browser window');
    expect(io.err()).toContain('run paused and gave up waiting');
    expect(io.err()).not.toContain('page 1 loaded');
  });

  it('prints the report with --quiet --report and no informational lines', async () => {
    const dir = await home();
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shopPage(2) }) });
    expect(await main(['run', 'shop', '--quiet', '--report'], io)).toBe(ExitCode.Ok);
    expect(io.err()).toContain('"rowCount": 2');
    expect(io.err()).not.toContain('webscoop:');
  });

  it('rejects --quiet on test', async () => {
    const dir = await home();
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shopPage(1) }) });
    expect(await main(['test', 'shop', '--quiet'], io)).toBe(ExitCode.Error);
    expect(io.err()).toContain("unknown option '--quiet'");
    expect(io.browserCreated()).toBe(0);
  });

  it('waits in the queue while another process holds the profile, and gives up after --queue-timeout', async () => {
    const dir = await home();
    await mkdir(join(dir, 'profiles', 'shop'), { recursive: true });
    await writeFile(join(dir, 'profiles', 'shop', '.webscoop.lock'), `${process.ppid}\n`);
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shopPage(1) }) });
    expect(await main(['run', 'shop', '--queue-timeout', '300'], io)).toBe(ExitCode.Error);
    expect(io.err()).toContain('profile "shop" is locked by process');
    expect(io.err()).toContain('gave up after 300 ms waiting for profile "shop" (0 jobs ahead, waiting for its browser)');
    expect(io.browserCreated()).toBe(0);
  });

  it('no longer accepts --lock-timeout on run and test', async () => {
    const dir = await home();
    for (const command of ['run', 'test']) {
      const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
      expect(await main([command, 'shop', '--lock-timeout', '100'], io)).toBe(ExitCode.Error);
      expect(io.err()).toContain("unknown option '--lock-timeout'");
    }
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

describe('profile resolution in run', () => {
  async function runWith(profiles: unknown, recipes: RecipeInput[], args: string[] = [], page = PAGE) {
    const dir = await home(recipes);
    if (profiles) await writeFile(join(dir, 'config.json'), JSON.stringify({ profiles }));
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [page]: shopPage(1) }) });
    expect(await main(['run', recipes[0]!.name, ...args], io)).toBe(ExitCode.Ok);
    return io.err();
  }

  it('keeps the recipe name without profile config', async () => {
    expect(await runWith(undefined, [recipe()])).toContain('on profile "shop" (recipe name)');
  });

  it('uses the config default when no rule matches', async () => {
    expect(await runWith({ default: 'main', rules: [{ host: 'acme\\.com$', profile: 'acme' }] }, [recipe()])).toContain('on profile "main" (config default)');
  });

  it('uses a matching host rule', async () => {
    expect(await runWith({ rules: [{ name: '^nope$', profile: 'x' }, { host: '(^|\\.)shop\\.test$', profile: 'shops' }] }, [recipe()])).toContain('on profile "shops" (config rule 2)');
  });

  it('prefers the recipe pin over a rule, and the flag over the pin', async () => {
    const rules = { rules: [{ host: 'shop\\.test$', profile: 'shops' }] };
    expect(await runWith(rules, [recipe({ browser: { profile: 'personal' } })])).toContain('on profile "personal" (recipe)');
    expect(await runWith(rules, [recipe({ browser: { profile: 'personal' } })], ['--profile', 'scratch'])).toContain('on profile "scratch" (flag)');
  });

  it('matches the host filled from --var', async () => {
    const r = recipe({ url: 'https://{site}/c/shoes', vars: [{ name: 'site', type: 'string' }] });
    const err = await runWith({ rules: [{ host: 'acme\\.com$', profile: 'acme' }] }, [r], ['--var', 'site=shop.acme.com'], 'https://shop.acme.com/c/shoes');
    expect(err).toContain('on profile "acme" (config rule 1)');
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
    expect(lines[0]).toMatch(/^NAME\s+FIELDS\s+MODIFIED\s+DESCRIPTION\s+URL$/);
    expect(lines[1]).toMatch(/^books\s+1\s+2026-01-02T03:04:05Z\s+https:\/\/books\.test\/$/);
    expect(lines[2]).toMatch(/^shop\s+3\s+/);

    const json = testIo({ env: { WEBSCOOP_HOME: dir } });
    expect(await main(['recipes', '--json'], json)).toBe(ExitCode.Ok);
    const list = JSON.parse(json.out());
    expect(list.map((r: { name: string }) => r.name)).toEqual(['books', 'shop']);
    expect(list[0]).toMatchObject({ url: 'https://books.test/', fields: 1, modified: '2026-01-02T03:04:05.000Z' });
    expect(list[1].tables).toEqual([{ name: 'items', fields: [{ name: 'title', type: 'text' }, { name: 'price', type: 'number' }, { name: 'link', type: 'url' }] }]);
    expect(list[1].vars).toEqual([{ name: 'category', default: 'shoes' }]);
    expect('description' in list[1]).toBe(false);
  });

  it('shows the description: first line in the listing, full catalog in JSON', async () => {
    const { item: _item, fields: _fields, ...rest } = recipe();
    const bing: RecipeInput = {
      ...rest,
      name: 'bing-search',
      description: 'Bing web search results for a query\nOne row per organic result',
      url: 'https://bing.com/search?q={query}',
      vars: [{ name: 'query', type: 'string', description: 'search terms' }],
      sequence: [{ extract: 'results' }],
      tables: [
        {
          name: 'results',
          fields: [
            { name: 'title', type: 'text', selectors: [{ strategy: 'css', value: 'h2', stability: 'medium' }] },
            { name: 'link', type: 'url', selectors: [{ strategy: 'css', value: 'a', stability: 'medium' }] },
          ],
        },
      ],
    };
    const long = recipe({ name: 'long', description: 'x'.repeat(80) });
    const dir = await home([bing, long]);
    const io = testIo({ env: { WEBSCOOP_HOME: dir } });
    expect(await main(['recipes'], io)).toBe(ExitCode.Ok);
    const lines = io.out().trimEnd().split('\n');
    expect(lines[1]).toMatch(/\sBing web search results for a query\s+https:\/\/bing\.com/);
    expect(lines[2]).toContain(`${'x'.repeat(59)}…`);
    expect(lines[2]).not.toContain('x'.repeat(60));

    const json = testIo({ env: { WEBSCOOP_HOME: dir } });
    expect(await main(['recipes', '--json'], json)).toBe(ExitCode.Ok);
    const entry = JSON.parse(json.out())[0];
    expect(entry).toMatchObject({ name: 'bing-search', description: 'Bing web search results for a query\nOne row per organic result' });
    expect(entry.vars).toEqual([{ name: 'query', description: 'search terms' }]);
    expect(entry.tables).toEqual([{ name: 'results', fields: [{ name: 'title', type: 'text' }, { name: 'link', type: 'url' }] }]);
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
    const probe = async () => ({ reachable: true, modelFound: true, models: ['qwen3.5:9b'], latencyMs: 42 });
    expect(await doctorCommand(io, { probe })).toBe(ExitCode.Ok);
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
