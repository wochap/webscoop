import { expect, hasDisplay, test } from './fixtures';
import type { Recording } from './recorder-fixture';
import { ws } from './sidebar';

test.skip(!hasDisplay, 'the recorder needs WAYLAND_DISPLAY or DISPLAY');

type Thief = { keydown: number; click: number };
const thief = (r: Recording) => r.page.evaluate(() => (window as unknown as { __thief: Thief }).__thief);
const activeId = (r: Recording) => r.page.evaluate(() => document.activeElement?.id ?? '');

test('focus-thief: panel typing, clicks, and shortcuts stay out of the page bubble listeners', async ({ scoop }) => {
  const r = await scoop.record([`http://127.0.0.1:${scoop.playground.port}/focus-thief`, '--name', 'thief']);

  // Control: a key on the page body is stolen into the search box.
  await r.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await r.page.keyboard.press('Shift');
  expect(await activeId(r)).toBe('q');
  expect((await thief(r)).keydown).toBeGreaterThan(0);

  // Recorder shortcuts are ignored while the page search box has focus.
  await r.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await r.pick('#intro');
  await r.page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    Object.assign((window as unknown as { __thief: Thief }).__thief, { keydown: 0, click: 0 });
  });

  // Typing into a panel input keeps focus and value in the panel.
  await r.mousePanel(ws('pick-form-name'));
  await r.page.evaluate((sel) => (window as unknown as { __webscoopTest: { focus(s: string): void } }).__webscoopTest.focus(sel), ws('pick-form-name'));
  await r.page.keyboard.press('Control+a');
  await r.page.keyboard.press('Backspace');
  await r.page.keyboard.type('hello');
  expect((await r.query(ws('pick-form-name')))!.value).toBe('hello');
  expect(await activeId(r)).not.toBe('q');
  expect(await r.page.evaluate(() => document.activeElement?.tagName)).toBe('WEBSCOOP-ROOT');
  expect(await thief(r)).toEqual({ keydown: 0, click: 0 });

  // Clicking panel buttons acts and the page counts no clicks.
  await r.mousePanel(ws('pick-add-field'));
  await r.until((s) => s.host?.draft.tables[0]!.fields.at(-1)?.name === 'hello');
  const tables = (await r.state()).host!.draft.tables.length;
  await r.mousePanel(ws('tab-add'));
  await r.until((s) => s.host?.draft.tables.length === tables + 1);
  expect((await thief(r)).click).toBe(0);

  // A panel shortcut still works with focus in the panel.
  await r.key('p');
  await r.until((s) => s.ui.picking);
  expect(await activeId(r)).not.toBe('q');
  expect(await thief(r)).toEqual({ keydown: 0, click: 0 });
  await r.key('Escape');
  await r.until((s) => !s.ui.picking);

  const result = await r.closeWindow();
  expect(result.code, result.stderr).toBe(0);
});
