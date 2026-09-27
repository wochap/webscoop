import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { currentTable, loadRecipe, tablesOf, type Recipe, type RecipeInput } from '@webscoop/core';
import { dataset } from '@webscoop/playground';
import { expect, hasDisplay, test } from './fixtures';
import { sidebar, ws } from './sidebar';

test.skip(!hasDisplay, 'the recorder needs WAYLAND_DISPLAY or DISPLAY');

const NAME = 'catalog-tables';
const template = (port: number) => `http://127.0.0.1:${port}/catalog?tier={tier}&mixed=1`;

/** The recipe recorded by the first scenario, kept for the second. */
let recorded: Recipe | undefined;

test.describe.configure({ mode: 'serial' });

test('records products, the page heading, and the questions blocks as three tables, and runs them', async ({ scoop }) => {
  const port = scoop.playground.port;
  const r = await scoop.record([template(port), '--var', 'tier=0', '--name', NAME]);
  const panel = sidebar(r);

  // products: one title suggests the product cards; accepting returns to the title, read inside each card.
  await panel.setUpList('h2.product-title');
  await panel.acceptList();
  expect((await r.state()).host!.draft.tables[0]!.item!.count).toBe(24);
  expect((await r.state()).host!.selected!.scope).toBe('item');
  await panel.addField('title');
  expect(currentTable((await r.state()).host!.draft).name).toBe('items');
  await panel.renameTable('products');
  expect(await r.count(ws('tab'))).toBe(1);

  // page: added from the strip, the category heading goes to it.
  await panel.addTable();
  expect(currentTable((await r.state()).host!.draft).name).toBe('page');
  const heading = await r.pick('h1.category-heading');
  expect(heading.host!.selected).toMatchObject({ scope: 'page', table: 1 });
  await panel.addField('category');

  // questions: a new table, one question heading proposes the questions blocks.
  await panel.addTable();
  await panel.renameTable('questions');
  await panel.setUpList('h3.questions-title', { item: 'css=.mixed-questions' });
  await panel.acceptList();
  expect((await r.state()).host!.draft.tables[2]!.item!.count).toBe(6);
  await panel.addField('title');

  const { draft } = (await r.state()).host!;
  expect(draft.tables.map((t) => [t.name, t.item?.count ?? null, t.fields.map((f) => [f.name, f.scope, f.count])])).toEqual([
    ['products', 24, [['title', 'item', 24]]],
    ['page', null, [['category', 'page', 1]]],
    ['questions', 6, [['title', 'item', 6]]],
  ]);
  expect(await r.count(ws('tab'))).toBe(3);
  // Only the active table's content shows; the tabs stand for the others.
  expect((await r.query(ws('table-content')))!.attrs['data-table']).toBe('questions');
  expect(await r.count(ws('field'))).toBe(1);

  const results = await panel.testRun();
  expect(results.error).toBeUndefined();
  expect(results.tables.map((t) => [t.name, t.rowCount])).toEqual([
    ['products', 24],
    ['page', 1],
    ['questions', 6],
  ]);
  expect(await r.count(ws('results-tab'))).toBe(3);
  // The drawer opens on the active table.
  expect(await r.count(ws('results-row'))).toBe(6);

  const path = await panel.save();
  const result = await r.closeWindow();
  expect(result.code, result.stderr).toBe(0);

  const recipe = loadRecipe(await readFile(path, 'utf8'));
  expect(recipe.fields).toBeUndefined();
  expect(tablesOf(recipe).map((t) => t.name)).toEqual(['products', 'page', 'questions']);
  recorded = recipe;

  const run = await scoop.run(['run', NAME]);
  expect(run.code, run.stderr).toBe(0);
  const out = JSON.parse(run.stdout) as Record<string, Record<string, unknown>[]>;
  expect(Object.keys(out)).toEqual(['products', 'page', 'questions']);
  expect(out.products).toHaveLength(24);
  expect(out.products!.map((row) => row.title)).toEqual(dataset.map((p) => p.title));
  expect(out.page).toEqual([{ _page: 1, _index: 0, category: 'Electronics' }]);
  expect(out.questions).toHaveLength(6);
  expect(out.questions!.every((row) => row.title === 'People also ask')).toBe(true);
});

