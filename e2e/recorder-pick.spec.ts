import { readFile } from 'node:fs/promises';
import { loadRecipe } from '@webscoop/core';
import { dataset } from '@webscoop/playground';
import { expect, hasDisplay, test, type Recording } from './fixtures';
import { sidebar, template, ws } from './sidebar';

test.skip(!hasDisplay, 'the recorder needs WAYLAND_DISPLAY or DISPLAY');

/** Record the twins catalog with the titles confirmed as items. */
async function twinsRecording(scoop: { record(args: string[]): Promise<Recording>; playground: { port: number } }, name: string): Promise<Recording> {
  const r = await scoop.record([template(scoop.playground.port, '&twins=1'), '--var', 'tier=0', '--name', name]);
  await sidebar(r).titlesAsList();
  return r;
}

const STRICT_SELLER = 'p.product-note:nth-of-type(4) > span';

/** The hover tag markup and the pick strip text, through the e2e hook. */
async function overlayText(r: Recording): Promise<{ tag: string; strip: string }> {
  return r.page.evaluate(() => {
    const hook = (window as unknown as { __webscoopTest: { tag(): string; strip(): string } }).__webscoopTest;
    return { tag: hook.tag(), strip: hook.strip() };
  });
}

test('walk up to the container: Left twice moves the selection to the grandparent and the short breadcrumb follows', async ({ scoop }) => {
  const r = await scoop.record([template(scoop.playground.port), '--var', 'tier=0', '--name', 'walk']);
  const panel = sidebar(r);
  await panel.titlesAsList();
  const picked = await r.pick('[data-testid="price"]', 0);
  const path = picked.host!.selected!.selection.path;
  const crumbs = async () => (await r.count(ws('pick-crumb'))) as number;
  expect(await crumbs()).toBe(3);
  expect(await r.count(ws('pick-crumb-expand'))).toBe(1);
  expect((await r.query(ws('pick-crumb'), 2))!.attrs['data-path']).toBe(path.join('.'));
  await r.key('ArrowLeft');
  await r.until((s) => s.host?.selected?.selection.path.length === path.length - 1);
  await r.key('ArrowLeft');
  const up = await r.until((s) => (s.host?.selected?.selection.path.length === path.length - 2 ? s.host.selected : undefined));
  expect(up.selection.path).toEqual(path.slice(0, -2));
  // The highlight surrounds the grandparent.
  const box = await r.page.evaluate(() => (window as unknown as { __webscoopTest: { boxes(): { variant: string; rect: { x: number; y: number; w: number; h: number } }[] } }).__webscoopTest.boxes());
  const price = (await r.page.locator('[data-testid="price"]').first().boundingBox())!;
  const selectedBox = box.find((b) => b.variant === 'selected')!;
  expect(selectedBox.rect.x).toBeLessThanOrEqual(price.x);
  expect(selectedBox.rect.y).toBeLessThanOrEqual(price.y);
  expect(selectedBox.rect.x + selectedBox.rect.w).toBeGreaterThanOrEqual(price.x + price.width - 1);
  // The shown crumbs end at the new selection; the expander shows them all.
  expect((await r.query(ws('pick-crumb'), 2))!.attrs['data-path']).toBe(path.slice(0, -2).join('.'));
  await r.clickPanel(ws('pick-crumb-expand'));
  expect(await crumbs()).toBeGreaterThan(3);
  expect((await r.closeWindow()).code).toBe(0);
});

