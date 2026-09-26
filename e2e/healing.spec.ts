import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRecipe, type RecipeInput } from '@webscoop/core';
import { dataset } from '@webscoop/playground';
import { expect, hasDisplay, test, type Scoop } from './fixtures';

test.skip(!hasDisplay, 'the CLI needs WAYLAND_DISPLAY or DISPLAY');

const RECIPE = 'playground-catalog';
const POSITIONAL = join(resolve(fileURLToPath(new URL('.', import.meta.url)), '..'), 'packages/cli/fixtures/playground-positional.json');

function expectedRows(baseUrl: string) {
  return dataset.map((p, index) => ({
    _page: 1,
    _index: index,
    title: p.title,
    price: p.price,
    url: new URL(p.url, baseUrl).href,
    image: new URL(p.image, baseUrl).href,
    rating: p.rating,
    category: p.category,
  }));
}

function chromiumUsing(profileDir: string): string[] {
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out.split('\n').filter((line) => line.includes(`--user-data-dir=${profileDir}`));
}

/** A copy of the reference recipe under another name, changed. */
function variant(scoop: Scoop, name: string, change: (r: RecipeInput) => void): RecipeInput {
  const recipe = structuredClone(scoop.recipe);
  recipe.name = name;
  change(recipe);
  return recipe;
}

/** The price field matches nothing and has no fingerprint, so no rung can heal it. */
const deadPrice = (r: RecipeInput) => {
  const price = r.fields!.find((f) => f.name === 'price')!;
  price.selectors = [{ strategy: 'css', value: '.gone-price', stability: 'medium' }];
  delete price.fingerprint;
};

interface TestRow {
  name: string;
  status: string;
  outcome: { kind: string; index?: number };
}

test('tier 1: the reference recipe heals, writes back, and the next run needs no healing', async ({ scoop }) => {
  const before = loadRecipe(await readFile(scoop.recipePath, 'utf8'));
  const first = await scoop.run(['run', RECIPE, '--var', 'tier=1']);
  expect(first.code, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout)).toEqual(expectedRows(scoop.playground.url));
  expect(first.stderr).toMatch(/24 rows from 1 page, 6 healed in/);
  for (const name of ['item', 'price', 'rating', 'image', 'category']) expect(first.stderr).toMatch(new RegExp(`healed ${name}: fuzzy [01]\\.\\d\\d`));
  expect(first.stderr).toContain('healed url: candidate 1: role=link|View details');
  expect(first.stderr).toContain(`recipe written to ${scoop.recipePath}`);

  const after = loadRecipe(await readFile(scoop.recipePath, 'utf8'));
  const price = after.fields!.find((f) => f.name === 'price')!;
  expect(price.selectors[0]!.value).not.toBe('price');
  expect(price.selectors.map((s) => s.value)).not.toContain('.product-price');
  expect(after.fields!.find((f) => f.name === 'title')).toEqual(before.fields!.find((f) => f.name === 'title'));
  expect(after.guards).toEqual(before.guards);

  const check = await scoop.run(['test', RECIPE, '--var', 'tier=1', '--json']);
  expect(check.code, check.stderr).toBe(0);
  const rows = JSON.parse(check.stdout) as TestRow[];
  expect(rows.map((r) => [r.name, r.status, r.outcome.kind, r.outcome.index])).toEqual(
    ['item', 'title', 'price', 'url', 'image', 'rating', 'category'].map((name) => [name, 'ok', 'candidate', 0]),
  );

  const second = await scoop.run(['run', RECIPE, '--var', 'tier=1']);
  expect(second.code, second.stderr).toBe(0);
  expect(JSON.parse(second.stdout)).toEqual(expectedRows(scoop.playground.url));
  expect(second.stderr).not.toContain('healed');
  expect(second.stderr).not.toContain('recipe written');
});

test('tier 1: a recipe loaded by path is written back to that path', async ({ scoop }) => {
  const file = join(scoop.home, 'elsewhere.json');
  await writeFile(file, readFileSync(scoop.recipePath, 'utf8'));
  const inDir = await readFile(scoop.recipePath, 'utf8');
  const result = await scoop.run(['run', file, '--var', 'tier=1']);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toContain(`recipe written to ${file}`);
  expect(await readFile(file, 'utf8')).not.toBe(inDir);
  expect(await readFile(scoop.recipePath, 'utf8')).toBe(inDir);
});

test('tier 2: a positional-only recipe heals title, price, and url by fingerprint', async ({ scoop }) => {
  const recipe = JSON.parse(readFileSync(POSITIONAL, 'utf8')) as RecipeInput;
  recipe.vars = recipe.vars!.map((v) => (v.name === 'port' ? { ...v, default: String(scoop.playground.port) } : v));
  await scoop.writeRecipe(recipe);
  const result = await scoop.run(['run', recipe.name, '--var', 'tier=2', '--no-save']);
  expect(result.code, result.stderr).toBe(0);
  for (const name of ['title', 'price', 'url']) expect(result.stderr).toMatch(new RegExp(`healed ${name}: fuzzy [01]\\.\\d\\d`));
  const rows = (JSON.parse(result.stdout) as { title: string; price: number; url: string }[]).map(({ title, price, url }) => ({ title, price, url }));
  const expected = dataset.map((p) => ({ title: p.title, price: p.price, url: new URL(p.url, scoop.playground.url).href }));
  expect([...rows].sort((a, b) => a.url.localeCompare(b.url))).toEqual(expected);
});