test('record --edit --repick questions.title replaces only that field', async ({ scoop }) => {
  test.skip(!recorded, 'needs the recipe of the previous scenario');
  const input = { ...recorded!, url: template(scoop.playground.port) } as RecipeInput;
  const name = await scoop.writeRecipe(input);
  const path = join(scoop.home, 'recipes', `${name}.json`);
  const before = loadRecipe(await readFile(path, 'utf8'));

  const r = await scoop.record(['--edit', name, '--repick', 'questions.title']);
  const ctx = await r.until((s) => s.host?.repickContext);
  expect(ctx).toMatchObject({ table: 'questions', field: 'title', reason: 'cli' });
  expect((await r.state()).host!.draft.activeTable).toBe(2);
  expect((await r.query(ws('repick-field')))!.text).toBe('questions.title');
  await r.pick('button.questions-option', 0);
  await r.until((s) => s.host?.repickContext?.picked);
  await r.clickPanel(ws('repick-confirm'));
  const result = await r.run.done;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toContain('saved the new location of questions.title');

  const after = loadRecipe(await readFile(path, 'utf8'));
  const [beforeTables, afterTables] = [tablesOf(before), tablesOf(after)];
  expect(afterTables.map((t) => t.name)).toEqual(['products', 'page', 'questions']);
  expect(afterTables[0]).toEqual(beforeTables[0]);
  expect(afterTables[1]).toEqual(beforeTables[1]);
  expect(afterTables[2]!.item).toEqual(beforeTables[2]!.item);
  const [oldTitle, newTitle] = [beforeTables[2]!.fields[0]!, afterTables[2]!.fields[0]!];
  expect(newTitle.selectors).not.toEqual(oldTitle.selectors);
  expect(newTitle.fingerprint?.tag).toBe('button');
  expect({ ...newTitle, selectors: [], fingerprint: undefined }).toEqual({ ...oldTitle, selectors: [], fingerprint: undefined });
  const { tables: _a, ...restAfter } = after;
  const { tables: _b, ...restBefore } = before;
  expect(restAfter).toEqual(restBefore);
});

test('tabs reorder by drag, a new primary table is announced, and section collapse survives a navigation', async ({ scoop }) => {
  const port = scoop.playground.port;
  const r = await scoop.record([template(port), '--var', 'tier=0', '--name', 'catalog-tabs']);
  const panel = sidebar(r);

  // products, then questions: two lists.
  await panel.setUpList('h2.product-title');
  await panel.acceptList();
  await panel.addField('title');
  await panel.renameTable('products');
  await panel.addTable();
  await panel.renameTable('questions');
  await panel.setUpList('h3.questions-title', { item: 'css=.mixed-questions' });
  await panel.acceptList();
  await panel.addField('title');
  expect((await r.state()).host!.draft.tables[1]!.item!.count).toBe(6);

  // Pagination on: the first list drives it.
  await r.page.evaluate(() => {
    const link = document.createElement('a');
    link.id = 'next-page';
    link.href = '/catalog?tier=0&mixed=1&page=2';
    link.textContent = 'Next page';
    document.querySelector('main')!.append(link);
  });
  await r.pick('#next-page');
  await r.clickPanel(ws('pick-pagination'));
  await r.until((s) => s.host?.draft.pagination);
  const badge = (table: string) => r.count(`${ws('tab')}[data-table="${table}"] ${ws('tab-drives-pagination')}`);
  expect(await badge('products')).toBe(1);
  expect(await badge('questions')).toBe(0);

  // Drag questions before products: the order is saved, and the new primary table is announced.
  await panel.reorderTabs(1, 0);
  await r.until((s) => s.host?.draft.tables.map((t) => t.name).join() === 'questions,products');
  expect(await panel.tabNames()).toEqual(['questions', 'products']);
  expect(await badge('questions')).toBe(1);
  expect(await badge('products')).toBe(0);
  await expect.poll(async () => (await r.query(ws('panel-toast')))?.text ?? '').toContain('questions now drives pagination');

  // Collapse Steps, then navigate: the panel comes back with Steps still collapsed.
  await r.clickPanel(`${ws('section-steps')} ${ws('section-toggle')}`);
  await r.until((s) => s.host?.panel.collapsed.steps === true);
  await r.page.goto(`http://127.0.0.1:${port}/catalog?tier=1&mixed=1`);
  await r.until((s) => s.host?.url.includes('tier=1'));
  await expect.poll(async () => (await r.query(ws('section-steps')))?.attrs['data-collapsed'] ?? null).toBe('true');

  const path = await panel.save();
  expect((await r.closeWindow()).code).toBe(0);
  const recipe = loadRecipe(await readFile(path, 'utf8'));
  expect(tablesOf(recipe).map((t) => t.name)).toEqual(['questions', 'products']);
  expect(JSON.stringify(recipe)).not.toMatch(/collapsed/);
});