test('results link: walking up from the heading offers role=link with its long name matching once, and the item field keeps the role alone', async ({ scoop }) => {
  const url = `http://127.0.0.1:${scoop.playground.port}/results`;
  const r = await scoop.record([url, '--name', 'serp-links']);
  const panel = sidebar(r);
  await r.pick('h3.LC20lb', 1);
  await r.key('ArrowLeft');
  const selected = await r.until((s) => (s.host?.selected?.selection.tag === 'a' && s.host.selected.suggestion ? s.host.selected : undefined));
  const role = selected.selection.candidates.find((c) => c.strategy === 'role')!;
  // The name runs past 80 characters and the page spells the breadcrumb without the space Playwright keeps.
  expect(role.value.startsWith(`link|${dataset[1]!.title} `)).toBe(true);
  expect(role.value.length).toBeGreaterThan(85);
  expect(role.value).toContain('example›');
  expect(role.count).toBe(1);
  await r.key('l');
  await r.until((s) => s.host?.proposal);
  await panel.acceptList({ enter: true });
  await panel.addField('link');
  const draft = await r.until((s) => (s.host?.draft.tables[0]!.item?.count === 8 && s.host.draft.tables[0]!.fields.length === 1 ? s.host.draft : undefined));
  const field = draft.tables[0]!.fields[0]!;
  expect(field.scope).toBe('item');
  expect(field.count).toBe(8);
  expect(field.selectors.find((c) => c.strategy === 'role')).toMatchObject({ value: 'link' });
  expect((await r.closeWindow()).code).toBe(0);
});

test('twins=1: the Sold by pick preselects a verified hit, tests 24 sellers, and the recipe runs at tier 0 and tier 1', async ({ scoop }) => {
  const r = await twinsRecording(scoop, 'twins');
  const panel = sidebar(r);
  // The second `p.product-note span` on the page is the first card's seller.
  const picked = await r.pick('p.product-note span', 1);
  const candidates = picked.host!.selected!.selection.candidates;
  expect(picked.host!.selected!.scope).toBe('item');
  expect(candidates[0]).toMatchObject({ strategy: 'css', value: STRICT_SELLER, hit: true, count: 24 });
  expect(candidates.every((c) => c.hit === true)).toBe(true);
  expect(await r.count(ws('pick-candidate-miss'))).toBe(0);
  expect((await r.query(ws('pick-candidate')))!.attrs['data-hit']).toBe('true');
  await panel.addField('seller');
  expect((await r.state()).host!.draft.tables[0]!.fields[1]).toMatchObject({ count: 24, sample: `Sold by ${dataset[0]!.seller}` });

  const results = await panel.testRun();
  expect(results.tables[0]!.rowCount).toBe(24);
  expect(results.tables[0]!.rows.every((row) => String(row.seller).startsWith('Sold by'))).toBe(true);
  const path = await panel.save();
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
  await r.clickPanel(ws('pick-crumb', `[data-path="${path.join('.')}"]`));
  const selected = await r.until((s) => (s.host?.selected?.selection.tag === 'p' ? s.host.selected : undefined));
  expect(selected.selection.path).toEqual(path);
  expect(selected.selection.candidates[0]).toMatchObject({ value: 'p.product-note:nth-of-type(4)', hit: true, count: 24 });
  const miss = selected.selection.candidates.findIndex((c) => c.strategy === 'class' && c.value === 'p.product-note');
  expect(selected.selection.candidates[miss]).toMatchObject({ count: 48, hit: false });
  const badge = await r.query(ws('pick-candidate'), miss);
  expect(badge!.attrs['data-hit']).toBe('false');
  expect(await r.count(ws('pick-candidate-miss'))).toBeGreaterThanOrEqual(1);
  expect((await r.closeWindow()).code).toBe(0);
});

