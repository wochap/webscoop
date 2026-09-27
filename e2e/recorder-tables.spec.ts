import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { currentTable, loadRecipe, tablesOf, type Recipe, type RecipeInput } from '@webscoop/core';
import { dataset } from '@webscoop/playground';
import { expect, hasDisplay, test, type Recording } from './fixtures';

test.skip(!hasDisplay, 'the recorder needs WAYLAND_DISPLAY or DISPLAY');

const NAME = 'catalog-tables';
const template = (port: number) => `http://127.0.0.1:${port}/catalog?tier={tier}&mixed=1`;

/** Rename the active table from its menu and wait for the host to take it. */
async function renameTable(r: Recording, name: string): Promise<void> {
  await r.clickPanel('[data-ws="tab-menu"]');
  await r.clickPanel('[data-ws="menu-rename"]');
  await r.fill('[data-ws="table-name"]', name);
  await r.until((s) => s.host && currentTable(s.host.draft).name === name);
}

/** Add a table from the strip; it becomes active. */
async function addTable(r: Recording): Promise<void> {
  const before = (await r.state()).host!.draft.tables.length;
  await r.clickPanel('[data-ws="table-add"]');
  await r.until((s) => s.host?.draft.tables.length === before + 1 && s.host.draft.activeTable === before);
}

/** Pick an element in a table with no mode, open the list setup from the suggestion (or the item row for `item`), and accept it. */
async function setUpList(r: Recording, selector: string, item?: string): Promise<void> {
  const table = (await r.state()).host!.draft.activeTable;
  const picked = await r.pick(selector, 0);
  expect(picked.host!.selected!.suggestion).not.toBeNull();
  await r.key('l');
  await r.until((s) => s.host?.proposal);
  if (item) {
    await r.clickPanel('[data-ws="setup-row-item"]');
    await r.submit('[data-ws="level-input-item"]', item);
    await r.until((s) => s.host?.proposal?.proposed.selectors[0]?.value === item.replace(/^css=/, ''));
  }
  // Focus may still be in the selector input, where Enter does not accept.
  await r.clickPanel('[data-ws="confirm-items"]');
  await r.until((s) => (s.host?.draft.tables[table]!.item && !s.host.proposal ? s : undefined));
}

/** Add the selection as a field of the active table. */
async function addSelected(r: Recording, name: string): Promise<void> {
  const before = currentTable((await r.state()).host!.draft).fields.length;
  await r.fill('[data-ws="form-name"]', name);
  await r.clickPanel('[data-ws="add-field"]');
  await r.until((s) => s.host && currentTable(s.host.draft).fields.length === before + 1 && s.host.selected === null);
}

/** The recipe recorded by the first scenario, kept for the second. */
let recorded: Recipe | undefined;

test.describe.configure({ mode: 'serial' });