test('records a list and a page table through the suggestion and the outside banner, clears and redoes the list, and runs it', async ({ scoop }) => {
  const port = scoop.playground.port;
  const r = await scoop.record([`http://127.0.0.1:${port}/catalog?tier={tier}`, '--var', 'tier=0', '--name', 'list-and-page']);
  const panel = sidebar(r);
  expect((await r.query(ws('table-kind')))!.text).toBe('No mode yet');

  // A first list, then Clear table from the menu: the table has no mode again.
  await panel.setUpList('h2.product-title');
  await panel.acceptList();
  await panel.addField('wrong');
  await r.clickPanel(ws('table-menu'));
  expect((await r.query(ws('table-menu-locked')))!.text).toContain('Mode locked — list');
  await r.clickPanel(ws('table-menu-clear-table'));
  await r.until((s) => s.host?.draft.tables[0]!.item === null && s.host.draft.tables[0]!.fields.length === 0);
  expect((await r.query(ws('table-kind')))!.text).toBe('No mode yet');

  // The list again, from the suggestion.
  await panel.setUpList('h2.product-title');
  await panel.acceptList();
  await panel.addField('title');
  await r.pick('[data-testid="price"]', 0);
  await panel.addField('price');
  expect((await r.query(ws('table-kind')))!.text).toBe('List · 24 rows');

  // The heading is outside the list: the banner makes a page table and keeps the pick.
  await r.pick('h1.category-heading');
  expect((await r.query(ws('pick-outside-banner')))!.text).toContain('Outside the items list');
  expect((await r.query(ws('pick-outside-table-name')))!.value).toBe('page');
  await r.clickPanel(ws('pick-outside-new-page'));
  const moved = await r.until((s) => (s.host?.draft.activeTable === 1 && s.host.selected?.table === 1 ? s.host : undefined));
  expect(moved.draft.tables[1]!.fields).toHaveLength(0);
  expect(moved.selected!.scope).toBe('page');
  await panel.addField('category');
  expect((await r.query(ws('table-kind')))!.text).toBe('Page · 1 row');

  const path = await panel.save();
  expect((await r.closeWindow()).code).toBe(0);
  const recipe = loadRecipe(await readFile(path, 'utf8'));
  const tables = tablesOf(recipe);
  expect(tables.map((t) => [t.name, Boolean(t.item), t.fields.map((f) => [f.name, f.scope])])).toEqual([
    ['items', true, [['title', 'item'], ['price', 'item']]],
    ['page', false, [['category', 'page']]],
  ]);

  const run = await scoop.run(['run', 'list-and-page']);
  expect(run.code, run.stderr).toBe(0);
  const out = JSON.parse(run.stdout) as Record<string, Record<string, unknown>[]>;
  expect(out.items!.map((row) => row.title)).toEqual(dataset.map((p) => p.title));
  expect(out.items!.map((row) => row.price)).toEqual(dataset.map((p) => p.price));
  expect(out.page).toEqual([{ _page: 1, _index: 0, category: 'Electronics' }]);
});
