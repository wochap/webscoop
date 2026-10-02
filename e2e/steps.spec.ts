import { readFile } from 'node:fs/promises';
import { loadRecipe, type RecipeInput, type RunReport } from '@webscoop/core';
import { dataset } from '@webscoop/playground';
import { expect, hasDisplay, PAGED_RECIPE, referenceRecipe, test, type Recording, type Scoop } from './fixtures';
import { ws } from './sidebar';

test.skip(!hasDisplay, 'the recorder and the CLI need WAYLAND_DISPLAY or DISPLAY');

type StepInput = NonNullable<RecipeInput['flows']>[number]['steps'][number];

/** The reference recipe under another name, on a gated catalog, with its steps in a `setup` flow before the extract. */
function gatedRecipe(scoop: Scoop, name: string, gate: string, steps: StepInput[] = []): RecipeInput {
  const recipe = structuredClone(scoop.recipe);
  recipe.name = name;
  recipe.url = `${recipe.url}&gate=${gate}`;
  if (steps.length > 0) {
    recipe.flows = [{ name: 'setup', steps }];
    recipe.sequence = [{ flow: 'setup' }, { extract: 'items' }];
  }
  return recipe;
}

const stepsOf = (s: { host: { draft: { flows: { steps: unknown[] }[] } } | null }) => s.host?.draft.flows[0]?.steps.length ?? 0;

async function save(r: Recording): Promise<string> {
  await r.key('Control+s');
  const saved = await r.until((s) => (s.host?.saved && !s.host.draft.dirty ? s.host.saved : undefined));
  return saved.path!;
}

/** Record from an existing recipe (its fields already there), wait for the counts. */
async function edit(scoop: Scoop, name: string): Promise<Recording> {
  const r = await scoop.record(['--edit', name]);
  await r.until((s) => s.host?.draft.tables[0]!.fields.every((f) => f.count !== null));
  return r;
}

