import { readFile } from 'node:fs/promises';
import type { RecipeInput } from '@webscoop/core';
import { dataset } from '@webscoop/playground';
import { expect, hasDisplay, PAGED_RECIPE, referenceRecipe, test, type Scoop } from './fixtures';

test.skip(!hasDisplay, 'the CLI needs WAYLAND_DISPLAY or DISPLAY');

type Kind = 'url' | 'next' | 'more' | 'scroll';

const role = (value: string) => ({ strategy: 'role' as const, value, stability: 'stable' as const });

/** The paged reference recipe for one pagination kind, with extra catalog query switches. */
async function paged(scoop: Scoop, name: string, kind: Kind, change: (r: RecipeInput) => void = () => {}): Promise<string> {
  const recipe = referenceRecipe(scoop.playground.port, PAGED_RECIPE);
  recipe.name = name;
  recipe.vars = recipe.vars!.map((v) => (v.name === 'mode' ? { ...v, default: kind } : v));
  const pagination = recipe.pagination!;
  pagination.kind = kind;
  if (kind === 'more') pagination.target = { selectors: [role('button|Load more')] };
  if (kind === 'scroll') delete pagination.target;
  change(recipe);
  return scoop.writeRecipe(recipe);
}

function expectedRows(baseUrl: string, count = 24) {
  return dataset.slice(0, count).map((p, i) => ({
    _page: Math.floor(i / 8) + 1,
    _index: i % 8,
    title: p.title,
    price: p.price,
    url: new URL(p.url, baseUrl).href,
    image: new URL(p.image, baseUrl).href,
    rating: p.rating,
    category: p.category,
  }));
}

const jsonl = (stdout: string) =>
  stdout
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

for (const kind of ['url', 'next', 'more', 'scroll'] as const) {
  test(`${kind} pagination yields the 24 products over 3 pages`, async ({ scoop }) => {
    const name = await paged(scoop, `paged-${kind}`, kind);
    // Scroll ends when nothing loads within the timeout; keep that wait short.
    const result = await scoop.run(['run', name, ...(kind === 'scroll' ? ['--timeout', '4000'] : [])]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expectedRows(scoop.playground.url));
    expect(result.stderr).toMatch(/24 rows from 3 pages in \d+\.\d+s/);
  });
}

test('--pages 2 yields 16 rows', async ({ scoop }) => {
  const name = await paged(scoop, 'paged-two', 'url');
  const result = await scoop.run(['run', name, '--pages', '2']);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(expectedRows(scoop.playground.url, 16));
  expect(result.stderr).toMatch(/16 rows from 2 pages in/);
});

test('--var page=3 --pages 2 extracts pages 3 and 4, then stops on no new items', async ({ scoop }) => {
  const name = await paged(scoop, 'paged-start', 'url', (r) => {
    r.url += '&lastPageRepeats=1';
  });
  const result = await scoop.run(['run', name, '--var', 'page=3', '--pages', '2', '--jsonl']);
  expect(result.code, result.stderr).toBe(0);
  const rows = jsonl(result.stdout);
  expect(rows.map((r) => r.title)).toEqual(dataset.slice(16).map((p) => p.title));
  expect(rows.every((r) => r._page === 1)).toBe(true);
  expect(result.stderr).toContain('pagination stopped after page 2: no-new-items');
  expect(result.stderr).toMatch(/8 rows from 2 pages, 8 duplicates dropped in/);
  const pages = scoop.playground.requests.filter((r) => r.path === '/catalog').length;
  expect(pages).toBe(2);
});

test('a repeating last page stops on first-item-repeats at page 3', async ({ scoop }) => {
  const name = await paged(scoop, 'paged-repeats', 'url', (r) => {
    r.url += '&lastPageRepeats=1';
    r.pagination!.stopRules = ['first-item-repeats'];
  });
  const result = await scoop.run(['run', name]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(expectedRows(scoop.playground.url));
  expect(result.stderr).toContain('pagination stopped after page 3: first-item-repeats');
  expect(result.stderr).toMatch(/24 rows from 3 pages in/);
});

test('a repeating last page without stop rules stops on the loop guard', async ({ scoop }) => {
  const name = await paged(scoop, 'paged-loop', 'next', (r) => {
    r.url += '&lastPageRepeats=1';
    r.pagination!.stopRules = [];
  });
  const result = await scoop.run(['run', name]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(expectedRows(scoop.playground.url));
  expect(result.stderr).toContain('pagination stopped after page 4: loop');
  expect(result.stderr).toMatch(/24 rows from 4 pages, 8 duplicates dropped in/);
});

test('a load-more button that disappears after one click yields 16 rows', async ({ scoop }) => {
  const name = await paged(scoop, 'paged-vanish', 'more', (r) => {
    r.url += '&moreDisappears=1';
  });
  const result = await scoop.run(['run', name, '--report']);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(expectedRows(scoop.playground.url, 16));
  expect(result.stderr).toContain('pagination stopped after page 2: target-missing');
  expect(result.stderr).toContain('"stopReason": "target-missing"');
});

test('nextRel=0 on tier 1 heals the next link by fingerprint and writes it back', async ({ scoop }) => {
  const name = await paged(scoop, 'paged-heal', 'next', (r) => {
    r.url += '&nextRel=0';
    r.vars = r.vars!.map((v) => (v.name === 'tier' ? { ...v, default: '1' } : v));
    r.pagination!.target!.selectors = [
      { strategy: 'css', value: 'a[rel="next"]', stability: 'medium' },
      { strategy: 'css', value: 'a.pager-next', stability: 'medium' },
    ];
  });
  const result = await scoop.run(['run', name]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toHaveLength(24);
  expect(result.stderr).toMatch(/healed pagination: fuzzy/);
  const saved = JSON.parse(await readFile(`${scoop.home}/recipes/${name}.json`, 'utf8')) as RecipeInput;
  const primary = saved.pagination!.target!.selectors[0]!;
  expect(primary.value).not.toBe('a[rel="next"]');
  expect(primary.value).not.toBe('a.pager-next');
});

test('a page 3 slower than --timeout leaves pages 1 and 2 on stdout and exits 1', async ({ scoop }) => {
  const name = await paged(scoop, 'paged-slow', 'url');
  const run = scoop.spawn(['run', name, '--jsonl', '--timeout', '3000', '--delay', '1500']);
  let seen = '';
  run.child.stdout!.on('data', (chunk: Buffer | string) => {
    seen += String(chunk);
    // Once page 2 is out, make every later page slower than the timeout.
    if (seen.split('\n').length > 16) scoop.playground.control.delayMs = 8000;
  });
  const result = await run.done;
  expect(result.code).toBe(1);
  const rows = jsonl(result.stdout);
  expect(rows).toEqual(expectedRows(scoop.playground.url, 16));
  expect(result.stderr).toMatch(/run failed \(timeout\)/);
});

test('test on the paged recipe extracts one page', async ({ scoop }) => {
  const name = await paged(scoop, 'paged-test', 'url');
  const result = await scoop.run(['test', name]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toContain('8 rows');
  expect(scoop.playground.requests.filter((r) => r.path === '/catalog')).toHaveLength(1);
});