test('records products, the page heading, and the questions blocks as three tables, and runs them', async ({ scoop }) => {
  const port = scoop.playground.port;
  const r = await scoop.record([template(port), '--var', 'tier=0', '--name', NAME]);

  // products: one title suggests the product cards; accepting returns to the title, read inside each card.
  await setUpList(r, 'h2.product-title');
  expect((await r.state()).host!.draft.tables[0]!.item!.count).toBe(24);
  expect((await r.state()).host!.selected!.scope).toBe('item');
  await addSelected(r, 'title');
  expect(currentTable((await r.state()).host!.draft).name).toBe('items');
  await renameTable(r, 'products');
  expect(await r.count('[data-ws="table-tab"]')).toBe(1);

  // page: added from the strip, the category heading goes to it.
  await addTable(r);
  expect(currentTable((await r.state()).host!.draft).name).toBe('page');
  const heading = await r.pick('h1.category-heading');
  expect(heading.host!.selected).toMatchObject({ scope: 'page', table: 1 });
  // The active tab is the target: no table choice in the form.
  expect(await r.count('[data-ws="form-table"]')).toBe(0);
  await r.fill('[data-ws="form-name"]', 'category');
  await r.clickPanel('[data-ws="add-field"]');
  await r.until((s) => s.host?.draft.tables[1]!.fields.length === 1);

  // questions: a new table, one question heading proposes the questions blocks.
  await addTable(r);
  await renameTable(r, 'questions');
  await setUpList(r, 'h3.questions-title', 'css=.mixed-questions');
  expect((await r.state()).host!.draft.tables[2]!.item!.count).toBe(6);
  await addSelected(r, 'title');

  const { draft } = (await r.state()).host!;
  expect(draft.tables.map((t) => [t.name, t.item?.count ?? null, t.fields.map((f) => [f.name, f.scope, f.count])])).toEqual([
    ['products', 24, [['title', 'item', 24]]],
    ['page', null, [['category', 'page', 1]]],
    ['questions', 6, [['title', 'item', 6]]],
  ]);
  expect(await r.count('[data-ws="table-tab"]')).toBe(3);
  // Only the active table's content shows; the tabs stand for the others.
  expect(await r.count('[data-ws="table-card"]')).toBe(0);
  expect((await r.query('[data-ws="table-content"]'))!.attrs['data-table']).toBe('questions');
  expect(await r.count('[data-ws="field"]')).toBe(1);

  await r.clickPanel('[data-ws="test-run"]');
  const results = await r.until((s) => s.host?.test);
  expect(results.error).toBeUndefined();
  expect(results.tables.map((t) => [t.name, t.rowCount])).toEqual([
    ['products', 24],
    ['page', 1],
    ['questions', 6],
  ]);
  expect(await r.count('[data-ws="result-tab"]')).toBe(3);
  // The drawer opens on the active table.
  expect(await r.count('[data-ws="result-row"]')).toBe(6);

  await r.key('Control+s');
  const saved = await r.until((s) => s.host?.saved);
  const result = await r.closeWindow();
  expect(result.code, result.stderr).toBe(0);

  const recipe = loadRecipe(await readFile(saved.path!, 'utf8'));
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
  expect((await r.query('[data-ws="repick-field"]'))!.text).toBe('questions.title');
  await r.pick('button.questions-option', 0);
  await r.until((s) => s.host?.repickContext?.picked);
  await r.clickPanel('[data-ws="repick-confirm"]');
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

  // products, then questions: two lists.
  await setUpList(r, 'h2.product-title');
  await addSelected(r, 'title');
  await renameTable(r, 'products');
  await addTable(r);
  await renameTable(r, 'questions');
  await setUpList(r, 'h3.questions-title', 'css=.mixed-questions');
  await addSelected(r, 'title');
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
  await r.clickPanel('[data-ws="mark-pagination"]');
  await r.until((s) => s.host?.draft.pagination);
  const badge = (table: string) => r.count(`[data-ws="table-tab"][data-table="${table}"] [data-ws="drives-pagination"]`);
  expect(await badge('products')).toBe(1);
  expect(await badge('questions')).toBe(0);

  // Drag questions before products: the order is saved, and the new primary table is announced.
  const from = (await r.query('[data-ws="table-tab"]', 1))!.rect;
  const to = (await r.query('[data-ws="table-tab"]', 0))!.rect;
  await r.page.mouse.move(from.x + from.w / 2, from.y + from.h / 2);
  await r.page.mouse.down();
  await r.page.mouse.move(to.x + 6, to.y + to.h / 2, { steps: 8 });
  await r.page.mouse.move(to.x + 4, to.y + to.h / 2, { steps: 2 });
  await r.page.mouse.up();
  await r.until((s) => s.host?.draft.tables.map((t) => t.name).join() === 'questions,products');
  expect(await badge('questions')).toBe(1);
  expect(await badge('products')).toBe(0);
  await expect.poll(async () => (await r.query('[data-ws="toast"]'))?.text ?? '').toContain('questions now drives pagination');

  // Collapse Steps, then navigate: the panel comes back with Steps still collapsed.
  await r.clickPanel('[data-ws="section-steps"] [data-ws="section-toggle"]');
  await r.until((s) => s.host?.panel.collapsed.steps === true);
  await r.page.goto(`http://127.0.0.1:${port}/catalog?tier=1&mixed=1`);
  await r.until((s) => s.host?.url.includes('tier=1'));
  await expect.poll(async () => (await r.query('[data-ws="section-steps"]'))?.attrs['data-collapsed'] ?? null).toBe('true');

  await r.key('Control+s');
  const saved = await r.until((s) => s.host?.saved);
  expect((await r.closeWindow()).code).toBe(0);
  const recipe = loadRecipe(await readFile(saved.path!, 'utf8'));
  expect(tablesOf(recipe).map((t) => t.name)).toEqual(['questions', 'products']);
  expect(JSON.stringify(recipe)).not.toMatch(/collapsed/);
});

test('records a list and a page table through the suggestion and the outside banner, clears and redoes the list, and runs it', async ({ scoop }) => {
  const port = scoop.playground.port;
  const r = await scoop.record([`http://127.0.0.1:${port}/catalog?tier={tier}`, '--var', 'tier=0', '--name', 'list-and-page']);
  expect((await r.query('[data-ws="table-kind"]'))!.text).toBe('No mode yet');

  // A first list, then Clear table from the menu: the table has no mode again.
  await setUpList(r, 'h2.product-title');
  await addSelected(r, 'wrong');
  await r.clickPanel('[data-ws="tab-menu"]');
  expect((await r.query('[data-ws="menu-mode-locked"]'))!.text).toContain('Mode locked — list');
  await r.clickPanel('[data-ws="menu-clear-table"]');
  await r.until((s) => s.host?.draft.tables[0]!.item === null && s.host.draft.tables[0]!.fields.length === 0);
  expect((await r.query('[data-ws="table-kind"]'))!.text).toBe('No mode yet');

  // The list again, from the suggestion.
  await setUpList(r, 'h2.product-title');
  await addSelected(r, 'title');
  await r.pick('[data-testid="price"]', 0);
  await addSelected(r, 'price');
  expect((await r.query('[data-ws="table-kind"]'))!.text).toBe('List · 24 rows');

  // The heading is outside the list: the banner makes a page table and keeps the pick.
  await r.pick('h1.category-heading');
  expect((await r.query('[data-ws="outside-banner"]'))!.text).toContain('Outside the items list');
  expect((await r.query('[data-ws="outside-table-name"]'))!.value).toBe('page');
  await r.clickPanel('[data-ws="outside-new-page"]');
  const moved = await r.until((s) => (s.host?.draft.activeTable === 1 && s.host.selected?.table === 1 ? s.host : undefined));
  expect(moved.draft.tables[1]!.fields).toHaveLength(0);
  expect(moved.selected!.scope).toBe('page');
  await addSelected(r, 'category');
  expect((await r.query('[data-ws="table-kind"]'))!.text).toBe('Page · 1 row');

  await r.key('Control+s');
  const saved = await r.until((s) => s.host?.saved);
  expect((await r.closeWindow()).code).toBe(0);
  const recipe = loadRecipe(await readFile(saved.path!, 'utf8'));
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
