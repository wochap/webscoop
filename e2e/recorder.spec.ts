import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRecipe } from '@webscoop/core';
import { dataset } from '@webscoop/playground';
import { expect, hasDisplay, test, type Recording } from './fixtures';

test.skip(!hasDisplay, 'the recorder needs WAYLAND_DISPLAY or DISPLAY');

function expectedRows(baseUrl: string, products = dataset) {
  return products.map((p, index) => ({
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

/** Rename the last field and wait for the host to take it. */
async function renameLast(r: Recording, name: string): Promise<void> {
  const count = await r.count('[data-ws="field-name"]');
  await r.fill('[data-ws="field-name"]', name, count - 1);
  await r.until((s) => s.host?.draft.fields.at(-1)?.name === name);
}

/** Pick an element and add it as a field with a name. */
async function addField(r: Recording, selector: string, name: string, index = 0): Promise<void> {
  const before = (await r.state()).host!.draft.fields.length;
  await r.pick(selector, index);
  await r.clickPanel('[data-ws="add-field"]');
  await r.until((s) => s.host!.draft.fields.length === before + 1);
  await renameLast(r, name);
}

async function pickTitlesAsItems(r: Recording, index = 0): Promise<void> {
  const picked = await r.pick('h2.product-title', index);
  expect(picked.mode).toBe('items');
  await r.key('Enter');
  await r.until((s) => s.host?.draft.item && s.host.draft.fields.length === 1);
  await renameLast(r, 'title');
}

async function save(r: Recording): Promise<string> {
  await r.key('Control+s');
  const saved = await r.until((s) => s.host?.saved);
  expect(saved.path).toBeTruthy();
  return saved.path!;
}

const template = (port: number, extra = '') => `http://127.0.0.1:${port}/catalog?tier={tier}${extra}`;

test('the fixture tears down the recorder process and its browser', async ({ scoop }) => {
  const r = await scoop.record([template(scoop.playground.port), '--var', 'tier=0', '--name', 'teardown']);
  expect(r.run.child.exitCode).toBeNull();
  const profile = join(scoop.home, 'profiles', 'teardown');
  expect(chromiumUsing(profile).length).toBeGreaterThan(0);
  const result = await r.closeWindow();
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toContain('session ended with nothing to save');
  await expect.poll(() => chromiumUsing(profile)).toEqual([]);
});

test('click one title, confirm 24 items, add fields, save, and run the saved recipe', async ({ scoop }) => {
  const port = scoop.playground.port;
  const r = await scoop.record([template(port), '--var', 'tier=0', '--name', 'shop-catalog']);
  await pickTitlesAsItems(r);
  const item = (await r.state()).host!.draft.item!;
  expect(item.count).toBe(24);
  await addField(r, '[data-testid="price"]', 'price');
  await addField(r, 'a.product-link', 'url');
  await addField(r, 'img.product-image', 'image');
  await addField(r, '[data-testid="rating"]', 'rating');
  await addField(r, 'h1.category-heading', 'category');

  const { draft } = (await r.state()).host!;
  expect(draft.fields.map((f) => [f.name, f.type, f.scope, f.count])).toEqual([
    ['title', 'text', 'item', 24],
    ['price', 'number', 'item', 24],
    ['url', 'url', 'item', 24],
    ['image', 'image', 'item', 24],
    ['rating', 'number', 'item', 24],
    ['category', 'text', 'page', 1],
  ]);
  expect(draft.fields.every((f) => f.error === undefined)).toBe(true);
  const path = await save(r);
  const result = await r.closeWindow();
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toContain(`saved shop-catalog to ${path}`);

  const recipe = loadRecipe(await readFile(path, 'utf8'));
  expect(recipe.url).toBe(template(port));
  expect(recipe.fields.every((f) => f.fingerprint)).toBe(true);
  const run = await scoop.run(['run', 'shop-catalog']);
  expect(run.code, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual(expectedRows(scoop.playground.url));
});

test('hostile chrome: the panel sits above the header and modal, and Alt+click picks through the modal', async ({ scoop }) => {
  const r = await scoop.record([template(scoop.playground.port, '&chrome=hostile'), '--var', 'tier=0', '--name', 'hostile']);
  const { page } = r;
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  const topmost = await page.evaluate(
    ([x]) => [document.elementFromPoint(x!, 20)?.tagName, document.elementFromPoint(x!, 300)?.tagName],
    [width - 150],
  );
  expect(topmost).toEqual(['WEBSCOOP-ROOT', 'WEBSCOOP-ROOT']);
  const logo = (await r.query('.ws-logo'))!;
  expect(logo.fontFamily).toContain('Webscoop Inter');
  expect(logo.rect.x).toBeGreaterThanOrEqual(width - 400);
  expect((await r.query('[data-ws="save"]'))!.backgroundColor).toBe('rgb(145, 132, 217)');

  await page.evaluate(() => ((window as unknown as { __hostClicks: unknown[] }).__hostClicks = []));
  const picked = await r.pick('h2.product-title', 4, { alt: true });
  expect(picked.host!.selected!.selection.tag).toBe('h2');
  expect(picked.host!.selected!.selection.text).toBe(dataset[4]!.title);
  expect(picked.host!.proposal!.proposed.count).toBe(24);
  expect(await page.evaluate(() => (window as unknown as { __hostClicks: unknown[] }).__hostClicks)).toEqual([]);
  expect(await page.locator('#cookie-backdrop').count()).toBe(1);
  const result = await r.closeWindow();
  expect(result.code).toBe(0);
});

test('sponsored=2: excluding .sponsored leaves 22 items in the recipe and the run', async ({ scoop }) => {
  const port = scoop.playground.port;
  const r = await scoop.record([template(port, '&sponsored=2'), '--var', 'tier=0', '--name', 'no-ads']);
  await r.pick('h2.product-title', 5);
  await r.until((s) => s.host?.proposal?.proposed.count === 24);
  await r.submit('[data-ws="exclude-input"]', '.sponsored');
  await r.until((s) => s.host?.proposal?.proposed.count === 22);
  expect((await r.query('[data-ws="items-count"]'))!.text).toBe('22');
  const boxes = await r.page.evaluate(() => (window as unknown as { __webscoopTest: { boxes(): { variant: string }[] } }).__webscoopTest.boxes());
  expect(boxes.filter((b) => b.variant === 'excluded')).toHaveLength(2);
  expect(boxes.filter((b) => b.variant === 'sibling')).toHaveLength(22);
  // Focus is still in the exclusion input, where Enter adds another exclusion; confirm with the button.
  await r.clickPanel('[data-ws="confirm-items"]');
  await r.until((s) => s.host?.draft.item?.count === 22 && s.host.draft.fields.length === 1);
  await renameLast(r, 'title');
  const path = await save(r);
  expect((await r.closeWindow()).code).toBe(0);

  const recipe = loadRecipe(await readFile(path, 'utf8'));
  expect(recipe.item!.exclude).toEqual([{ strategy: 'css', value: '.sponsored', stability: 'medium' }]);
  const run = await scoop.run(['run', 'no-ads']);
  expect(run.code, run.stderr).toBe(0);
  const rows = JSON.parse(run.stdout) as { title: string }[];
  expect(rows).toHaveLength(22);
  expect(rows.map((row) => row.title)).toEqual(dataset.slice(2).map((p) => p.title));
});

test('marking a ?page=2 link proposes url pagination, saved and run', async ({ scoop }) => {
  const port = scoop.playground.port;
  const r = await scoop.record([template(port), '--var', 'tier=0', '--name', 'paged']);
  await pickTitlesAsItems(r);
  await r.page.evaluate(() => {
    const link = document.createElement('a');
    link.id = 'next-page';
    link.href = '/catalog?tier=0&page=2';
    link.textContent = 'Next page';
    document.querySelector('main')!.append(link);
  });
  await r.pick('#next-page');
  await r.clickPanel('[data-ws="mark-pagination"]');
  const pagination = await r.until((s) => s.host?.draft.pagination);
  expect(pagination).toMatchObject({ kind: 'url', param: { name: 'page', start: 1, step: 1 } });
  await r.clickPanel('[data-ws="seg-n"]');
  await r.until((s) => s.host?.draft.pagination?.limit === 3);
  const path = await save(r);
  expect((await r.closeWindow()).code).toBe(0);

  const recipe = loadRecipe(await readFile(path, 'utf8'));
  expect(recipe.pagination).toMatchObject({ kind: 'url', param: { name: 'page', start: 1, step: 1 }, limit: 3 });
  expect(recipe.pagination.target!.selectors.length).toBeGreaterThan(0);
  // The unpaginated catalog ignores `page`: every page repeats the first, so dedup keeps 24 rows.
  const run = await scoop.run(['run', 'paged']);
  expect(run.code, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toHaveLength(24);
  expect(run.stderr).toContain('page 2 loaded: http://127.0.0.1:');
  expect(run.stderr).toMatch(/[?&]page=3 \(HTTP 200\)/);
  expect(run.stderr).toMatch(/24 rows from 3 pages, 48 duplicates dropped in/);
});

test('--edit shows six fields with counts, test runs 24 rows, and Ctrl+S saves it unchanged', async ({ scoop }) => {
  const original = loadRecipe(await readFile(scoop.recipePath, 'utf8'));
  const r = await scoop.record(['--edit', 'playground-catalog']);
  const counted = await r.until((s) => (s.host?.draft.fields.every((f) => f.count !== null) ? s : undefined));
  expect(counted.host!.draft.fields.map((f) => [f.name, f.count])).toEqual([
    ['title', 24],
    ['price', 24],
    ['url', 24],
    ['image', 24],
    ['rating', 24],
    ['category', 1],
  ]);
  expect(await r.count('[data-ws="field"]')).toBe(6);
  await r.clickPanel('[data-ws="test-run"]');
  const results = await r.until((s) => s.host?.test);
  expect(results.rowCount).toBe(24);
  expect(results.fields.map((f) => f.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  expect(await r.count('[data-ws="result-row"]')).toBe(24);
  await save(r);
  const result = await r.closeWindow();
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).not.toContain('unsaved');
  expect(loadRecipe(await readFile(scoop.recipePath, 'utf8'))).toEqual(original);
});
