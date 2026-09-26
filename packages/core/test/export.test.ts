import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startPlayground, type Playground } from '@webscoop/playground';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildPlan,
  convertValue,
  Dedup,
  EXCLUDED_BEHAVIORS,
  header,
  loadRecipe,
  parseDate,
  parseNumber,
  PY_PRELUDE,
  RecipeSchema,
  renderPy,
  renderTs,
  TS_PRELUDE,
  type ExportPlan,
  type FieldType,
  type Recipe,
  type Row,
  tablesOf,
} from '../src';

const run = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const FIXTURES = join(ROOT, 'packages/cli/fixtures');
const NOW = new Date('2026-01-02T03:04:05.000Z');
const OPTS = { version: '0.0.0-test', now: NOW };

const fixture = (name: string): Recipe => loadRecipe(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
const FIXTURE_NAMES = ['playground-catalog', 'playground-positional', 'playground-paged', 'playground-steps', 'playground-tables'] as const;

/** Scratch files inside the repository, so `playwright` resolves from the generated code. */
const scratch: string[] = [];
async function scratchDir(): Promise<string> {
  await mkdir(join(ROOT, 'test-results'), { recursive: true });
  const dir = await mkdtemp(join(ROOT, 'test-results', 'export-unit-'));
  scratch.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

const hasPython = (() => {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** The catalog recipe with a list parent and a class candidate on the title. */
function withinRecipe(): Recipe {
  const recipe = fixture('playground-catalog');
  return {
    ...recipe,
    name: 'playground-within',
    item: {
      ...recipe.item!,
      within: [
        { strategy: 'role', value: 'list', stability: 'stable' },
        { strategy: 'css', value: 'ul.product-list', stability: 'medium' },
      ],
    },
    fields: recipe.fields!.map((f) => (f.name === 'title' ? { ...f, selectors: [{ strategy: 'class', value: 'h2.product-title', stability: 'medium' }, ...f.selectors] } : f)),
  };
}

describe('buildPlan', () => {
  it('carries the list parent and class candidates, and leaves within out without one', () => {
    const plan = buildPlan(withinRecipe());
    const [table] = plan.tables;
    expect(table!.item!.within).toEqual([
      { strategy: 'role', value: 'list' },
      { strategy: 'css', value: 'ul.product-list' },
    ]);
    expect(table!.fields[0]!.selectors[0]).toEqual({ strategy: 'class', value: 'h2.product-title' });
    expect('within' in buildPlan(fixture('playground-catalog')).tables[0]!.item!).toBe(false);
    const ts = renderTs(plan, OPTS);
    expect(ts).toContain('"within": [');
    expect(ts).toContain("case 'class':");
    expect(renderPy(plan, OPTS)).toContain('"within": [');
  });

  it('resolves the catalog recipe: attribute defaults, read modes, key, and no pagination', () => {
    const plan = buildPlan(fixture('playground-catalog'));
    expect(plan.recipe).toBe('playground-catalog');
    expect(plan.vars).toEqual([
      { name: 'port', default: '4777', required: true },
      { name: 'tier', default: '0', required: true },
    ]);
    expect(plan.tables).toHaveLength(1);
    expect(plan.primary).toBe(0);
    const [table] = plan.tables;
    expect(table!.name).toBe('items');
    expect(table!.item).toEqual({
      selectors: [
        { strategy: 'testid', value: 'product-card' },
        { strategy: 'css', value: 'article.product-card' },
      ],
      exclude: [],
    });
    expect(table!.fields.map((f) => [f.name, f.scope, f.read, f.attr])).toEqual([
      ['title', 'item', 'text', null],
      ['price', 'item', 'text', null],
      ['url', 'item', 'attr', 'href'],
      ['image', 'item', 'attr', 'src'],
      ['rating', 'item', 'text', null],
      ['category', 'page', 'text', null],
    ]);
    expect(table!.key).toBe('url');
    expect(plan.steps).toEqual([]);
    expect(plan.pagination).toEqual({
      kind: 'none',
      param: null,
      paramInTemplate: false,
      target: null,
      limit: 1,
      cap: 500,
      stopRules: [],
      delayMs: 0,
    });
    expect(plan.timings).toEqual({ navigationMs: 30_000, actionMs: 5000, settleGraceMs: 500, settleIdleMs: 2000, waitPollMs: 200, growthPollMs: 200 });
  });

  it('renders the same plan for a shorthand recipe and its one entry tables form', () => {
    const shorthand = fixture('playground-catalog');
    const { item, fields, ...rest } = shorthand;
    const tabled = loadRecipe({ ...rest, tables: [{ name: 'items', item, fields }] });
    expect(buildPlan(tabled)).toEqual(buildPlan(shorthand));
    expect(renderTs(buildPlan(tabled), OPTS)).toBe(renderTs(buildPlan(shorthand), OPTS));
    expect(renderPy(buildPlan(tabled), OPTS)).toBe(renderPy(buildPlan(shorthand), OPTS));
  });

  it('carries every table in recipe order with its own key and the primary table', () => {
    const plan = buildPlan(fixture('playground-tables'));
    expect(plan.tables.map((t) => [t.name, t.item !== null, t.key, t.fields.map((f) => f.name)])).toEqual([
      ['page', false, null, ['heading']],
      ['products', true, 'url', ['title', 'url']],
      ['questions', true, null, ['title', 'first_option']],
    ]);
    expect(plan.primary).toBe(1);
    expect(plan.tables[2]!.item).toEqual({ selectors: [{ strategy: 'css', value: 'article.mixed-questions' }], exclude: [] });
    // A recipe without any item table has no primary table.
    const pageOnly = fixture('playground-tables');
    expect(buildPlan({ ...pageOnly, tables: [pageOnly.tables![0]!] }).primary).toBe(-1);
  });

  it('keeps positional xpath candidates as they are', () => {
    const plan = buildPlan(fixture('playground-positional'));
    expect(plan.tables[0]!.item!.selectors).toEqual([{ strategy: 'xpath', value: '//ul/li/article' }]);
    expect(plan.tables[0]!.fields.map((f) => f.selectors[0])).toEqual([
      { strategy: 'xpath', value: './h2[1]' },
      { strategy: 'xpath', value: './p[1]' },
      { strategy: 'xpath', value: './a[1]' },
    ]);
  });

  it('resolves url pagination: the page variable is not required and sits in the template', () => {
    const plan = buildPlan(fixture('playground-paged'));
    expect(plan.vars.find((v) => v.name === 'page')).toEqual({ name: 'page', default: '1', required: false });
    expect(plan.pagination).toMatchObject({
      kind: 'url',
      param: { name: 'page', start: 1, step: 1 },
      paramInTemplate: true,
      limit: 'all',
      stopRules: ['no-new-items', 'target-missing'],
    });
    // The target only matters for next and more.
    expect(plan.pagination.target).toBeNull();
  });

  it('normalizes steps: labels, click targets, wait on a target versus a sleep', () => {
    const plan = buildPlan(fixture('playground-steps'));
    expect(plan.steps).toEqual([
      {
        index: 0,
        kind: 'click',
        name: 'accept cookies',
        when: 'first-page',
        optional: false,
        target: [
          { strategy: 'role', value: 'button|Accept all' },
          { strategy: 'id', value: 'consent-accept' },
          { strategy: 'css', value: 'button.consent-button' },
        ],
        action: { kind: 'click' },
      },
      { index: 1, kind: 'wait', name: 'step:1', when: 'first-page', optional: false, target: [{ strategy: 'testid', value: 'product-card' }], action: { kind: 'wait-for' } },
      { index: 2, kind: 'wait', name: 'step:2', when: 'first-page', optional: true, target: null, action: { kind: 'sleep', ms: 100 } },
    ]);
  });

  it('defaults press to Enter, keeps type values raw, and requires their variables', () => {
    const target = { selectors: [{ strategy: 'css' as const, value: 'input', stability: 'medium' as const }] };
    // Parsed without the cross-field checks, which ask a press step for its key.
    const recipe = RecipeSchema.parse({
      ...JSON.parse(readFileSync(join(FIXTURES, 'playground-catalog.json'), 'utf8')),
      url: 'https://shop.test/search',
      vars: [{ name: 'q', type: 'string' }],
      steps: [
        { kind: 'type', target, value: '{q} shoes' },
        { kind: 'press', target },
        { kind: 'select', target, value: 'price' },
      ],
    });
    const plan = buildPlan(recipe);
    expect(plan.vars).toEqual([{ name: 'q', default: null, required: true }]);
    expect(plan.steps.map((s) => s.action)).toEqual([{ kind: 'type', text: '{q} shoes' }, { kind: 'press', key: 'Enter' }, { kind: 'select', value: 'price' }]);
  });

  it('keeps next and more targets and marks variables without a default', () => {
    const base = JSON.parse(readFileSync(join(FIXTURES, 'playground-paged.json'), 'utf8'));
    const plan = buildPlan(
      loadRecipe({
        ...base,
        url: 'https://shop.test/{section}/list',
        vars: [{ name: 'section', type: 'string' }],
        pagination: { ...base.pagination, kind: 'next', limit: 3 },
      }),
    );
    expect(plan.vars).toEqual([{ name: 'section', default: null, required: true }]);
    expect(plan.pagination).toMatchObject({ kind: 'next', param: null, limit: 3 });
    expect(plan.pagination.target).toEqual([
      { strategy: 'role', value: 'link|Next' },
      { strategy: 'css', value: 'a.pager-next' },
    ]);
  });
});

describe('header', () => {
  it('names the recipe, the time, the version, and the six excluded behaviors', () => {
    const lines = header(buildPlan(fixture('playground-catalog')), OPTS);
    expect(lines).toEqual([
      'Standalone Playwright script exported from the webscoop recipe "playground-catalog".',
      'Exported at 2026-01-02T03:04:05.000Z by webscoop 0.0.0-test.',
      '',
      'It navigates, replays the recipe steps, extracts rows, and paginates like',
      '`webscoop run` on a healthy site. Selector candidates are tried in their',
      'stored order; nothing else heals. Not included:',
      '  - fingerprint healing',
      '  - model healing',
      '  - guards',
      '  - notifications',
      '  - window hiding',
      '  - recipe write-back',
      '',
      'When the site changes, re-record the recipe with webscoop and export it',
      'again rather than editing selectors here; the recipe is the source of truth.',
    ]);
    expect(EXCLUDED_BEHAVIORS).toHaveLength(6);
  });

  it('starts both scripts', () => {
    const plan = buildPlan(fixture('playground-catalog'));
    expect(renderTs(plan, OPTS).split('\n').slice(0, 2)).toEqual([
      '// Standalone Playwright script exported from the webscoop recipe "playground-catalog".',
      '// Exported at 2026-01-02T03:04:05.000Z by webscoop 0.0.0-test.',
    ]);
    expect(renderPy(plan, OPTS).split('\n')[0]).toBe('# Standalone Playwright script exported from the webscoop recipe "playground-catalog".');
  });
});

// ---------------------------------------------------------------------------
// Prelude parity: the generated conversion and dedup code against core.
// ---------------------------------------------------------------------------

const PAGE_URL = 'https://shop.test/c/shoes';
/** convert.test.ts cases plus the edges the generated code must not drift on. */
const CONVERSIONS: [FieldType, string][] = [
  ['number', '$1,299.00'],
  ['number', 'Rated 4.5 out of 5'],
  ['number', '-12 degrees'],
  ['number', 'free'],
  ['number', '-.5'],
  ['number', '1,234,567'],
  ['url', '/p/42'],
  ['image', 'img/a.png'],
  ['url', 'https://other.test/x'],
  ['url', '  '],
  ['url', ' ../up?q=a b#frag '],
  ['text', '\n  Wireless \t  Mouse \n'],
  ['text', ' non breaking﻿'],
  ['html', '  <b>x</b>\n'],
  ['date', '2024-03-05'],
  ['date', '2024-03-05T10:20:30Z'],
  ['date', '2024-03-05T10:20:30.123456Z'],
  ['date', '2024-03-05T10:20+0530'],
  ['date', '2024-03-05 10:20'],
  ['date', '2024-02-30T10:00Z'],
  ['date', '2024-03-05T24:00Z'],
  ['date', '2024-13-05T10:00Z'],
  ['date', '03/05/2024'],
  ['date', '05.03.2024'],
  ['date', 'March 5, 2024'],
  ['date', 'Sept. 5 2024'],
  ['date', '5 Mar 2024'],
  ['date', '0099-01-01'],
  ['date', ' last   Tuesday '],
  ['date', '2024-02-30'],
];

const DEDUP_FIELDS = ['title', 'price', 'url', 'category'];
const row = (page: number, title: string, price: number, url: string | null = null): Row => ({ _page: page, _index: 0, title, price, url, category: 'x' });
const DEDUP_PAGES: Row[][] = [
  [row(1, 'a', 1, '/1'), row(1, 'a', 1, '/1')],
  [row(2, 'a', 1, '/1'), row(2, 'a', 2, '/2'), row(2, 'a', 2, '/2'), row(2, 'b', 3, '/1')],
];

/** What core says for the cases: kept rows per page, with and without a key field. */
function coreDedup(key: string | null): Row[][] {
  const recipe = loadRecipe({
    schemaVersion: 1,
    name: 'shop',
    url: PAGE_URL,
    fields: DEDUP_FIELDS.map((name) => ({ name, type: 'text', scope: 'page', selectors: [{ strategy: 'css', value: name, stability: 'medium' }], ...(name === key ? { key: true } : {}) })),
  });
  const dedup = new Dedup(tablesOf(recipe)[0]!);
  return DEDUP_PAGES.map((rows, i) => {
    const preview = dedup.preview(rows, i + 1);
    preview.commit();
    return preview.kept;
  });
}

const coreConversions = () => CONVERSIONS.map(([type, raw]) => convertValue(type, raw, PAGE_URL));

describe('TypeScript prelude parity (through tsx)', () => {
  it('converts values and dedups rows exactly like core', async () => {
    const dir = await scratchDir();
    const harness = (key: string | null) => `${TS_PRELUDE}
const TABLE = { name: 'items', item: null, fields: ${JSON.stringify(DEDUP_FIELDS.map((name) => ({ name })))}, key: ${JSON.stringify(key)} } as unknown as Table;
const input = JSON.parse(process.argv[2]!) as { conversions: [FieldType, string][]; pages: Row[][] };
const seen = new Set<string>();
const pages = input.pages.map((rows, i) => {
  const { kept, keys } = dedupRows(TABLE, rows, i + 1, seen);
  for (const k of keys) seen.add(k);
  return kept;
});
const conversions = input.conversions.map(([type, raw]) => convertValue(type, raw, ${JSON.stringify(PAGE_URL)}));
process.stdout.write(JSON.stringify({ conversions, pages, numbers: ['x 1,5', 'none'].map(parseNumber), dates: ['1 jan 2020'].map(parseDate) }));
`;
    const input = JSON.stringify({ conversions: CONVERSIONS, pages: DEDUP_PAGES });
    for (const key of [null, 'url']) {
      const file = join(dir, `parity-${key ?? 'all'}.ts`);
      await writeFile(file, harness(key));
      const { stdout } = await run(join(ROOT, 'node_modules/.bin/tsx'), [file, input], { cwd: ROOT });
      const out = JSON.parse(stdout);
      expect(out.conversions).toEqual(coreConversions());
      expect(out.pages).toEqual(coreDedup(key));
      expect(out.numbers).toEqual(['x 1,5', 'none'].map(parseNumber));
      expect(out.dates).toEqual(['1 jan 2020'].map(parseDate));
    }
  }, 60_000);
});

/** Stand-in for the `playwright` package, so the prelude loads without it; `new URL` is done by Node. */
const PYTHON_STUB = String.raw`
import json, subprocess, sys, types
api = types.ModuleType("playwright.sync_api")
class _Error(Exception):
    pass
api.Error = _Error
api.TimeoutError = _Error
api.sync_playwright = None
sys.modules["playwright"] = types.ModuleType("playwright")
sys.modules["playwright.sync_api"] = api

class FakePage:
    """page.evaluate for the URL helpers, answered by Node with the same code."""
    def evaluate(self, code, arg):
        script = "const f = " + code + "; process.stdout.write(JSON.stringify(f(JSON.parse(process.argv[1]))))"
        return json.loads(subprocess.check_output(["node", "-e", script, json.dumps(arg)]))
`;

describe.skipIf(!hasPython)('Python prelude parity', () => {
  it('converts values and dedups rows exactly like core', async () => {
    const dir = await scratchDir();
    const input = JSON.stringify({ conversions: CONVERSIONS, pages: DEDUP_PAGES, url: PAGE_URL });
    for (const key of [null, 'url']) {
      const file = join(dir, `parity-${key ?? 'all'}.py`);
      await writeFile(
        file,
        `${PYTHON_STUB}\n${PY_PRELUDE}\n
TABLE = {"name": "items", "item": None, "fields": ${JSON.stringify(DEDUP_FIELDS.map((name) => ({ name })))}, "key": ${key === null ? 'None' : JSON.stringify(key)}}
data = json.loads(sys.argv[1])
seen = set()
pages = []
for i, rows in enumerate(data["pages"]):
    kept, keys = dedup_rows(TABLE, rows, i + 1, seen)
    seen.update(keys)
    pages.append(kept)
page = FakePage()
conversions = [convert_value(page, t, raw, data["url"]) for t, raw in data["conversions"]]
print(json.dumps({"conversions": conversions, "pages": pages}))
`,
      );
      const { stdout } = await run('python3', [file, input], { cwd: ROOT });
      const out = JSON.parse(stdout);
      expect(out.conversions).toEqual(coreConversions());
      expect(out.pages).toEqual(coreDedup(key));
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

const plans = (): [string, ExportPlan][] => [...FIXTURE_NAMES.map((name): [string, ExportPlan] => [name, buildPlan(fixture(name))]), ['playground-within', buildPlan(withinRecipe())]];

describe('renderTs', () => {
  it.each(FIXTURE_NAMES)('matches the snapshot for %s', async (name) => {
    await expect(renderTs(buildPlan(fixture(name)), OPTS)).toMatchFileSnapshot(`__snapshots__/export/${name}.ts.snap`);
  });

  it('emits the prelude once, the constants after it, and the headless default', () => {
    const plan = buildPlan(fixture('playground-paged'));
    const out = renderTs(plan, { ...OPTS, headless: true });
    expect(out.indexOf(TS_PRELUDE)).toBeGreaterThan(0);
    expect(out.indexOf('const RECIPE_NAME')).toBeGreaterThan(out.indexOf(TS_PRELUDE));
    expect(out).toContain('const DEFAULT_HEADLESS = true;');
    expect(out).toContain('const URL_TEMPLATE = "http://127.0.0.1:{port}/catalog?paginate={mode}&tier={tier}&page={page}";');
    expect(renderTs(plan, OPTS)).toContain('const DEFAULT_HEADLESS = false;');
  });

  it('type-checks with tsc --noEmit', async () => {
    const dir = await scratchDir();
    const files: string[] = [];
    for (const [name, plan] of plans()) {
      const file = join(dir, `${name}.ts`);
      await writeFile(file, renderTs(plan, OPTS));
      files.push(file);
    }
    const args = [
      '--noEmit',
      '--strict',
      '--noUncheckedIndexedAccess',
      '--target',
      'ES2023',
      '--lib',
      'ES2023,DOM',
      '--module',
      'esnext',
      '--moduleResolution',
      'bundler',
      '--types',
      'node',
      '--skipLibCheck',
      ...files,
    ];
    const result = await run(join(ROOT, 'node_modules/.bin/tsc'), args, { cwd: ROOT }).catch((error: { stdout: string }) => error);
    expect('stdout' in result ? result.stdout : '').toBe('');
  }, 90_000);
});

describe('renderPy', () => {
  it.each(FIXTURE_NAMES)('matches the snapshot for %s', async (name) => {
    await expect(renderPy(buildPlan(fixture(name)), OPTS)).toMatchFileSnapshot(`__snapshots__/export/${name}.py.snap`);
  });

  it('writes Python literals and the entry point', () => {
    const out = renderPy(buildPlan(fixture('playground-catalog')), { ...OPTS, headless: true });
    expect(out).toContain('DEFAULT_HEADLESS = True');
    expect(out).toContain('"key": "url"');
    expect(out).toContain('"attr": None');
    expect(out.slice(out.indexOf('# Recipe'))).not.toMatch(/\b(null|true|false)\b/);
    expect(out.trimEnd().endsWith('    sys.exit(main(sys.argv[1:]))')).toBe(true);
  });

  it.skipIf(!hasPython)('compiles with python3 -m py_compile', async () => {
    const dir = await scratchDir();
    for (const [name, plan] of plans()) {
      const file = join(dir, `${name.replace(/-/g, '_')}.py`);
      await writeFile(file, renderPy(plan, OPTS));
      await expect(run('python3', ['-m', 'py_compile', file])).resolves.toBeDefined();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Scripts run against the playground: tables, dedup per table, output shapes.
// ---------------------------------------------------------------------------

const hasDisplay = Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);
/** Interpreter for the Python scripts; `WEBSCOOP_E2E_PYTHON` points at one with Playwright installed. */
const PYTHON = process.env.WEBSCOOP_E2E_PYTHON?.trim() || 'python3';
const hasPythonPlaywright = (() => {
  try {
    execFileSync(PYTHON, ['-c', 'import playwright'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

type Format = 'ts' | 'py';
type Rows = Record<string, unknown>[];

/** The tables recipe on the plain catalog, where the questions blocks are absent. */
function plainTables(): Recipe {
  const recipe = fixture('playground-tables');
  return { ...recipe, name: 'plain-tables', url: 'http://127.0.0.1:{port}/catalog?tier={tier}' };
}

/** Tables `page` and `products` on the url paginated catalog, whose page 4 repeats page 3. */
function pagedTables(): Recipe {
  const { item, fields, ...paged } = fixture('playground-paged');
  const heading = fixture('playground-tables').tables![0]!;
  return loadRecipe({
    ...paged,
    name: 'paged-tables',
    url: `${paged.url}&lastPageRepeats=1`,
    tables: [heading, { name: 'products', item, fields }],
  });
}

describe.skipIf(!hasDisplay)('exported scripts on the playground (integration)', () => {
  let playground: Playground;
  beforeAll(async () => {
    playground = await startPlayground({ port: 0 });
  });
  afterAll(async () => {
    await playground?.stop();
  });

  /** Render the recipe, run it headless against the playground, and collect what it printed. */
  async function runScript(format: Format, recipe: Recipe, args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
    const dir = await scratchDir();
    const file = join(dir, `${recipe.name.replace(/-/g, '_')}.${format}`);
    await writeFile(file, (format === 'ts' ? renderTs : renderPy)(buildPlan(recipe), { ...OPTS, headless: true }));
    const [command, first] = format === 'ts' ? [join(ROOT, 'node_modules/.bin/tsx'), file] : [PYTHON, file];
    try {
      const { stdout, stderr } = await run(command, [first, '--var', `port=${playground.port}`, ...args], { cwd: ROOT, maxBuffer: 1 << 24 });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: unknown; stdout?: string; stderr?: string };
      return { code: typeof failed.code === 'number' ? failed.code : -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    }
  }

  for (const format of ['ts', 'py'] as const) {
    describe.skipIf(format === 'py' && !hasPythonPlaywright)(format === 'ts' ? 'TypeScript' : 'Python', () => {
      it('keeps the single table shapes for a shorthand recipe', async () => {
        const out = await runScript(format, fixture('playground-catalog'));
        expect(out.code, out.stderr).toBe(0);
        const rows = JSON.parse(out.stdout) as Rows;
        expect(rows).toHaveLength(24);
        expect(rows.map((row) => row._index)).toEqual([...Array(24).keys()]);
      }, 60_000);

      it('extracts three tables on the mixed catalog into one JSON object', async () => {
        const out = await runScript(format, fixture('playground-tables'));
        expect(out.code, out.stderr).toBe(0);
        const tables = JSON.parse(out.stdout) as Record<string, Rows>;
        expect(Object.keys(tables)).toEqual(['page', 'products', 'questions']);
        expect(tables.page).toEqual([{ _page: 1, _index: 0, heading: expect.any(String) }]);
        expect(tables.products).toHaveLength(24);
        expect(tables.products!.map((row) => row._index)).toEqual([...Array(24).keys()]);
        expect(tables.questions).toHaveLength(6);
        expect(tables.questions!.every((row) => row.title === 'People also ask' && row.first_option === 'Which one ships fastest?')).toBe(true);
        expect(tables.questions!.map((row) => row._index)).toEqual([...Array(6).keys()]);
      }, 60_000);

      it('marks JSONL rows with _table, and --table keeps one table in the plain shapes', async () => {
        const jsonl = await runScript(format, fixture('playground-tables'), ['--jsonl']);
        expect(jsonl.code, jsonl.stderr).toBe(0);
        const lines = jsonl.stdout.trimEnd().split('\n').map((line) => JSON.parse(line) as Rows[number]);
        expect(lines).toHaveLength(31);
        expect(Object.keys(lines[0]!)[0]).toBe('_table');
        expect(lines.map((line) => line._table)).toEqual(['page', ...Array(24).fill('products'), ...Array(6).fill('questions')]);

        const only = await runScript(format, fixture('playground-tables'), ['--table', 'questions']);
        expect(only.code, only.stderr).toBe(0);
        const rows = JSON.parse(only.stdout) as Rows;
        expect(rows).toHaveLength(6);
        expect(rows[0]).not.toHaveProperty('_table');

        const plain = await runScript(format, fixture('playground-tables'), ['--table', 'page', '--jsonl']);
        expect(plain.code, plain.stderr).toBe(0);
        expect(JSON.parse(plain.stdout)).toEqual({ _page: 1, _index: 0, heading: expect.any(String) });

        const unknown = await runScript(format, fixture('playground-tables'), ['--table', 'ads']);
        expect(unknown.code).toBe(1);
        expect(unknown.stdout).toBe('');
        expect(unknown.stderr).toMatch(/no table "ads" \(tables: page, products, questions\)/);
      }, 120_000);

      it('writes one file per table into a directory --out', async () => {
        const dir = await scratchDir();
        const target = join(dir, 'data') + '/';
        const out = await runScript(format, fixture('playground-tables'), ['--out', target]);
        expect(out.code, out.stderr).toBe(0);
        expect(out.stdout).toBe('');
        expect((await readdir(join(dir, 'data'))).sort()).toEqual(['page.json', 'products.json', 'questions.json']);
        expect(JSON.parse(await readFile(join(dir, 'data', 'products.json'), 'utf8'))).toHaveLength(24);

        // An existing directory without a trailing separator counts too.
        const jsonl = await runScript(format, fixture('playground-tables'), ['--out', join(dir, 'data'), '--jsonl', '--table', 'questions']);
        expect(jsonl.code, jsonl.stderr).toBe(0);
        const lines = (await readFile(join(dir, 'data', 'questions.jsonl'), 'utf8')).trimEnd().split('\n');
        expect(lines).toHaveLength(6);
        expect(JSON.parse(lines[0]!)).not.toHaveProperty('_table');
      }, 120_000);

      it('gives the page table one row per page and dedups the products table', async () => {
        const out = await runScript(format, pagedTables(), ['--pages', '4']);
        expect(out.code, out.stderr).toBe(0);
        const tables = JSON.parse(out.stdout) as Record<string, Rows>;
        // Page 4 repeats page 3: no new products, so the stop rule ends the run after it.
        expect(tables.page!.map((row) => row._page)).toEqual([1, 2, 3, 4]);
        expect(tables.products).toHaveLength(24);
        expect(new Set(tables.products!.map((row) => row.url)).size).toBe(24);
        expect(new Set(tables.products!.map((row) => row._page))).toEqual(new Set([1, 2, 3]));
        expect(out.stderr).toMatch(/pagination stopped after page 4: no-new-items/);
      }, 120_000);

      it('warns and yields no rows for an absent secondary table', async () => {
        const out = await runScript(format, plainTables());
        expect(out.code, out.stderr).toBe(0);
        const tables = JSON.parse(out.stdout) as Record<string, Rows>;
        expect(tables.products).toHaveLength(24);
        expect(tables.questions).toEqual([]);
        expect(out.stderr).toMatch(/warning: table "questions": the item container matched no element on page 1; the table yields no rows/);
      }, 60_000);

      it('exits 3 naming the table when a required field of a secondary table matches nothing', async () => {
        const recipe = fixture('playground-tables');
        const tables = recipe.tables!.map((t) =>
          t.name === 'questions'
            ? { ...t, fields: t.fields.map((f) => (f.name === 'first_option' ? { ...f, selectors: [{ strategy: 'css' as const, value: '.no-such-option', stability: 'medium' as const }] } : f)) }
            : t,
        );
        const out = await runScript(format, { ...recipe, name: 'dead-option', tables });
        expect(out.code, out.stderr).toBe(3);
        expect(out.stdout).toBe('');
        expect(out.stderr).toMatch(/table "questions": required field first_option matched no element/);
      }, 60_000);
    });
  }
});
