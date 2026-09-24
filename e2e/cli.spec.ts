import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecipeInput } from '@webscoop/core';
import { dataset } from '@webscoop/playground';
import { expect, hasDisplay, REFERENCE_RECIPE, test, type Scoop } from './fixtures';

test.skip(!hasDisplay, 'the CLI needs WAYLAND_DISPLAY or DISPLAY');

const RECIPE = 'playground-catalog';

/** Processes whose command line mentions the profile directory, i.e. a Chromium left behind. */
function processesUsing(profileDir: string): string[] {
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out.split('\n').filter((line) => line.includes(`--user-data-dir=${profileDir}`));
}

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

function variant(scoop: Scoop, name: string, change: (r: RecipeInput) => void): RecipeInput {
  const recipe = structuredClone(scoop.recipe);
  recipe.name = name;
  change(recipe);
  return recipe;
}

test('rows equal the dataset on every recipe field', async ({ scoop }) => {
  const result = await scoop.run(['run', RECIPE]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(expectedRows(scoop.playground.url));
  expect(result.stderr).toMatch(/24 rows from 1 page in \d+\.\d+s/);
  expect(processesUsing(join(scoop.home, 'profiles', RECIPE))).toEqual([]);
});

test('--jsonl streams one row per line', async ({ scoop }) => {
  const result = await scoop.run(['run', RECIPE, '--jsonl']);
  expect(result.code, result.stderr).toBe(0);
  const lines = result.stdout.trimEnd().split('\n');
  expect(lines).toHaveLength(24);
  expect(lines.map((l) => JSON.parse(l))).toEqual(expectedRows(scoop.playground.url));
});

test('--out writes the file instead of stdout', async ({ scoop }) => {
  const out = join(scoop.home, 'out', 'rows.json');
  const result = await scoop.run(['run', RECIPE, '--out', out]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('');
  expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(expectedRows(scoop.playground.url));
});

test('the reference recipe runs by path', async ({ scoop }) => {
  const result = await scoop.run(['run', REFERENCE_RECIPE, '--var', `port=${scoop.playground.port}`]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toHaveLength(24);
});

test('a missing --var exits 1 and names the variable', async ({ scoop }) => {
  const name = await scoop.writeRecipe(
    variant(scoop, 'needs-port', (r) => {
      r.vars = r.vars!.map((v) => (v.name === 'port' ? { name: 'port', type: 'string' } : v));
    }),
  );
  const result = await scoop.run(['run', name]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('port');
  expect(result.stdout).toBe('');
});

test('a required field missing everywhere exits 3 with no rows', async ({ scoop }) => {
  const name = await scoop.writeRecipe(
    variant(scoop, 'price-gone', (r) => {
      const price = r.fields.find((f) => f.name === 'price')!;
      price.selectors = [{ strategy: 'testid', value: 'no-such-price', stability: 'stable' }];
      // Without a fingerprint no healing rung can find it either.
      delete price.fingerprint;
    }),
  );
  const result = await scoop.run(['run', name, '--jsonl']);
  expect(result.code).toBe(3);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('price');
});

test('an optional field missing yields null and exit 0', async ({ scoop }) => {
  const name = await scoop.writeRecipe(
    variant(scoop, 'with-badge', (r) => {
      r.fields.push({
        name: 'badge',
        type: 'text',
        scope: 'item',
        selectors: [{ strategy: 'css', value: '.badge', stability: 'medium' }],
        optional: true,
      });
    }),
  );
  const result = await scoop.run(['run', name]);
  expect(result.code, result.stderr).toBe(0);
  const rows = JSON.parse(result.stdout) as Record<string, unknown>[];
  expect(rows).toHaveLength(24);
  expect(rows.every((row) => row.badge === null)).toBe(true);
});

test('a cookie persists across two runs on one profile', async ({ scoop }) => {
  const catalogCookies = () =>
    scoop.playground.requests.filter((r) => r.path === '/catalog').map((r) => r.cookie);
  const first = await scoop.run(['run', RECIPE]);
  expect(first.code, first.stderr).toBe(0);
  expect(catalogCookies()).toEqual([undefined]);
  const second = await scoop.run(['run', RECIPE]);
  expect(second.code, second.stderr).toBe(0);
  expect(catalogCookies()[1]).toMatch(/ws_visitor=v1/);
});

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('a second concurrent run on one profile exits 1', async ({ scoop }) => {
  scoop.playground.control.delayMs = 4000;
  const lockFile = join(scoop.home, 'profiles', RECIPE, '.webscoop.lock');
  const first = scoop.spawn(['run', RECIPE]);
  await waitFor(() => existsSync(lockFile));
  const second = await scoop.run(['run', RECIPE, '--lock-timeout', '500']);
  expect(second.code).toBe(1);
  expect(second.stderr).toContain(`profile "${RECIPE}"`);
  expect(second.stderr).toContain(String(first.child.pid));
  const firstResult = await first.done;
  expect(firstResult.code, firstResult.stderr).toBe(0);
  expect(existsSync(lockFile)).toBe(false);
});

test('SIGINT closes the browser, releases the lock, and exits 1', async ({ scoop }) => {
  scoop.playground.control.delayMs = 10_000;
  const lockFile = join(scoop.home, 'profiles', RECIPE, '.webscoop.lock');
  const run = scoop.spawn(['run', RECIPE]);
  await waitFor(() => scoop.playground.requests.some((r) => r.path === '/catalog'));
  run.child.kill('SIGINT');
  const result = await run.done;
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('interrupted');
  expect(result.stdout).toBe('');
  expect(existsSync(lockFile)).toBe(false);
  expect(processesUsing(join(scoop.home, 'profiles', RECIPE))).toEqual([]);
});
