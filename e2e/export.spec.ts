import { existsSync } from 'node:fs';
import { exportAndRun, hasPythonPlaywright, PYTHON, type ExportFormat } from './export-fixture';
import { expect, hasDisplay, PAGED_RECIPE, POSITIONAL_RECIPE, referenceRecipe, STEPS_RECIPE, test, type Scoop } from './fixtures';

test.skip(!hasDisplay, 'webscoop run, the reference for the rows, needs WAYLAND_DISPLAY or DISPLAY');

/** Rows `webscoop run` prints for the same recipe and arguments. */
async function runRows(scoop: Scoop, recipe: string, args: string[] = []): Promise<unknown[]> {
  const run = await scoop.run(['run', recipe, ...args]);
  expect(run.code, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as unknown[];
}

for (const format of ['ts', 'py'] as const satisfies readonly ExportFormat[]) {
  test.describe(`exported ${format === 'ts' ? 'TypeScript' : 'Python'} script`, () => {
    if (format === 'py' && !hasPythonPlaywright) {
      console.log(`skipping the Python export cases: ${PYTHON} cannot import playwright (set WEBSCOOP_E2E_PYTHON to an interpreter that can)`);
    }
    test.skip(format === 'py' && !hasPythonPlaywright, `${PYTHON} cannot import playwright`);

    test('catalog and positional recipes on tier 0 emit the rows webscoop run emits', async ({ scoop }) => {
      const catalog = await exportAndRun(scoop, 'playground-catalog', format);
      expect(catalog.code, catalog.stderr).toBe(0);
      expect(catalog.rows).toHaveLength(24);
      expect(catalog.rows).toEqual(await runRows(scoop, 'playground-catalog'));
      // The script removed its temporary profile, and the helper the exported file.
      expect(catalog.leftovers).toEqual([]);
      expect(existsSync(catalog.scratch)).toBe(false);

      await scoop.writeRecipe(referenceRecipe(scoop.playground.port, POSITIONAL_RECIPE));
      const positional = await exportAndRun(scoop, 'playground-positional', format);
      expect(positional.code, positional.stderr).toBe(0);
      expect(positional.rows).toHaveLength(24);
      expect(positional.rows).toEqual(await runRows(scoop, 'playground-positional'));
    });

    test('the paged recipe with --pages all walks 3 pages like webscoop run --pages all', async ({ scoop }) => {
      await scoop.writeRecipe(referenceRecipe(scoop.playground.port, PAGED_RECIPE));
      const paged = await exportAndRun(scoop, 'playground-paged', format, ['--pages', 'all']);
      expect(paged.code, paged.stderr).toBe(0);
      expect(paged.rows).toHaveLength(24);
      expect(new Set(paged.rows.map((row) => row._page))).toEqual(new Set([1, 2, 3]));
      expect(paged.rows).toEqual(await runRows(scoop, 'playground-paged', ['--pages', 'all']));
    });

    test('the steps recipe accepts the cookie gate like webscoop run', async ({ scoop }) => {
      await scoop.writeRecipe(referenceRecipe(scoop.playground.port, STEPS_RECIPE));
      const steps = await exportAndRun(scoop, 'playground-steps', format);
      expect(steps.code, steps.stderr).toBe(0);
      expect(steps.stderr).toMatch(/step 0 "accept cookies" \(click\) on page 1: ok/);
      expect(steps.rows).toHaveLength(24);
      expect(steps.rows).toEqual(await runRows(scoop, 'playground-steps'));
    });

    test('a recipe with a list parent and a class candidate emits the rows webscoop run emits', async ({ scoop }) => {
      const recipe = structuredClone(scoop.recipe);
      recipe.name = 'within-catalog';
      recipe.url = `${recipe.url}&rows=4`;
      recipe.item = {
        ...recipe.item!,
        within: [
          { strategy: 'role', value: 'list', stability: 'stable' },
          { strategy: 'css', value: 'ul.product-list', stability: 'medium' },
        ],
      };
      recipe.fields = recipe.fields.map((f) =>
        f.name === 'title' ? { ...f, selectors: [{ strategy: 'class', value: 'h2.product-title', stability: 'medium' }, ...f.selectors] } : f,
      );
      await scoop.writeRecipe(recipe);
      const scoped = await exportAndRun(scoop, 'within-catalog', format);
      expect(scoped.code, scoped.stderr).toBe(0);
      expect(scoped.rows).toHaveLength(24);
      expect(scoped.rows).toEqual(await runRows(scoop, 'within-catalog'));

      recipe.name = 'lost-list';
      recipe.item.within = [{ strategy: 'css', value: 'ol.no-such-list', stability: 'medium' }];
      await scoop.writeRecipe(recipe);
      const lost = await exportAndRun(scoop, 'lost-list', format);
      expect(lost.code, lost.stderr).toBe(3);
      expect(lost.stderr).toMatch(/list parent \(item\.within\) matched no element/);
    });

    test('a required field matching nothing exits 3 with empty stdout', async ({ scoop }) => {
      const recipe = structuredClone(scoop.recipe);
      recipe.name = 'dead-price';
      recipe.fields = recipe.fields.map((f) => (f.name === 'price' ? { ...f, selectors: [{ strategy: 'css', value: '.no-such-price', stability: 'medium' }] } : f));
      await scoop.writeRecipe(recipe);
      const dead = await exportAndRun(scoop, 'dead-price', format);
      expect(dead.code, dead.stderr).toBe(3);
      expect(dead.stdout).toBe('');
      expect(dead.stderr).toMatch(/required field price matched no element/);
    });

    test('--jsonl prints one JSON object per row and nothing else', async ({ scoop }) => {
      const jsonl = await exportAndRun(scoop, 'playground-catalog', format, ['--jsonl', '--var', 'tier=0']);
      expect(jsonl.code, jsonl.stderr).toBe(0);
      const lines = jsonl.stdout.trimEnd().split('\n');
      expect(lines).toHaveLength(24);
      for (const line of lines) expect(JSON.parse(line)).toMatchObject({ _page: 1, title: expect.any(String) });
      expect(jsonl.rows).toEqual(await runRows(scoop, 'playground-catalog'));
    });
  });
}