test('pick helpers: ArrowUp walks from a result title to its result block, the tag, strip, and card follow, and a click selects the block', async ({ scoop }) => {
  const url = `http://127.0.0.1:${scoop.playground.port}/results`;
  const r = await scoop.record([url, '--name', 'serp-walk']);
  await r.key('p');
  await r.until((s) => s.ui.picking);
  expect((await overlayText(r)).strip).toContain('Picking');
  expect((await overlayText(r)).strip).toContain('parent / child');
  await r.hover('h3.LC20lb', 1);
  await r.until((s) => s.ui.hover);
  for (let i = 0; i < 5; i++) await r.key('ArrowUp');
  const hover = await r.until((s) => {
    return s.ui.hover?.depth === 5 ? s.ui.hover : undefined;
  });
  expect(hover.similar).toBe(4);
  expect(hover.path[0]).toBe('div.Mjj4Yd');
  expect(hover.path.at(-1)).toBe('h3.LC20lb');
  const { tag } = await overlayText(r);
  expect(tag).toContain('↑5');
  expect(tag).toContain('4 similar siblings');
  expect(tag).toMatch(/\d+×\d+/);
  expect((await r.query(ws('pick-hover-depth')))!.text).toBe('↑5');
  expect((await r.query(ws('pick-hover-hint')))!.text).toContain('Wrappers are hard to click');
  // Down walks back toward the title.
  await r.key('ArrowDown');
  await r.until((s) => s.ui.hover?.depth === 4);
  await r.key('ArrowUp');
  await r.until((s) => s.ui.hover?.depth === 5);
  await r.click('h3.LC20lb', 1);
  const selected = await r.until((s) => (!s.ui.picking && s.host?.selected ? s.host.selected : undefined));
  expect(selected.selection.tag).toBe('div');
  expect(selected.selection.attrs.class).toBe('Mjj4Yd');
  expect((await overlayText(r)).strip).toBe('');
  expect(await r.count(ws('pick-hover'))).toBe(0);
  expect((await r.closeWindow()).code).toBe(0);
});

test('pick helpers: page keys are held back while picking, Ctrl+S still saves, and Esc removes the hints', async ({ scoop }) => {
  const url = `http://127.0.0.1:${scoop.playground.port}/results`;
  const r = await scoop.record([url, '--name', 'serp-keys']);
  await r.page.evaluate(() => {
    const w = window as unknown as { __pageKeys: string[] };
    w.__pageKeys = [];
    document.addEventListener('keydown', (e) => w.__pageKeys.push(e.key));
  });
  await r.key('p');
  await r.until((s) => s.ui.picking);
  await r.hover('h3.LC20lb', 0);
  await r.key('j');
  await r.key('ArrowUp');
  await r.until((s) => s.ui.hover?.depth === 1);
  expect(await r.page.evaluate(() => (window as unknown as { __pageKeys: string[] }).__pageKeys)).toEqual([]);
  expect((await r.state()).ui.picking).toBe(true);
  // Ctrl+S reaches the panel: the empty draft is refused with a toast, and picking goes on.
  expect(await r.count(ws('panel-toast'))).toBe(0);
  await r.key('Control+s');
  await expect.poll(async () => (await r.query(ws('panel-toast')))?.text ?? '').toContain('Not saved');
  expect((await r.state()).ui.picking).toBe(true);
  await r.key('Escape');
  await r.until((s) => !s.ui.picking);
  expect((await overlayText(r)).strip).toBe('');
  expect(await r.count(ws('pick-hover'))).toBe(0);
  // Not picking: the page gets its keys again.
  await r.key('j');
  expect(await r.page.evaluate(() => (window as unknown as { __pageKeys: string[] }).__pageKeys)).toEqual(['j']);
  expect((await r.closeWindow()).code).toBe(0);
});

