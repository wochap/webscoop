import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRecipe } from '@webscoop/core';
import { dataset } from '@webscoop/playground';
import { expect, hasDisplay, test } from './fixtures';

test.skip(!hasDisplay, 'the CLI needs WAYLAND_DISPLAY or DISPLAY');

const RECIPE = 'playground-catalog';
const FIXTURES = join(resolve(fileURLToPath(new URL('.', import.meta.url)), '..'), 'packages/cli/fixtures/llm');
const mock = (tier: 3 | 4) => ({ WEBSCOOP_LLM_MOCK: join(FIXTURES, `tier${tier}.json`), WEBSCOOP_LLM_ENDPOINT: undefined, WEBSCOOP_LLM_MODEL: undefined });

interface TestRow {
  name: string;
  status: string;
  matches: number;
  outcome: { kind: string; rationale?: string };
  notes?: string[];
}

function expectedRows(baseUrl: string) {
  return dataset
    .map((p) => ({ title: p.title, price: p.price, url: new URL(p.url, baseUrl).href, image: new URL(p.image, baseUrl).href, rating: p.rating, category: p.category }))
    .sort((a, b) => a.url.localeCompare(b.url));
}

test('tier 3: the model rung heals the reference recipe and writes it back', async ({ scoop }) => {
  const result = await scoop.run(['run', RECIPE, '--var', 'tier=3'], mock(3));
  expect(result.code, result.stderr).toBe(0);
  const rows = (JSON.parse(result.stdout) as Record<string, unknown>[]).map(({ _page, _index, ...rest }) => rest);
  expect([...rows].sort((a, b) => String(a.url).localeCompare(String(b.url)))).toEqual(expectedRows(scoop.playground.url));
  expect(result.stderr).toMatch(/healed item: model: \S+ \(product card\)/);
  expect(result.stderr).toMatch(/healed price: model: \S+ \(price with currency\) \(was testid=price\)/);
  expect(result.stderr).toContain(`recipe written to ${scoop.recipePath}`);

  const saved = loadRecipe(await readFile(scoop.recipePath, 'utf8'));
  expect(saved.fields!.find((f) => f.name === 'price')!.selectors[0]!.value).toContain('data-qa="price"');

  // The written recipe works on tier 3 without the model.
  const again = await scoop.run(['run', RECIPE, '--var', 'tier=3', '--no-llm']);
  expect(again.code, again.stderr).toBe(0);
  expect(again.stderr).not.toContain('healed price');
});

test('tier 3: --no-llm leaves required fields missing and exits 3', async ({ scoop }) => {
  const before = await readFile(scoop.recipePath, 'utf8');
  const result = await scoop.run(['run', RECIPE, '--var', 'tier=3', '--no-llm'], mock(3));
  expect(result.code, result.stderr).toBe(3);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain('model:');
  expect(await readFile(scoop.recipePath, 'utf8')).toBe(before);
});

test('tier 4: the removed rating ends unresolved, nothing else is put in its place, exit 3', async ({ scoop }) => {
  const before = await readFile(scoop.recipePath, 'utf8');
  const check = await scoop.run(['test', RECIPE, '--var', 'tier=4', '--json'], mock(4));
  expect(check.code, check.stderr).toBe(3);
  const rows = JSON.parse(check.stdout) as TestRow[];
  const rating = rows.find((r) => r.name === 'rating')!;
  expect(rating).toMatchObject({ status: 'missing', matches: 0, outcome: { kind: 'unresolved' } });
  expect(rating.notes).toEqual(['model: no pick (no rating element on the card)']);
  for (const name of ['item', 'title', 'price', 'url', 'image', 'category']) {
    expect(rows.find((r) => r.name === name)!.status, name).not.toBe('missing');
  }
  expect(check.stderr).toContain('required field rating matched no element');

  const run = await scoop.run(['run', RECIPE, '--var', 'tier=4'], mock(4));
  expect(run.code, run.stderr).toBe(3);
  expect(run.stdout).toBe('');
  expect(await readFile(scoop.recipePath, 'utf8')).toBe(before);
});

test('bench: tiers 0 and 1 resolve every field by candidate on tier 0', async ({ scoop }) => {
  const before = await readFile(scoop.recipePath, 'utf8');
  const result = await scoop.run(['bench', RECIPE, '--tiers', '0-1'], mock(3));
  expect(result.code, result.stderr).toBe(0);
  const lines = result.stdout.trimEnd().split('\n');
  expect(lines[0]).toMatch(/^TIER +FIELD +RUNG +STATUS +TIME$/);
  const cells = lines.slice(1).map((l) => l.split(/\s+/));
  const tier0 = cells.filter((c) => c[0] === '0');
  expect(tier0.map((c) => c[1])).toEqual(['item', 'title', 'price', 'url', 'image', 'rating', 'category']);
  for (const c of tier0) expect(c[2], c[1]).toBe('candidate');
  expect(cells.filter((c) => c[0] === '1')).toHaveLength(7);
  expect(await readFile(scoop.recipePath, 'utf8')).toBe(before);
});
