import { dataset, FRAMED_COUNT, productDescription } from '@webscoop/playground';
import { expect, FRAMED_RECIPE, hasDisplay, referenceRecipe, test } from './fixtures';
import { ws } from './sidebar';

test.skip(!hasDisplay, 'the recorder and the CLI need WAYLAND_DISPLAY or DISPLAY');

/** A Playwright selector for an element inside the catalog iframe of `/framed`. */
const inCatalog = (selector: string) => `#frame-catalog >> internal:control=enter-frame >> ${selector}`;

test('run: the framed catalog yields 8 rows, and the step clicks Details inside the iframe', async ({ scoop }) => {
  await scoop.writeRecipe(referenceRecipe(scoop.playground.port, FRAMED_RECIPE));
  const run = await scoop.run(['run', 'playground-framed']);
  expect(run.code, run.stderr).toBe(0);
  const out = JSON.parse(run.stdout) as { products: { title: string }[]; details: { description: string }[] };
  expect(out.products).toHaveLength(FRAMED_COUNT);
  expect(out.products.map((r) => r.title)).toEqual(dataset.slice(0, FRAMED_COUNT).map((p) => p.title));
  expect(out.details).toEqual([expect.objectContaining({ description: productDescription(dataset[0]!) })]);
  expect(run.stderr).toMatch(/step 0 "details" \(click\) on page 1: ok/);
});

test('record: a title picked inside the iframe shows its frame target, and the field gets a frame badge', async ({ scoop }) => {
  const r = await scoop.record([`http://127.0.0.1:${scoop.playground.port}/framed`, '--name', 'framed-pick']);
  await expect.poll(() => r.page.frameLocator('#frame-catalog').locator('[data-testid="product-card"]').count()).toBe(FRAMED_COUNT);
  const picked = await r.pick(inCatalog('h2.product-title'), 0);
  const selection = picked.host!.selected!.selection;
  expect(selection.frame!.selectors[0]).toMatchObject({ strategy: 'id', value: 'frame-catalog', count: 1 });
  expect(selection.framePath).not.toBeNull();
  expect((await r.query(ws('pick-frame')))!.attrs['data-frame']).toBe('iframe#frame-catalog');
  // The overlay outlines the title inside the iframe, offset by the iframe's position.
  const boxes = await r.page.evaluate(() => (window as unknown as { __webscoopTest: { boxes(): { variant: string; rect: { x: number; y: number; w: number; h: number } }[] } }).__webscoopTest.boxes());
  const title = (await r.page.locator(inCatalog('h2.product-title')).first().boundingBox())!;
  const box = boxes.find((b) => b.variant === 'selected')!;
  expect(Math.abs(box.rect.x - title.x)).toBeLessThan(2);
  expect(Math.abs(box.rect.y - title.y)).toBeLessThan(2);
  await r.clickPanel(ws('pick-add-field'));
  const table = await r.until((s) => (s.host?.draft.tables[0]?.fields.length === 1 ? s.host.draft.tables[0] : undefined));
  expect(table.frame!.selectors[0]).toMatchObject({ strategy: 'id', value: 'frame-catalog' });
  expect(await r.count(ws('frame-badge'))).toBe(1);
  expect((await r.closeWindow()).code).toBe(0);
});