test('tier 1: --no-save keeps the file, --no-heal exits 3', async ({ scoop }) => {
  const before = await readFile(scoop.recipePath, 'utf8');
  const noSave = await scoop.run(['run', RECIPE, '--var', 'tier=1', '--no-save']);
  expect(noSave.code, noSave.stderr).toBe(0);
  expect(JSON.parse(noSave.stdout)).toHaveLength(24);
  expect(noSave.stderr).toContain('6 healed');
  expect(await readFile(scoop.recipePath, 'utf8')).toBe(before);

  const noHeal = await scoop.run(['run', RECIPE, '--var', 'tier=1', '--no-heal']);
  expect(noHeal.code, noHeal.stderr).toBe(3);
  expect(noHeal.stdout).toBe('');
  expect(await readFile(scoop.recipePath, 'utf8')).toBe(before);
});

test('test: exit 0 with a table on tier 0, exit 3 and no rows for a dead required field', async ({ scoop }) => {
  const ok = await scoop.run(['test', RECIPE]);
  expect(ok.code, ok.stderr).toBe(0);
  const lines = ok.stdout.trimEnd().split('\n');
  expect(lines[0]).toMatch(/^FIELD +STATUS +MATCHES +RESOLVED BY$/);
  expect(lines.slice(1).map((l) => l.split(/\s+/).slice(0, 3))).toEqual([
    ['item', 'ok', '24'],
    ['title', 'ok', '24/24'],
    ['price', 'ok', '24/24'],
    ['url', 'ok', '24/24'],
    ['image', 'ok', '24/24'],
    ['rating', 'ok', '24/24'],
    ['category', 'ok', '24/24'],
  ]);

  const name = await scoop.writeRecipe(variant(scoop, 'dead-price', deadPrice));
  const dead = await scoop.run(['test', name, '--json']);
  expect(dead.code, dead.stderr).toBe(3);
  const rows = JSON.parse(dead.stdout) as TestRow[];
  expect(rows.find((r) => r.name === 'price')).toMatchObject({ status: 'missing', outcome: { kind: 'unresolved' } });
  expect(dead.stdout).not.toContain('Wireless Mouse');
});

test('run --interactive: re-pick the price in the panel and the run finishes with full rows', async ({ scoop }) => {
  const name = await scoop.writeRecipe(variant(scoop, 'repick-run', deadPrice));
  const r = await scoop.interactiveRun([name]);
  const waiting = await r.until((s) => s.host?.repickContext);
  expect(waiting).toMatchObject({ field: 'price', reason: 'run', oldSelector: { value: '.gone-price' } });
  expect(await r.query('[data-ws="repick-prompt"]')).toMatchObject({ text: expect.stringContaining('Click the new location of price') });
  await r.pick('p.product-price', 2);
  await r.until((s) => s.host?.repickContext?.picked);
  await r.clickPanel('[data-ws="repick-confirm"]');
  const result = await r.run.done;
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(expectedRows(scoop.playground.url));
  expect(result.stderr).toContain('re-picked price: testid=price');
  expect(result.stderr).toContain('healed price: re-picked: testid=price');
  const saved = loadRecipe(await readFile(join(scoop.home, 'recipes', `${name}.json`), 'utf8'));
  expect(saved.fields!.find((f) => f.name === 'price')!.selectors[0]).toEqual({ strategy: 'testid', value: 'price', stability: 'stable' });
});

test('record --repick: the new selection is saved into the recipe', async ({ scoop }) => {
  const name = await scoop.writeRecipe(variant(scoop, 'repick-cli', deadPrice));
  const r = await scoop.record(['--edit', name, '--repick', 'price']);
  const ctx = await r.until((s) => s.host?.repickContext);
  expect(ctx).toMatchObject({ field: 'price', reason: 'cli' });
  await r.pick('p.product-price', 4);
  const picked = await r.until((s) => s.host?.repickContext?.picked);
  expect(picked.selector).toEqual({ strategy: 'testid', value: 'price', stability: 'stable' });
  await r.clickPanel('[data-ws="repick-confirm"]');
  const result = await r.run.done;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toContain('saved the new location of price');
  const saved = loadRecipe(await readFile(join(scoop.home, 'recipes', `${name}.json`), 'utf8'));
  const price = saved.fields!.find((f) => f.name === 'price')!;
  expect(price.selectors[0]).toEqual({ strategy: 'testid', value: 'price', stability: 'stable' });
  expect(price.selectors.map((s) => s.value)).not.toContain('.gone-price');
  expect(price.fingerprint?.textSample).toBe('$249.99');
});

test.describe('interactive run fixture', () => {
  test.describe.configure({ mode: 'serial' });
  let seen: { pid: number; profile: string } | undefined;

  test('starts run --interactive with a DevTools port and attaches to the re-pick panel', async ({ scoop }) => {
    const name = await scoop.writeRecipe(variant(scoop, 'repick-teardown', deadPrice));
    const r = await scoop.interactiveRun([name]);
    await r.until((s) => s.host?.repickContext);
    const profile = join(scoop.home, 'profiles', name);
    expect(chromiumUsing(profile).length).toBeGreaterThan(0);
    seen = { pid: r.run.child.pid!, profile };
    // Left running on purpose: the fixture must tear it down.
  });

  test('tears down the child and its browser', async () => {
    expect(seen).toBeDefined();
    expect(() => process.kill(seen!.pid, 0)).toThrow();
    await expect.poll(() => chromiumUsing(seen!.profile), { timeout: 10_000 }).toEqual([]);
  });
});
