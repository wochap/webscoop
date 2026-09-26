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
  await r.until((s) => s.host?.draft.tables[0]!.fields.at(-1)?.name === name);
}

/** Pick an element and add it as a field with a name. */
async function addField(r: Recording, selector: string, name: string, index = 0): Promise<void> {
  const before = (await r.state()).host!.draft.tables[0]!.fields.length;
  await r.pick(selector, index);
  await r.clickPanel('[data-ws="add-field"]');
  await r.until((s) => s.host!.draft.tables[0]!.fields.length === before + 1);
  await renameLast(r, name);
}

async function pickTitlesAsItems(r: Recording, index = 0): Promise<void> {
  const picked = await r.pick('h2.product-title', index);
  expect(picked.mode).toBe('items');
  await r.key('Enter');
  await r.until((s) => s.host?.draft.tables[0]!.item && s.host.draft.tables[0]!.fields.length === 1);
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
  const item = (await r.state()).host!.draft.tables[0]!.item!;
  expect(item.count).toBe(24);
  await addField(r, '[data-testid="price"]', 'price');
  await addField(r, 'a.product-link', 'url');
  await addField(r, 'img.product-image', 'image');
  await addField(r, '[data-testid="rating"]', 'rating');
  await addField(r, 'h1.category-heading', 'category');

  const { draft } = (await r.state()).host!;
  expect(draft.tables[0]!.fields.map((f) => [f.name, f.type, f.scope, f.count])).toEqual([
    ['title', 'text', 'item', 24],
    ['price', 'number', 'item', 24],
    ['url', 'url', 'item', 24],
    ['image', 'image', 'item', 24],
    ['rating', 'number', 'item', 24],
    ['category', 'text', 'page', 1],
  ]);
  expect(draft.tables[0]!.fields.every((f) => f.error === undefined)).toBe(true);
  const path = await save(r);
  const result = await r.closeWindow();
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toContain(`saved shop-catalog to ${path}`);

  const recipe = loadRecipe(await readFile(path, 'utf8'));
  expect(recipe.url).toBe(template(port));
  expect(recipe.fields!.every((f) => f.fingerprint)).toBe(true);
  const run = await scoop.run(['run', 'shop-catalog']);
  expect(run.code, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual(expectedRows(scoop.playground.url));
});

