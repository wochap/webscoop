import { dataset } from '@webscoop/playground';
import { expect, hasDisplay, profileDir, test } from './fixtures';
import { chromiumUsing, template, ws } from './sidebar';

test.skip(!hasDisplay, 'the recorder needs WAYLAND_DISPLAY or DISPLAY');

test('the fixture tears down the recorder process and its browser', async ({ scoop }) => {
  const r = await scoop.record([template(scoop.playground.port), '--var', 'tier=0', '--name', 'teardown']);
  expect(r.run.child.exitCode).toBeNull();
  const profile = profileDir(scoop.home, 'teardown');
  expect(chromiumUsing(profile).length).toBeGreaterThan(0);
  const result = await r.closeWindow();
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toContain('session ended with nothing to save');
  await expect.poll(() => chromiumUsing(profile)).toEqual([]);
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
  expect((await r.query(ws('footer-save')))!.backgroundColor).toBe('rgb(145, 132, 217)');

  await page.evaluate(() => ((window as unknown as { __hostClicks: unknown[] }).__hostClicks = []));
  const picked = await r.pick('h2.product-title', 4, { alt: true });
  expect(picked.host!.selected!.selection.tag).toBe('h2');
  expect(picked.host!.selected!.selection.text).toBe(dataset[4]!.title);
  expect(picked.host!.selected!.suggestion!.count).toBe(24);
  expect(await page.evaluate(() => (window as unknown as { __hostClicks: unknown[] }).__hostClicks)).toEqual([]);
  expect(await page.locator('#cookie-backdrop').count()).toBe(1);
  const result = await r.closeWindow();
  expect(result.code).toBe(0);
});
