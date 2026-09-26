import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
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
const FIXTURE_NAMES = ['playground-catalog', 'playground-positional', 'playground-paged', 'playground-steps'] as const;

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
    expect(plan.item!.within).toEqual([
      { strategy: 'role', value: 'list' },
      { strategy: 'css', value: 'ul.product-list' },
    ]);
    expect(plan.fields[0]!.selectors[0]).toEqual({ strategy: 'class', value: 'h2.product-title' });
    expect('within' in buildPlan(fixture('playground-catalog')).item!).toBe(false);
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
    expect(plan.item).toEqual({
      selectors: [
        { strategy: 'testid', value: 'product-card' },
        { strategy: 'css', value: 'article.product-card' },
      ],
      exclude: [],
    });
    expect(plan.fields.map((f) => [f.name, f.scope, f.read, f.attr])).toEqual([
      ['title', 'item', 'text', null],
      ['price', 'item', 'text', null],
      ['url', 'item', 'attr', 'href'],
      ['image', 'item', 'attr', 'src'],
      ['rating', 'item', 'text', null],
      ['category', 'page', 'text', null],
    ]);
    expect(plan.key).toBe('url');
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

  it('keeps positional xpath candidates as they are', () => {
    const plan = buildPlan(fixture('playground-positional'));
    expect(plan.item!.selectors).toEqual([{ strategy: 'xpath', value: '//ul/li/article' }]);
    expect(plan.fields.map((f) => f.selectors[0])).toEqual([
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
const FIELDS = ${JSON.stringify(DEDUP_FIELDS.map((name) => ({ name })))} as unknown as Field[];
const KEY_FIELD: string | null = ${JSON.stringify(key)};
const input = JSON.parse(process.argv[2]!) as { conversions: [FieldType, string][]; pages: Row[][] };
const seen = new Set<string>();
const pages = input.pages.map((rows, i) => {
  const { kept, keys } = dedupRows(rows, i + 1, seen);
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
FIELDS = ${JSON.stringify(DEDUP_FIELDS.map((name) => ({ name })))}
KEY_FIELD = ${key === null ? 'None' : JSON.stringify(key)}
data = json.loads(sys.argv[1])
seen = set()
pages = []
for i, rows in enumerate(data["pages"]):
    kept, keys = dedup_rows(rows, i + 1, seen)
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
    expect(out).toContain('KEY_FIELD = "url"');
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
