import { readFile } from 'node:fs/promises';
import { loadRecipe } from '@webscoop/core';
import { dataset } from '@webscoop/playground';
import { expect, hasDisplay, test } from './fixtures';
import { sidebar, template, ws } from './sidebar';

test.skip(!hasDisplay, 'the recorder needs WAYLAND_DISPLAY or DISPLAY');

test('type a selector, clear with Esc, edit a primary, cancel an edit, save, and run the edited recipe', async ({ scoop }) => {
  const r = await scoop.record([template(scoop.playground.port), '--var', 'tier=0', '--name', 'edited']);
  const panel = sidebar(r);
  await panel.titlesAsList();
  expect((await r.state()).host!.selected).toBeNull();

  // A typed item selector selects the first card's heading, with its coverage.
  await r.fill(ws('pick-selector'), 'css=h2');
  await r.clickPanel(ws('pick-selector-go'));
  const typed = await r.until((s) => (s.host?.selected?.selection.candidates[0]?.value === 'h2' ? s.host.selected : undefined));
  expect(typed.scope).toBe('item');
  expect(typed.selection.text).toBe(dataset[0]!.title);
  expect(typed.selection.candidates[0]).toMatchObject({ strategy: 'css', count: 24, items: 24 });
  expect((await r.query(ws('pick-coverage-count')))!.text).toBe('24 / 24 items');
  await r.fill(ws('pick-form-name'), 'heading');
  await r.clickPanel(ws('pick-add-field'));
  await r.until((s) => s.host!.draft.tables[0]!.fields.length === 2 && s.host!.selected === null);
  expect((await r.state()).host!.draft.tables[0]!.fields[1]).toMatchObject({ name: 'heading', scope: 'item', count: 24 });

  // Esc when not picking clears the selection and its highlight.
  await r.pick('[data-testid="price"]', 3);
  await r.key('Escape');
  await r.until((s) => s.host?.selected === null);
  const boxes = await r.page.evaluate(() => (window as unknown as { __webscoopTest: { boxes(): { variant: string }[] } }).__webscoopTest.boxes());
  expect(boxes.some((b) => b.variant === 'selected')).toBe(false);
  expect(await r.count(ws('pick-inspector'))).toBe(0);

  // Edit the price field's primary candidate and update it in place.
  await panel.addField('price', { selector: '[data-testid="price"]' });
  await r.clickPanel(ws('field-edit'), 2);
  const editing = await r.until((s) => (s.host?.editing && s.host.selected ? s : undefined));
  expect(editing.mode).toBe('editing');
  expect(editing.host!.selected!.selection.text).toBe(`$${dataset[0]!.price.toFixed(2)}`);
  const candidates = editing.host!.selected!.selection.candidates;
  const other = candidates.findIndex((c, i) => i > 0 && c.count === 24);
  expect(other).toBeGreaterThan(0);
  await r.clickPanel(ws('pick-candidate'), other);
  await r.until((s) => s.host?.selected?.primary === other);
  await r.clickPanel(ws('pick-update'));
  const updated = await r.until((s) => (s.host?.editing === null && s.host.selected === null ? s.host : undefined));
  expect(updated.draft.tables[0]!.fields.map((f) => f.name)).toEqual(['title', 'heading', 'price']);
  expect(updated.draft.tables[0]!.fields[2]!.selectors[0]).toMatchObject({ strategy: candidates[other]!.strategy, value: candidates[other]!.value });

  // Cancel an edit: the title keeps its type.
  await r.clickPanel(ws('field-summary'), 0);
  await r.until((s) => s.host?.editing?.index === 0 && s.host.selected);
  await r.clickPanel(ws('pick-form-type'));
  await r.clickPanel(ws('pick-form-type-option', '[data-value="html"]'));
  expect((await r.query(ws('pick-form-type')))!.value).toBe('html');
  await r.clickPanel(ws('pick-cancel-edit'));
  const cancelled = await r.until((s) => (s.host?.editing === null ? s.host : undefined));
  expect(cancelled.draft.tables[0]!.fields[0]).toMatchObject({ name: 'title', type: 'text' });

  const path = await panel.save();
  const result = await r.closeWindow();
  expect(result.code, result.stderr).toBe(0);
  const recipe = loadRecipe(await readFile(path, 'utf8'));
  expect(recipe.fields![2]!.selectors[0]).toMatchObject({ strategy: candidates[other]!.strategy, value: candidates[other]!.value });
  const run = await scoop.run(['run', 'edited']);
  expect(run.code, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual(dataset.map((p, index) => ({ _page: 1, _index: index, title: p.title, heading: p.title, price: p.price })));
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
  expect(await r.count(ws('field-replay-steps'))).toBeGreaterThan(0);
  expect((await r.query(ws('field-zero')))!.text).toContain('may appear only after the recorded steps');
  await r.clickPanel(ws('field-replay-steps'));
  await r.until((s) => s.host?.draft.tables[0]!.fields[0]!.count === 24);
  await expect.poll(() => r.page.locator('article').count()).toBe(24);
  expect(await r.count(ws('field-replay-steps'))).toBe(0);
  expect((await r.closeWindow()).code).toBe(0);
});

test('results with a questions block among the containers: it is highlighted, and the test run drops its row with fallback off and keeps it with fallback on', async ({ scoop }) => {
  await scoop.writeRecipe({
    schemaVersion: 1,
    name: 'serp-fallback',
    url: `http://127.0.0.1:${scoop.playground.port}/results`,
    item: {
      within: [{ strategy: 'id', value: 'rso', stability: 'stable' }],
      selectors: [{ strategy: 'css', value: ':scope > div > div', stability: 'fragile' }],
    },
    fields: [
      {
        name: 'title',
        type: 'text',
        scope: 'item',
        // The second candidate matches only the questions block's label in rows where the heading is missing.
        selectors: [
          { strategy: 'css', value: 'h3.LC20lb', stability: 'medium' },
          { strategy: 'css', value: 'span', stability: 'fragile' },
        ],
      },
    ],
  });
  const r = await scoop.record(['--edit', 'serp-fallback']);
  const panel = sidebar(r);
  const counted = await r.until((s) => (s.host?.draft.tables[0]!.fields[0]!.coverage ? s : undefined));
  expect(counted.host!.draft.tables[0]!.item!.count).toBe(9);
  expect(counted.host!.draft.tables[0]!.fields[0]!.coverage).toEqual({ matched: 8, total: 9 });
  expect((await r.query(ws('field-coverage')))!.text).toBe('8/9');
  expect((await r.query(ws('field-coverage')))!.attrs['data-partial']).toBe('true');
  // The row shows the field's own chip; the stack is in the Rows section.
  expect(await r.count(`${ws('field')} ${ws('chip')}`)).toBe(1);
  expect((await r.query(ws('field-summary')))!.attrs['data-chain']).toMatch(/^id=rso » css=:scope > div > div » /);
  expect(await r.count(`${ws('rows-stack')} ${ws('stack-level')}`)).toBe(2);

  // Every container the runner resolves is highlighted, the questions block included.
  const highlight = () =>
    r.page.evaluate(() => {
      const boxes = (window as unknown as { __webscoopTest: { boxes(): { variant: string; rect: { x: number; y: number; w: number; h: number } }[] } }).__webscoopTest
        .boxes()
        .filter((b) => b.variant === 'container');
      const q = document.querySelector('#rso .Wt5Tfe')!.getBoundingClientRect();
      return { count: boxes.length, questions: boxes.some((b) => b.rect.x === q.x && b.rect.y === q.y && b.rect.w === q.width && b.rect.h === q.height) };
    });
  await expect.poll(highlight).toEqual({ count: 9, questions: true });

  const off = await panel.testRun();
  expect(off.tables[0]!.rowCount).toBe(8);
  expect(off.tables[0]!.dropped).toEqual({ count: 1, fields: ['title'] });

  await r.clickPanel(ws('field-fallback'));
  await r.until((s) => s.host?.draft.tables[0]!.fields[0]!.fallback === true);
  await r.clickPanel(ws('footer-test'));
  const on = await r.until((s) => (s.host?.test?.tables[0]!.rowCount === 9 ? s.host.test : undefined));
  expect(on.tables[0]!.rows.map((row) => row.title)).toContain('People also ask');

  const path = await panel.save();
  expect((await r.closeWindow()).code).toBe(0);
  expect(JSON.parse(await readFile(path, 'utf8')).fields[0].fallback).toBe(true);
});
