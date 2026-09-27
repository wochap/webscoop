import { readFile } from 'node:fs/promises';
import { loadRecipe } from '@webscoop/core';
import { dataset } from '@webscoop/playground';
import { expect, hasDisplay, test } from './fixtures';
import { expectedRows, sidebar, template, ws } from './sidebar';

test.skip(!hasDisplay, 'the recorder needs WAYLAND_DISPLAY or DISPLAY');

test('click one title, confirm 24 items, add fields, save, and run the saved recipe', async ({ scoop }) => {
  const port = scoop.playground.port;
  const r = await scoop.record([template(port), '--var', 'tier=0', '--name', 'shop-catalog']);
  const panel = sidebar(r);
  await panel.titlesAsList();
  const item = (await r.state()).host!.draft.tables[0]!.item!;
  expect(item.count).toBe(24);
  await panel.addField('price', { selector: '[data-testid="price"]' });
  await panel.addField('url', { selector: 'a.product-link' });
  await panel.addField('image', { selector: 'img.product-image' });
  await panel.addField('rating', { selector: '[data-testid="rating"]' });
  // The page heading is outside the list: Add field waits for a page table.
  await r.pick('h1.category-heading');
  expect(await r.count(ws('pick-outside-banner'))).toBe(1);
  expect((await r.query(ws('pick-add-field')))!.attrs['disabled']).toBeDefined();
  await r.key('Escape');
  await r.until((s) => s.host?.selected === null);

  const { draft } = (await r.state()).host!;
  expect(draft.tables[0]!.fields.map((f) => [f.name, f.type, f.scope, f.count])).toEqual([
    ['title', 'text', 'item', 24],
    ['price', 'number', 'item', 24],
    ['url', 'url', 'item', 24],
    ['image', 'image', 'item', 24],
    ['rating', 'number', 'item', 24],
  ]);
  expect(draft.tables[0]!.fields.every((f) => f.error === undefined)).toBe(true);
  const path = await panel.save();
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

test('rows=4: one title proposes 24 cards under the product list, kept as the list parent', async ({ scoop }) => {
  const r = await scoop.record([template(scoop.playground.port, '&rows=4'), '--var', 'tier=0', '--name', 'rows']);
  const panel = sidebar(r);
  await panel.setUpList('h2.product-title', { index: 5 });
  const proposal = (await r.state()).host!.proposal!;
  expect(proposal.proposed.count).toBe(24);
  expect(proposal.within!.label).toBe('ul.product-list');
  // A stack row turns into the selector input.
  await r.clickPanel(ws('list-row-within'));
  expect((await r.query(ws('list-input-within-strategy')))!.value).toBe('role');
  expect((await r.query(ws('list-input-within')))!.value).toBe('list');
  expect((await r.query(ws('list-count')))!.text).toBe('24');
  // The main flow saves and runs a list; here only the list parent and the count differ.
  const accepted = await panel.acceptList();
  const item = accepted.host!.draft.tables[0]!.item!;
  expect(item.count).toBe(24);
  expect(item.within![0]).toMatchObject({ strategy: 'role', value: 'list' });
  expect((await r.closeWindow()).code).toBe(0);
});

test('sponsored=2: excluding .sponsored leaves 22 items in the recipe and the run', async ({ scoop }) => {
  const port = scoop.playground.port;
  const r = await scoop.record([template(port, '&sponsored=2'), '--var', 'tier=0', '--name', 'no-ads']);
  const panel = sidebar(r);
  await panel.setUpList('h2.product-title', { index: 5 });
  await r.until((s) => s.host?.proposal?.proposed.count === 24);
  await r.submit(ws('list-exclude-input'), '.sponsored');
  await r.until((s) => s.host?.proposal?.proposed.count === 22);
  expect((await r.query(ws('list-count')))!.text).toBe('22');
  const boxes = await r.page.evaluate(() => (window as unknown as { __webscoopTest: { boxes(): { variant: string }[] } }).__webscoopTest.boxes());
  expect(boxes.filter((b) => b.variant === 'excluded')).toHaveLength(2);
  expect(boxes.filter((b) => b.variant === 'sibling')).toHaveLength(22);
  // Focus is still in the exclusion input, where Enter adds another exclusion; confirm with the button.
  const accepted = await panel.acceptList();
  expect(accepted.host!.draft.tables[0]!.item!.count).toBe(22);
  await panel.addField('title');
  const path = await panel.save();
  expect((await r.closeWindow()).code).toBe(0);

  const recipe = loadRecipe(await readFile(path, 'utf8'));
  expect(recipe.item!.exclude).toEqual([{ strategy: 'css', value: '.sponsored', stability: 'medium' }]);
  const run = await scoop.run(['run', 'no-ads']);
  expect(run.code, run.stderr).toBe(0);
  const rows = JSON.parse(run.stdout) as { title: string }[];
  expect(rows).toHaveLength(22);
  expect(rows.map((row) => row.title)).toEqual(dataset.slice(2).map((p) => p.title));
});

test('mixed=1: 24 cards with 6 skipped, include all shows 30, and the saved recipe runs 24 rows', async ({ scoop }) => {
  const r = await scoop.record([template(scoop.playground.port, '&mixed=1'), '--var', 'tier=0', '--name', 'mixed']);
  const panel = sidebar(r);
  await panel.setUpList('h2.product-title', { index: 2 });
  await r.until((s) => s.host?.proposal?.proposed.count === 24);
  expect((await r.state()).host!.proposal!.skipped).toBe(6);
  expect((await r.query(ws('list-skipped')))!.text).toBe('6 skipped as dissimilar');
  // Include all siblings sits inside "Adjust item level".
  await r.clickPanel(ws('list-adjust-item-toggle'));
  await r.clickPanel(ws('list-include-all'));
  await r.until((s) => s.host?.proposal?.proposed.count === 30 && s.host.proposal.skipped === 0);
  expect((await r.query(ws('list-count')))!.text).toBe('30');
  await r.clickPanel(ws('list-include-all'));
  await r.until((s) => s.host?.proposal?.proposed.count === 24 && s.host.proposal.skipped === 6);
  const accepted = await panel.acceptList();
  expect(accepted.host!.draft.tables[0]!.item!.count).toBe(24);
  await panel.addField('title');
  await panel.save();
  expect((await r.closeWindow()).code).toBe(0);

  const run = await scoop.run(['run', 'mixed']);
  expect(run.code, run.stderr).toBe(0);
  const rows = JSON.parse(run.stdout) as { title: string }[];
  expect(rows).toHaveLength(24);
  expect(rows.map((row) => row.title)).toEqual(dataset.map((p) => p.title));
});

test('edit items: move the confirmed cards to the broader level, update, cancel a second edit, save, and run', async ({ scoop }) => {
  const r = await scoop.record([template(scoop.playground.port), '--var', 'tier=0', '--name', 'edit-items']);
  const panel = sidebar(r);
  await panel.titlesAsList();
  await panel.addField('price', { selector: '[data-testid="price"]' });
  expect((await r.state()).host!.draft.tables[0]!.item!.fingerprint!.tag).toBe('article');

  await r.clickPanel(ws('rows-edit'));
  const editing = await r.until((s) => (s.host?.proposal?.origin === 'edit' ? s.host.proposal : null));
  expect(editing.proposed.count).toBe(24);
  expect((await r.query(ws('list-accept')))!.text).toContain('Update list');
  expect((await r.query(ws('list-was')))!.text).toContain('was 24');
  // The card is the only child of its list entry: the ladder folds it into the entry.
  await r.clickPanel(ws('list-adjust-item-toggle'));
  const ladder = await r.until((s) => s.host?.proposal?.itemLadder);
  expect(ladder[0]).toMatchObject({ distance: 0, likely: true, sameAs: 1 });
  expect(await r.count(ws('list-ladder-folded'))).toBe(1);
  await r.clickPanel(ws('list-ladder-row', '[data-distance="1"]'));
  await r.until((s) => s.host?.proposal?.proposed.tag === 'li');
  await r.clickPanel(ws('list-accept'));
  await r.until((s) => !s.host?.proposal && s.host?.draft.tables[0]!.item?.fingerprint?.tag === 'li');
  const updated = (await r.state()).host!.draft;
  expect(updated.tables[0]!.item!.count).toBe(24);
  expect(updated.tables[0]!.fields.map((f) => [f.name, f.scope, f.count])).toEqual([
    ['title', 'item', 24],
    ['price', 'item', 24],
  ]);

  await r.clickPanel(ws('rows-edit'));
  await r.until((s) => s.host?.proposal?.origin === 'edit');
  await r.clickPanel(ws('list-cancel'));
  await r.until((s) => !s.host?.proposal);
  const after = (await r.state()).host!.draft;
  expect(after.tables[0]!.item).toEqual(updated.tables[0]!.item);
  expect(after.tables[0]!.fields.map((f) => f.name)).toEqual(['title', 'price']);

  const path = await panel.save();
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

test('results under div#rso: the proposal counts every result, and the saved recipe runs one row per result without healing', async ({ scoop }) => {
  const url = `http://127.0.0.1:${scoop.playground.port}/results`;
  const r = await scoop.record([url, '--name', 'serp']);
  const panel = sidebar(r);
  await panel.setUpList('h3.LC20lb', { index: 1 });
  const proposal = (await r.state()).host!.proposal!;
  expect(proposal.proposed.count).toBeGreaterThan(0);
  expect(proposal.proposed.count).toBe(8);
  expect(proposal.skipped).toBe(1);
  expect(proposal.within!.selectors[0]).toMatchObject({ strategy: 'id', value: 'rso' });
  for (const c of proposal.proposed.selectors) expect(c.value).not.toMatch(/main|rso|GyAeWb|s6JM6d|center_col|dURPMd/);
  expect((await r.query(ws('list-count')))!.text).toBe('8');
  expect((await r.query(`${ws('list-row-within')} ${ws('chip')}`))!.attrs['data-selector']).toBe('id=rso');
  expect((await r.query(ws('list-your-pick')))!.text).toContain('8/8');
  await panel.acceptList({ enter: true });
  await panel.addField('title');
  expect((await r.state()).host!.draft.tables[0]!.item!.count).toBe(8);
  await panel.addField('snippet', { selector: 'div.VwiC3b span', index: 2 });
  const { draft } = (await r.state()).host!;
  expect(draft.tables[0]!.fields.map((f) => [f.name, f.scope, f.count])).toEqual([
    ['title', 'item', 8],
    ['snippet', 'item', 8],
  ]);
  const results = await panel.testRun();
  expect(results.error).toBeUndefined();
  expect(results.tables[0]!.rowCount).toBe(8);
  const path = await panel.save();
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

test('tier 1: a recipe recorded with the role-only item candidate runs on tier 3 without healing the container', async ({ scoop }) => {
  const r = await scoop.record([template(scoop.playground.port), '--var', 'tier=1', '--name', 'by-role']);
  const panel = sidebar(r);
  await panel.setUpList('h2', { index: 3 });
  // The list entry, which keeps its tag on every tier, with its role as the primary selector.
  await r.clickPanel(ws('list-adjust-item-toggle'));
  const ladder = await r.until((s) => s.host?.proposal?.itemLadder);
  const likely = ladder.find((row) => row.likely)!;
  const entry = likely.sameAs ?? likely.distance + 1;
  await r.clickPanel(ws('list-ladder-row', `[data-distance="${entry}"]`));
  const broader = await r.until((s) => (s.host?.proposal?.proposed.tag === 'li' ? s.host.proposal.proposed : undefined));
  const role = broader.selectors.findIndex((c) => c.strategy === 'role' && c.value === 'listitem');
  expect(role).toBeGreaterThanOrEqual(0);
  if (broader.primary !== role) {
    await r.clickPanel(ws('list-row-item'));
    await r.clickPanel(ws('list-more-item'));
    await r.clickPanel(`${ws('list-candidates-item')} ${ws('pick-candidate')}:nth-child(${role + 1})`);
    await r.until((s) => s.host?.proposal?.proposed.primary === role);
  }
  await panel.acceptList();
  await panel.addField('title');
  const path = await panel.save();
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
