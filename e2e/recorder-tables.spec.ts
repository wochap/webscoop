import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { currentTable, loadRecipe, tablesOf, type Recipe, type RecipeInput } from '@webscoop/core';
import { dataset } from '@webscoop/playground';
import { expect, hasDisplay, test, type Recording } from './fixtures';

test.skip(!hasDisplay, 'the recorder needs WAYLAND_DISPLAY or DISPLAY');

const NAME = 'catalog-tables';
const template = (port: number) => `http://127.0.0.1:${port}/catalog?tier={tier}&mixed=1`;

/** Rename the active table's last field and wait for the host to take it. */
async function renameLast(r: Recording, name: string): Promise<void> {
  const count = await r.count('[data-ws="field-name"]');
  await r.fill('[data-ws="field-name"]', name, count - 1);
  await r.until((s) => s.host && currentTable(s.host.draft).fields.at(-1)?.name === name);
}

/** Rename the active table and wait for the host to take it. */
async function renameTable(r: Recording, name: string): Promise<void> {
  await r.fill('[data-ws="table-name"]', name);
  await r.until((s) => s.host && currentTable(s.host.draft).name === name);
}

/** Add a table from the strip; it becomes active. */
async function addTable(r: Recording): Promise<void> {
  const before = (await r.state()).host!.draft.tables.length;
  await r.clickPanel('[data-ws="table-add"]');
  await r.until((s) => s.host?.draft.tables.length === before + 1 && s.host.draft.activeTable === before);
}

/** The recipe recorded by the first scenario, kept for the second. */
let recorded: Recipe | undefined;

test.describe.configure({ mode: 'serial' });

test('records products, the page heading, and the questions blocks as three tables, and runs them', async ({ scoop }) => {
  const port = scoop.playground.port;
  const r = await scoop.record([template(port), '--var', 'tier=0', '--name', NAME]);

  // products: one title proposes the product cards.
  const picked = await r.pick('h2.product-title', 0);
  expect(picked.mode).toBe('items');
  await r.key('Enter');
  await r.until((s) => s.host?.draft.tables[0]!.item?.count === 24 && s.host.draft.tables[0]!.fields.length === 1);
  await renameLast(r, 'title');
  await renameTable(r, 'products');
  expect(await r.count('[data-ws="table-tab"]')).toBe(1);

  // page: added from the strip, the category heading goes to it.
  await addTable(r);
  expect(currentTable((await r.state()).host!.draft).name).toBe('page');
  const heading = await r.pick('h1.category-heading');
  expect(heading.host!.selected).toMatchObject({ scope: 'page', table: 1 });
  expect((await r.query('[data-ws="form-table"]'))!.value).toBe('1');
  await r.fill('[data-ws="form-name"]', 'category');
  await r.clickPanel('[data-ws="add-field"]');
  await r.until((s) => s.host?.draft.tables[1]!.fields.length === 1);

  // questions: a new table, one question heading proposes the questions blocks.
  await addTable(r);
  await renameTable(r, 'questions');
  const question = await r.pick('h3.questions-title', 0);
  expect(question.mode).toBe('items');
  await r.submit('[data-ws="level-input-item"]', '.mixed-questions');
  const proposal = await r.until((s) => (s.host?.proposal?.proposed.count === 6 ? s.host.proposal : undefined));
  expect(proposal.proposed.selectors[0]!.value).toBe('.mixed-questions');
  // Focus is still in the selector input, where Enter does not confirm.
  await r.clickPanel('[data-ws="confirm-items"]');
  await r.until((s) => s.host?.draft.tables[2]!.item?.count === 6 && s.host.draft.tables[2]!.fields.length === 1);
  await renameLast(r, 'title');

  const { draft } = (await r.state()).host!;
  expect(draft.tables.map((t) => [t.name, t.item?.count ?? null, t.fields.map((f) => [f.name, f.scope, f.count])])).toEqual([
    ['products', 24, [['title', 'item', 24]]],
    ['page', null, [['category', 'page', 1]]],
    ['questions', 6, [['title', 'item', 6]]],
  ]);
  expect(await r.count('[data-ws="table-tab"]')).toBe(3);
  // The inactive tables are collapsed to their fields.
  expect(await r.count('[data-ws="table-card"]')).toBe(2);

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