test('type a selector, clear with Esc, edit a primary, cancel an edit, save, and run the edited recipe', async ({ scoop }) => {
  const r = await scoop.record([template(scoop.playground.port), '--var', 'tier=0', '--name', 'edited']);
  await pickTitlesAsItems(r);
  expect((await r.state()).host!.selected).toBeNull();

  // A typed item selector selects the first card's heading, with its coverage.
  await r.fill('[data-ws="selection-selector"]', 'css=h2');
  await r.clickPanel('[data-ws="selection-selector-go"]');
  const typed = await r.until((s) => (s.host?.selected?.selection.candidates[0]?.value === 'h2' ? s.host.selected : undefined));
  expect(typed.scope).toBe('item');
  expect(typed.selection.text).toBe(dataset[0]!.title);
  expect(typed.selection.candidates[0]).toMatchObject({ strategy: 'css', count: 24, items: 24 });
  expect((await r.query('[data-ws="coverage-count"]'))!.text).toBe('24 / 24 items');
  await r.fill('[data-ws="form-name"]', 'heading');
  await r.clickPanel('[data-ws="add-field"]');
  await r.until((s) => s.host!.draft.tables[0]!.fields.length === 2 && s.host!.selected === null);
  expect((await r.state()).host!.draft.tables[0]!.fields[1]).toMatchObject({ name: 'heading', scope: 'item', count: 24 });

  // Esc when not picking clears the selection and its highlight.
  await r.pick('[data-testid="price"]', 3);
  await r.key('Escape');
  await r.until((s) => s.host?.selected === null);
  const boxes = await r.page.evaluate(() => (window as unknown as { __webscoopTest: { boxes(): { variant: string }[] } }).__webscoopTest.boxes());
  expect(boxes.some((b) => b.variant === 'selected')).toBe(false);
  expect(await r.count('[data-ws="inspector"]')).toBe(0);

  // Edit the price field's primary candidate and update it in place.
  await addField(r, '[data-testid="price"]', 'price');
  await r.clickPanel('[data-ws="field-edit"]', 2);
  const editing = await r.until((s) => (s.host?.editing && s.host.selected ? s : undefined));
  expect(editing.mode).toBe('editing');
  expect(editing.host!.selected!.selection.text).toBe(`$${dataset[0]!.price.toFixed(2)}`);
  const candidates = editing.host!.selected!.selection.candidates;
  const other = candidates.findIndex((c, i) => i > 0 && c.count === 24);
  expect(other).toBeGreaterThan(0);
  await r.clickPanel('[data-ws="candidate"]', other);
  await r.until((s) => s.host?.selected?.primary === other);
  await r.clickPanel('[data-ws="update-field"]');
  const updated = await r.until((s) => (s.host?.editing === null && s.host.selected === null ? s.host : undefined));
  expect(updated.draft.tables[0]!.fields.map((f) => f.name)).toEqual(['title', 'heading', 'price']);
  expect(updated.draft.tables[0]!.fields[2]!.selectors[0]).toMatchObject({ strategy: candidates[other]!.strategy, value: candidates[other]!.value });

  // Cancel an edit: the title keeps its type.
  await r.clickPanel('[data-ws="field-summary"]', 0);
  await r.until((s) => s.host?.editing?.index === 0 && s.host.selected);
  await r.fill('[data-ws="form-type"]', 'html');
  await r.clickPanel('[data-ws="cancel-edit"]');
  const cancelled = await r.until((s) => (s.host?.editing === null ? s.host : undefined));
  expect(cancelled.draft.tables[0]!.fields[0]).toMatchObject({ name: 'title', type: 'text' });

  const path = await save(r);
  const result = await r.closeWindow();
  expect(result.code, result.stderr).toBe(0);
  const recipe = loadRecipe(await readFile(path, 'utf8'));
  expect(recipe.fields![2]!.selectors[0]).toMatchObject({ strategy: candidates[other]!.strategy, value: candidates[other]!.value });
  const run = await scoop.run(['run', 'edited']);
  expect(run.code, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual(dataset.map((p, index) => ({ _page: 1, _index: index, title: p.title, heading: p.title, price: p.price })));
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
  await r.until((s) => s.host?.draft.tables[0]!.item?.count === 22 && s.host.draft.tables[0]!.fields.length === 1);
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
  const counted = await r.until((s) => (s.host?.draft.tables[0]!.fields.every((f) => f.count !== null) ? s : undefined));
  expect(counted.host!.draft.tables[0]!.fields.map((f) => [f.name, f.count])).toEqual([
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
  expect(results.tables[0]!.rowCount).toBe(24);
  expect(results.tables[0]!.fields.map((f) => f.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  expect(await r.count('[data-ws="result-row"]')).toBe(24);
  await save(r);
  const result = await r.closeWindow();
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).not.toContain('unsaved');
  expect(loadRecipe(await readFile(scoop.recipePath, 'utf8'))).toEqual(original);
});

test('rows=4: one title proposes 24 cards under the product list, saved and run', async ({ scoop }) => {
  const r = await scoop.record([template(scoop.playground.port, '&rows=4'), '--var', 'tier=0', '--name', 'rows']);
  const picked = await r.pick('h2.product-title', 5);
  expect(picked.mode).toBe('items');
  const proposal = await r.until((s) => s.host?.proposal);
  expect(proposal.proposed.count).toBe(24);
  expect(proposal.within!.label).toBe('ul.product-list');
  expect((await r.query('[data-ws="level-input-within"]'))!.value).toBe('role=list');
  expect((await r.query('[data-ws="items-count"]'))!.text).toBe('24');
  await r.key('Enter');
  await r.until((s) => s.host?.draft.tables[0]!.item && s.host.draft.tables[0]!.fields.length === 1);
  await renameLast(r, 'title');
  const path = await save(r);
  expect((await r.closeWindow()).code).toBe(0);

  const recipe = loadRecipe(await readFile(path, 'utf8'));
  expect(recipe.item!.within![0]).toEqual({ strategy: 'role', value: 'list', stability: 'stable' });
  const run = await scoop.run(['run', 'rows']);
  expect(run.code, run.stderr).toBe(0);
  expect((JSON.parse(run.stdout) as { title: string }[]).map((row) => row.title)).toEqual(dataset.map((p) => p.title));
});

test('edit items: move the confirmed cards to the broader level, update, cancel a second edit, save, and run', async ({ scoop }) => {
  const r = await scoop.record([template(scoop.playground.port), '--var', 'tier=0', '--name', 'edit-items']);
  await pickTitlesAsItems(r);
  await addField(r, '[data-testid="price"]', 'price');
  expect((await r.state()).host!.draft.tables[0]!.item!.fingerprint!.tag).toBe('article');

  await r.clickPanel('[data-ws="edit-item"]');
  const editing = await r.until((s) => (s.host?.proposal?.editing ? s.host.proposal : null));
  expect(editing.proposed.count).toBe(24);
  expect(editing.broader).toMatchObject({ tag: 'li', count: 24 });
  expect((await r.query('[data-ws="confirm-items"]'))!.text).toContain('Update items');
  await r.clickPanel('[data-ws="level-broader"]');
  await r.clickPanel('[data-ws="confirm-items"]');
  await r.until((s) => !s.host?.proposal && s.host?.draft.tables[0]!.item?.fingerprint?.tag === 'li');
  const updated = (await r.state()).host!.draft;
  expect(updated.tables[0]!.item!.count).toBe(24);
  expect(updated.tables[0]!.fields.map((f) => [f.name, f.scope, f.count])).toEqual([
    ['title', 'item', 24],
    ['price', 'item', 24],
  ]);

  await r.clickPanel('[data-ws="edit-item"]');
  await r.until((s) => s.host?.proposal?.editing);
  await r.clickPanel('[data-ws="cancel-items"]');
  await r.until((s) => !s.host?.proposal);
  const after = (await r.state()).host!.draft;
  expect(after.tables[0]!.item).toEqual(updated.tables[0]!.item);
  expect(after.tables[0]!.fields.map((f) => f.name)).toEqual(['title', 'price']);

  const path = await save(r);
  expect((await r.closeWindow()).code).toBe(0);
  const recipe = loadRecipe(await readFile(path, 'utf8'));
  expect(recipe.item!.selectors[0]).toMatchObject({ strategy: 'role', value: 'listitem' });
  expect(recipe.item!.fingerprint!.tag).toBe('li');
  const run = await scoop.run(['run', 'edit-items']);
  expect(run.code, run.stderr).toBe(0);
  const rows = JSON.parse(run.stdout) as { title: string; price: number }[];
  expect(rows.map((row) => row.title)).toEqual(dataset.map((p) => p.title));
  expect(rows.map((row) => row.price)).toEqual(dataset.map((p) => p.price));
});

test('mixed=1: 24 cards with 6 skipped, include all shows 30, and the saved recipe runs 24 rows', async ({ scoop }) => {
  const r = await scoop.record([template(scoop.playground.port, '&mixed=1'), '--var', 'tier=0', '--name', 'mixed']);
  await r.pick('h2.product-title', 2);
  await r.until((s) => s.host?.proposal?.proposed.count === 24);
  expect((await r.state()).host!.proposal!.skipped).toBe(6);
  expect((await r.query('[data-ws="items-skipped"]'))!.text).toBe('6 skipped as dissimilar');
  await r.clickPanel('[data-ws="include-all"]');
  await r.until((s) => s.host?.proposal?.proposed.count === 30 && s.host.proposal.skipped === 0);
  expect((await r.query('[data-ws="items-count"]'))!.text).toBe('30');
  await r.clickPanel('[data-ws="include-all"]');
  await r.until((s) => s.host?.proposal?.proposed.count === 24 && s.host.proposal.skipped === 6);
  await r.clickPanel('[data-ws="confirm-items"]');
  await r.until((s) => s.host?.draft.tables[0]!.item?.count === 24 && s.host.draft.tables[0]!.fields.length === 1);
  await renameLast(r, 'title');
  await save(r);
  expect((await r.closeWindow()).code).toBe(0);

  const run = await scoop.run(['run', 'mixed']);
  expect(run.code, run.stderr).toBe(0);
  const rows = JSON.parse(run.stdout) as { title: string }[];
  expect(rows).toHaveLength(24);
  expect(rows.map((row) => row.title)).toEqual(dataset.map((p) => p.title));
});

test('tier 1: a recipe recorded with the role-only item candidate runs on tier 3 without healing the container', async ({ scoop }) => {
  const r = await scoop.record([template(scoop.playground.port), '--var', 'tier=1', '--name', 'by-role']);
  await r.pick('h2', 3);
  await r.until((s) => s.host?.proposal?.broader);
  // The list entry, which keeps its tag on every tier, with its role as the primary selector.
  await r.clickPanel('[data-ws="level-broader"]');
  const broader = (await r.state()).host!.proposal!.broader!;
  const role = broader.selectors.findIndex((c) => c.strategy === 'role' && c.value === 'listitem');
  expect(role).toBeGreaterThanOrEqual(0);
  if (broader.primary !== role) {
    await r.clickPanel('[data-ws="level-more-item"]');
    await r.clickPanel(`[data-ws="level-candidates-item"] [data-ws="candidate"]:nth-child(${role + 1})`);
    await r.until((s) => s.host?.proposal?.broader?.primary === role);
  }
  await r.clickPanel('[data-ws="confirm-items"]');
  await r.until((s) => s.host?.draft.tables[0]!.item && s.host.draft.tables[0]!.fields.length === 1);
  await renameLast(r, 'title');
  const path = await save(r);
  expect((await r.closeWindow()).code).toBe(0);

  const recipe = loadRecipe(await readFile(path, 'utf8'));
  expect(recipe.item!.selectors[0]).toEqual({ strategy: 'role', value: 'listitem', stability: 'stable' });
  expect(recipe.item!.within![0]).toEqual({ strategy: 'role', value: 'list', stability: 'stable' });
  const run = await scoop.run(['run', 'by-role', '--var', 'tier=3', '--no-save']);
  expect(run.code, run.stderr).toBe(0);
  expect(run.stderr).not.toMatch(/healed (item|within)/);
  const rows = JSON.parse(run.stdout) as { title: string }[];
  expect(rows).toHaveLength(24);
  expect(rows.map((row) => row.title).sort()).toEqual(dataset.map((p) => p.title).sort());
});

test('results under div#rso: the proposal counts every result, and the saved recipe runs one row per result without healing', async ({ scoop }) => {
  const url = `http://127.0.0.1:${scoop.playground.port}/results`;
  const r = await scoop.record([url, '--name', 'serp']);
  const picked = await r.pick('h3.LC20lb', 1);
  expect(picked.mode).toBe('items');
  const proposal = await r.until((s) => s.host?.proposal);
  expect(proposal.proposed.count).toBeGreaterThan(0);
  expect(proposal.proposed.count).toBe(8);
  expect(proposal.skipped).toBe(1);
  expect(proposal.within!.selectors[0]).toMatchObject({ strategy: 'id', value: 'rso' });
  for (const c of proposal.proposed.selectors) expect(c.value).not.toMatch(/main|rso|GyAeWb|s6JM6d|center_col|dURPMd/);
  expect((await r.query('[data-ws="items-count"]'))!.text).toBe('8');
  expect((await r.query('[data-ws="selector-chain-text"]'))!.text).toMatch(/^id=rso » /);
  await r.key('Enter');
  await r.until((s) => s.host?.draft.tables[0]!.item?.count === 8 && s.host.draft.tables[0]!.fields.length === 1);
  await renameLast(r, 'title');
  await addField(r, 'div.VwiC3b span', 'snippet', 2);
  const { draft } = (await r.state()).host!;
  expect(draft.tables[0]!.fields.map((f) => [f.name, f.scope, f.count])).toEqual([
    ['title', 'item', 8],
    ['snippet', 'item', 8],
  ]);
  await r.clickPanel('[data-ws="test-run"]');
  const results = await r.until((s) => s.host?.test);
  expect(results.error).toBeUndefined();
  expect(results.tables[0]!.rowCount).toBe(8);
  const path = await save(r);
  expect((await r.closeWindow()).code).toBe(0);

  const recipe = loadRecipe(await readFile(path, 'utf8'));
  expect(recipe.item!.within![0]).toEqual({ strategy: 'id', value: 'rso', stability: 'stable' });
  const run = await scoop.run(['run', 'serp']);
  expect(run.code, run.stderr).toBe(0);
  expect(run.stderr).not.toMatch(/healed (item|within)/);
  const rows = JSON.parse(run.stdout) as { title: string; snippet: string }[];
  expect(rows.map((row) => row.title)).toEqual(dataset.slice(0, 8).map((p) => p.title));
  expect(rows.every((row) => row.snippet.includes('rated'))).toBe(true);
});

test('results link: walking up from the heading offers role=link with its long name matching once, and the item field keeps the role alone', async ({ scoop }) => {
  const url = `http://127.0.0.1:${scoop.playground.port}/results`;
  const r = await scoop.record([url, '--name', 'serp-links']);
  await r.pick('h3.LC20lb', 1);
  await r.until((s) => s.host?.proposal);
  await r.key('ArrowLeft');
  const selected = await r.until((s) => (s.host?.selected?.selection.tag === 'a' ? s.host.selected : undefined));
  const role = selected.selection.candidates.find((c) => c.strategy === 'role')!;
  // The name runs past 80 characters and the page spells the breadcrumb without the space Playwright keeps.
  expect(role.value.startsWith(`link|${dataset[1]!.title} `)).toBe(true);
  expect(role.value.length).toBeGreaterThan(85);
  expect(role.value).toContain('example›');
  expect(role.count).toBe(1);
  await r.key('Enter');
  const draft = await r.until((s) => (s.host?.draft.tables[0]!.item?.count === 8 && s.host.draft.tables[0]!.fields.length === 1 ? s.host.draft : undefined));
  const field = draft.tables[0]!.fields[0]!;
  expect(field.scope).toBe('item');
  expect(field.count).toBe(8);
  expect(field.selectors.find((c) => c.strategy === 'role')).toMatchObject({ value: 'link' });
  expect((await r.closeWindow()).code).toBe(0);
});

/** Record the twins catalog with the titles confirmed as items. */
async function twinsRecording(scoop: { record(args: string[]): Promise<Recording>; playground: { port: number } }, name: string): Promise<Recording> {
  const r = await scoop.record([template(scoop.playground.port, '&twins=1'), '--var', 'tier=0', '--name', name]);
  await pickTitlesAsItems(r);
  return r;
}

const STRICT_SELLER = 'p.product-note:nth-of-type(4) > span';

test('twins=1: the Sold by pick preselects a verified hit, tests 24 sellers, and the recipe runs at tier 0 and tier 1', async ({ scoop }) => {
  const r = await twinsRecording(scoop, 'twins');
  // The second `p.product-note span` on the page is the first card's seller.
  const picked = await r.pick('p.product-note span', 1);
  const candidates = picked.host!.selected!.selection.candidates;
  expect(picked.host!.selected!.scope).toBe('item');
  expect(candidates[0]).toMatchObject({ strategy: 'css', value: STRICT_SELLER, hit: true, count: 24 });
  expect(candidates.every((c) => c.hit === true)).toBe(true);
  expect(await r.count('[data-ws="candidate-miss"]')).toBe(0);
  expect((await r.query('[data-ws="candidate"]'))!.attrs['data-hit']).toBe('true');
  await r.clickPanel('[data-ws="add-field"]');
  await r.until((s) => s.host!.draft.tables[0]!.fields.length === 2);
  await renameLast(r, 'seller');
  expect((await r.state()).host!.draft.tables[0]!.fields[1]).toMatchObject({ count: 24, sample: `Sold by ${dataset[0]!.seller}` });

  await r.clickPanel('[data-ws="test-run"]');
  const results = await r.until((s) => s.host?.test);
  expect(results.tables[0]!.rowCount).toBe(24);
  expect(results.tables[0]!.rows.every((row) => String(row.seller).startsWith('Sold by'))).toBe(true);
  const path = await save(r);
  expect((await r.closeWindow()).code).toBe(0);

  const recipe = loadRecipe(await readFile(path, 'utf8'));
  expect(recipe.fields![1]!.selectors[0]).toEqual({ strategy: 'css', value: STRICT_SELLER, stability: 'fragile' });
  const sellers = dataset.map((p) => `Sold by ${p.seller}`);
  for (const tier of ['0', '1']) {
    const run = await scoop.run(['run', 'twins', '--var', `tier=${tier}`, '--no-save']);
    expect(run.code, run.stderr).toBe(0);
    expect((JSON.parse(run.stdout) as { seller: string }[]).map((row) => row.seller), `tier ${tier}`).toEqual(sellers);
  }
});

test('twins=1: clicking the p.product-note crumb verifies the second paragraph and marks p.product-note a miss', async ({ scoop }) => {
  const r = await twinsRecording(scoop, 'twins-crumb');
  const picked = await r.pick('p.product-note span', 1);
  const path = picked.host!.selected!.selection.path.slice(0, -1);
  await r.clickPanel(`[data-ws="crumb"][data-path="${path.join('.')}"]`);
  const selected = await r.until((s) => (s.host?.selected?.selection.tag === 'p' ? s.host.selected : undefined));
  expect(selected.selection.path).toEqual(path);
  expect(selected.selection.candidates[0]).toMatchObject({ value: 'p.product-note:nth-of-type(4)', hit: true, count: 24 });
  const miss = selected.selection.candidates.findIndex((c) => c.strategy === 'class' && c.value === 'p.product-note');
  expect(selected.selection.candidates[miss]).toMatchObject({ count: 48, hit: false });
  const badge = await r.query('[data-ws="candidate"]', miss);
  expect(badge!.attrs['data-hit']).toBe('false');
  expect(await r.count('[data-ws="candidate-miss"]')).toBeGreaterThanOrEqual(1);
  expect((await r.closeWindow()).code).toBe(0);
});

test('gate=cookie: after a reload behind the gate, a zero match field offers to replay the steps and counts 24 again', async ({ scoop }) => {
  const recipe = structuredClone(scoop.recipe);
  recipe.name = 'cookie-replay';
  recipe.url = `${recipe.url}&gate=cookie`;
  await scoop.writeRecipe(recipe);
  const r = await scoop.record(['--edit', 'cookie-replay']);
  await r.until((s) => s.host?.draft.tables[0]!.fields.every((f) => f.count !== null));
  await r.browse();
  await r.click('#consent-accept');
  await r.until((s) => s.host?.draft.steps.length === 1);
  await r.key('b');
  await r.until((s) => !s.ui.browsing);
  await expect.poll(() => r.page.locator('article').count()).toBe(24);

  // Forget the consent so the reload shows the gate again.
  await r.page.evaluate(() => localStorage.clear());
  await r.page.reload();
  await r.until((s) => s.host?.draft.steps.length === 1 && s.host.draft.tables[0]!.fields[0]!.count === 0);
  expect(await r.page.locator('article').count()).toBe(0);
  expect(await r.count('[data-ws="replay-steps"]')).toBeGreaterThan(0);
  expect((await r.query('[data-ws="zero-match"]'))!.text).toContain('may appear only after the recorded steps');
  await r.clickPanel('[data-ws="replay-steps"]');
  await r.until((s) => s.host?.draft.tables[0]!.fields[0]!.count === 24);
  await expect.poll(() => r.page.locator('article').count()).toBe(24);
  expect(await r.count('[data-ws="replay-steps"]')).toBe(0);
  expect((await r.closeWindow()).code).toBe(0);
});