test('pick helpers: the inferred list parent is marked in the setup and Rows, and Change walks up to a new list parent', async ({ scoop }) => {
  const url = `http://127.0.0.1:${scoop.playground.port}/results`;
  const r = await scoop.record([url, '--name', 'serp-inferred']);
  const panel = sidebar(r);
  await panel.setUpList('h3.LC20lb');
  expect((await r.state()).host!.proposal!.withinInferred).toBe(true);
  expect((await r.query(`${ws('list-row-within')} ${ws('rows-parent-inferred')}`))!.text).toBe('inferred');
  expect((await r.query(ws('list-adjust-parent')))!.text).toContain('· inferred');
  await panel.acceptList({ enter: true });
  await panel.addField('title');
  expect((await r.query(`${ws('rows-stack')} ${ws('rows-parent-inferred')}`))!.text).toBe('inferred');
  expect((await r.query(ws('rows')))!.text).not.toContain('Change');

  // Change through Edit: walk from a title up to the results wrapper's parent, which holds every result.
  await r.clickPanel(ws('rows-edit'));
  await r.until((s) => s.host?.proposal?.origin === 'edit');
  await r.clickPanel(ws('list-row-within'));
  await r.clickPanel(ws('list-pick-within'));
  await r.until((s) => s.ui.picking && s.host?.levelPick);
  expect((await overlayText(r)).strip).toContain('Picking in ');
  await r.hover('h3.LC20lb', 2);
  for (let i = 0; i < 8; i++) await r.key('ArrowUp');
  await r.until((s) => s.ui.hover?.depth === 8);
  expect((await overlayText(r)).tag).not.toContain('ws-refused');
  await r.click('h3.LC20lb', 2);
  await r.until((s) => (s.host?.proposal && s.host.proposal.within?.selectors[0]?.value !== 'rso' && !s.ui.picking ? true : undefined));
  await r.clickPanel(ws('list-accept'));
  const item = await r.until((s) => {
    const i = s.host?.draft.tables[0]!.item;
    return i?.within?.[0]?.value !== 'rso' && !s.ui.picking && !s.host?.proposal ? i : undefined;
  });
  expect(item.within![0]).toMatchObject({ strategy: 'id', value: 'center_col' });
  expect(item.withinInferred).toBeUndefined();
  await r.until((s) => s.host?.draft.tables[0]!.item?.count === 8);
  expect(await r.count(ws('rows-parent-inferred'))).toBe(0);
  expect((await r.closeWindow()).code).toBe(0);
});

test('pick helpers: a manual setup infers the product list as list parent, and clearing it removes the mark', async ({ scoop }) => {
  const r = await scoop.record([template(scoop.playground.port), '--var', 'tier=0', '--name', 'manual-inferred']);
  await r.pick('h1.category-heading');
  await r.clickPanel(ws('pick-cta-manual'));
  await r.until((s) => s.host?.proposal?.origin === 'manual');
  await r.submit(ws('list-input-item'), 'testid=product-card');
  const proposal = await r.until((s) => (s.host?.proposal?.proposed.count === 24 && s.host.proposal.within ? s.host.proposal : undefined));
  expect(proposal.withinInferred).toBe(true);
  expect(proposal.within!.tag).toBe('ul');
  expect((await r.query(`${ws('list-row-within')} ${ws('rows-parent-inferred')}`))!.text).toBe('inferred');
  expect((await r.query(ws('list-count')))!.text).toBe('24');
  await r.clickPanel(ws('list-row-within'));
  await r.clickPanel(ws('list-clear-within'));
  await r.until((s) => s.host?.proposal && !s.host.proposal.within);
  expect(await r.count(ws('rows-parent-inferred'))).toBe(0);
  expect((await r.state()).host!.proposal!.proposed.count).toBe(24);
  expect((await r.closeWindow()).code).toBe(0);
});

test('strategy menu: choosing role in the panel menu and submitting sends role=listitem', async ({ scoop }) => {
  const r = await scoop.record([template(scoop.playground.port), '--var', 'tier=0', '--name', 'role-menu']);
  await r.pick('h1.category-heading');
  await r.clickPanel(ws('pick-cta-manual'));
  await r.until((s) => s.host?.proposal?.origin === 'manual');
  expect((await r.query(ws('list-input-item-strategy')))!.value).toBe('css');
  // Real mouse clicks: a synthetic click skips the pointer events that close the menu.
  await r.mousePanel(ws('list-input-item-strategy'));
  expect(await r.count(ws('list-input-item-strategy-option'))).toBe(7);
  await r.mousePanel(`${ws('list-input-item-strategy-option')}[data-value="role"]`);
  expect(await r.count(ws('list-input-item-strategy-option'))).toBe(0);
  expect((await r.query(ws('list-input-item-strategy')))!.value).toBe('role');
  await r.submit(ws('list-input-item'), 'listitem');
  const proposal = await r.until((s) => (s.host?.proposal?.proposed.selectors[0]?.strategy === 'role' ? s.host.proposal : undefined));
  expect(proposal.proposed.selectors[0]).toMatchObject({ strategy: 'role', value: 'listitem' });
  expect((await r.closeWindow()).code).toBe(0);
});