test('gate=cookie: browse mode records the consent click into a setup flow; the run replays it, and --skip-flows exits 3', async ({ scoop }) => {
  await scoop.writeRecipe(gatedRecipe(scoop, 'cookie-shop', 'cookie'));
  const r = await edit(scoop, 'cookie-shop');
  expect(await r.page.locator('article').count()).toBe(0);
  await r.browse();
  await r.click('#consent-accept');
  await expect.poll(() => r.page.locator('article').count()).toBe(24);
  const state = await r.until((s) => (stepsOf(s) === 1 ? s : undefined));
  expect(state.host!.draft.flows.map((f) => f.name)).toEqual(['setup']);
  expect(state.host!.draft.sequence.blocks).toEqual([{ flow: 'setup' }, { extract: 'items' }]);
  expect(state.host!.draft.flows[0]!.steps[0]).toMatchObject({ kind: 'click', window: 'same', optional: false });
  expect(state.host!.draft.flows[0]!.steps[0]!.target!.fingerprint).toMatchObject({ tag: 'button', textSample: 'Accept all' });

  // The select helper drives a real select while browsing; that step is dropped again.
  await r.page.evaluate(() => document.querySelector('main')!.insertAdjacentHTML('afterbegin', '<select id="sort"><option value="name">Name</option><option value="price">Price</option></select>'));
  await r.selectOnPage('#sort', 'price');
  await r.until((s) => stepsOf(s) === 2 && s.host!.draft.flows[0]!.steps[1]!.kind === 'fill' && s.host!.draft.flows[0]!.steps[1]!.value === 'price');
  await r.clickPanel(ws('step-remove'), 1);
  await r.until((s) => stepsOf(s) === 1);
  await r.key('b');
  await r.until((s) => !s.ui.browsing);
  // Consent now lives in the recording profile, so later loads there skip the banner.
  await r.clickPanel(ws('step-edit-toggle'));
  await r.clickPanel(ws('step-optional'));
  await r.until((s) => s.host?.draft.flows[0]?.steps[0]?.optional === true);
  const path = await save(r);
  expect((await r.closeWindow()).code).toBe(0);
  const recipe = loadRecipe(await readFile(path, 'utf8'));
  expect(recipe.flows[0]!.steps).toHaveLength(1);
  expect(recipe.flows[0]!.steps[0]).toMatchObject({ kind: 'click', optional: true });

  const run = await scoop.run(['run', 'cookie-shop', '--profile', 'fresh-cookie']);
  expect(run.code, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toHaveLength(24);
  expect(run.stderr).toMatch(/flow setup \(called\) on page 1/);
  expect(run.stderr).toMatch(/setup step 0 \(click\) on page 1: ok/);

  const skipped = await scoop.run(['run', 'cookie-shop', '--profile', 'fresh-skip', '--skip-flows', '--no-guards']);
  expect(skipped.code, skipped.stderr).toBe(3);
  expect(skipped.stderr).not.toMatch(/setup step 0/);
});

test('gate=search: typing and Enter become fill and press steps, the value becomes {q}, and the run searches with --var q', async ({ scoop }) => {
  await scoop.writeRecipe(gatedRecipe(scoop, 'search-shop', 'search'));
  const r = await edit(scoop, 'search-shop');
  await r.browse();
  await r.typeOnPage('input[name="q"]', 'mouse');
  await r.key('Enter');
  await r.page.waitForURL(/[?&]q=mouse/);
  const recorded = await r.until((s) => (stepsOf(s) === 2 ? s.host!.draft.flows[0]!.steps : undefined));
  expect(recorded.map((s) => [s.kind, s.value])).toEqual([
    ['fill', 'mouse'],
    ['press', 'Enter'],
  ]);
  // The panel came back on the results page.
  expect(await r.count(ws('section-flows'))).toBe(1);

  await r.clickPanel(ws('step-edit-toggle'), 0);
  await r.fill(ws('step-value'), '{q}', 0);
  await r.until((s) => s.host?.draft.flows[0]?.steps[0]?.value === '{q}' && s.host.draft.vars.some((v) => v.name === 'q'));
  expect(await r.count(ws('step-var-q'))).toBe(1);
  const path = await save(r);
  expect((await r.closeWindow()).code).toBe(0);
  const recipe = loadRecipe(await readFile(path, 'utf8'));
  expect(recipe.vars.find((v) => v.name === 'q')).toEqual({ name: 'q', type: 'string' });
  expect(recipe.flows[0]!.steps.map((s) => [s.kind, s.value])).toEqual([
    ['fill', '{q}'],
    ['press', 'Enter'],
  ]);

  const run = await scoop.run(['run', 'search-shop', '--var', 'q=mouse', '--report']);
  expect(run.code, run.stderr).toBe(0);
  const rows = JSON.parse(run.stdout) as { title: string }[];
  expect(rows.map((row) => row.title)).toEqual(dataset.filter((p) => /mouse/i.test(p.title)).map((p) => p.title));
  const report = JSON.parse(run.stderr.slice(run.stderr.indexOf('{'), run.stderr.lastIndexOf('}') + 1)) as RunReport;
  const final = new URL(report.finalUrl!);
  expect(final.pathname).toBe('/catalog');
  expect(final.searchParams.get('gate')).toBe('search');
  expect(final.searchParams.get('q')).toBe('mouse');
  expect(report.steps.map((s) => s.outcome)).toEqual(['ok', 'ok']);
});

test('gate=tabs with paginate=url: a flow inside the paginate block opens the tab on each of 3 pages', async ({ scoop }) => {
  const recipe = referenceRecipe(scoop.playground.port, PAGED_RECIPE);
  recipe.name = 'tabs-shop';
  recipe.url = recipe.url.replace('&page={page}', '&gate=tabs&page={page}');
  recipe.flows = [{ name: 'products-tab', steps: [{ kind: 'click', target: { selectors: [{ strategy: 'role', value: 'tab|Products', stability: 'stable' }] } }] }];
  const block = recipe.sequence[0] as Extract<RecipeInput['sequence'][number], { paginate: unknown }>;
  recipe.sequence = [{ paginate: { ...block.paginate, do: [{ flow: 'products-tab' }, { extract: 'items' }] } }];
  await scoop.writeRecipe(recipe);
  const run = await scoop.run(['run', 'tabs-shop', '--pages', '3']);
  expect(run.code, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toHaveLength(24);
  expect(run.stderr.match(/products-tab step 0 \(click\) on page \d: ok/g)).toEqual([
    'products-tab step 0 (click) on page 1: ok',
    'products-tab step 0 (click) on page 2: ok',
    'products-tab step 0 (click) on page 3: ok',
  ]);
  expect(run.stderr).toMatch(/24 rows from 3 pages in/);
});

test('tier 1 heals the consent step by fingerprint and writes it back to its flow; test runs flows', async ({ scoop }) => {
  await scoop.writeRecipe(gatedRecipe(scoop, 'heal-cookie', 'cookie'));
  const r = await edit(scoop, 'heal-cookie');
  await r.browse();
  await r.click('#consent-accept');
  await r.until((s) => stepsOf(s) === 1);
  await r.key('b');
  await save(r);
  expect((await r.closeWindow()).code).toBe(0);
  const recorded = loadRecipe(await readFile(scoop.recipePath.replace('playground-catalog', 'heal-cookie'), 'utf8'));
  // Keep only the selectors tier 1 churns (id and classes), with the fingerprint the recorder captured.
  const oldPrimary = { strategy: 'id' as const, value: 'consent-accept', stability: 'stable' as const };
  recorded.flows[0]!.steps[0]!.target!.selectors = [oldPrimary, { strategy: 'css', value: 'button.consent-button', stability: 'medium' }];
  expect(recorded.flows[0]!.steps[0]!.target!.fingerprint).toMatchObject({ tag: 'button', textSample: 'Accept all' });
  await scoop.writeRecipe(recorded);

  const tested = await scoop.run(['test', 'heal-cookie', '--profile', 'fresh-test']);
  expect(tested.code, tested.stderr).toBe(0);
  expect(tested.stderr).toMatch(/setup step 0 \(click\) on page 1: ok/);

  const run = await scoop.run(['run', 'heal-cookie', '--var', 'tier=1', '--profile', 'fresh-heal']);
  expect(run.code, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toHaveLength(24);
  expect(run.stderr).toMatch(/setup step 0 \(click\) on page 1: healed, fuzzy [01]\.\d\d/);
  expect(run.stderr).toMatch(/healed setup:0: fuzzy/);
  const after = loadRecipe(await readFile(scoop.recipePath.replace('playground-catalog', 'heal-cookie'), 'utf8'));
  expect(after.flows[0]!.steps[0]!.target!.selectors[0]).not.toEqual(oldPrimary);
  expect(after.flows[0]!.steps[0]!.target!.fingerprint).toBeDefined();
});

test('replaying one step from the panel fills the search box', async ({ scoop }) => {
  await scoop.writeRecipe(
    gatedRecipe(scoop, 'replay-shop', 'search', [
      { kind: 'fill', target: { selectors: [{ strategy: 'css', value: 'input[name="q"]', stability: 'medium' }] }, value: 'keyboard' },
    ]),
  );
  const r = await edit(scoop, 'replay-shop');
  expect(await r.page.locator('input[name="q"]').inputValue()).toBe('');
  await r.clickPanel(ws('step-replay'));
  await expect.poll(() => r.page.locator('input[name="q"]').inputValue()).toBe('keyboard');
  await expect.poll(async () => (await r.query(ws('panel-toast')))?.text ?? '').toContain('replayed step 1 (fill)');
  expect((await r.closeWindow()).code).toBe(0);
});
