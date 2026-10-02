import type { Page } from '@playwright/test';
import { expect, hasDisplay, test } from './fixtures';
import type { HookState } from './recorder-fixture';
import { ws } from './sidebar';

test.skip(!hasDisplay, 'the CLI and the recorder need WAYLAND_DISPLAY or DISPLAY');

const stepsOf = (s: HookState) => s.host?.draft.flows[0]?.steps ?? [];

test('a step target: a typed selector goes first, and Re-pick shows the selection details and Use for step saves them', async ({ scoop }) => {
  const r = await scoop.record([`http://127.0.0.1:${scoop.playground.port}/spa`, '--name', 'spa-targets']);
  await r.pick('#spa-login');
  await r.clickPanel(ws('pick-as-step'));
  await r.until((s) => stepsOf(s).length === 1);

  // Edit selector: the typed selector becomes the first candidate, the previous ones follow.
  const before = stepsOf(await r.state())[0]!.target!.selectors;
  await r.clickPanel(ws('step-edit-toggle'));
  await r.clickPanel(ws('step-target-edit-type'));
  await r.until((s) => s.host?.targetEdit?.phase === 'typing');
  await r.submit(ws('step-target-edit-selector'), 'css=#spa-root button');
  const typed = await r.until((s) => (s.host?.targetEdit === null ? stepsOf(s)[0]!.target!.selectors : undefined));
  expect(typed[0]).toMatchObject({ strategy: 'css', value: '#spa-root button', count: 1 });
  expect(typed.slice(1).map((c) => c.value)).toEqual(before.filter((c) => c.value !== '#spa-root button').map((c) => c.value));

  // Re-pick: the page strip names the step, the pick shows the details, and Use for step saves them.
  await r.clickPanel(ws('step-target-edit-repick'));
  const picking = await r.until((s) => (s.ui.picking && s.host?.targetEdit?.phase === 'picking' ? s : undefined));
  expect(picking.host!.targetEdit!.strip).toBe(`Picking target for ${picking.host!.draft.flows[0]!.name} · step 1`);
  expect(await r.count(ws('pick-target-waiting'))).toBe(1);
  await r.click('#spa-logged-out');
  await r.until((s) => s.host?.targetEdit?.phase === 'picked');
  expect(await r.count(ws('pick-inspector'))).toBe(1);
  expect(await r.count(ws('pick-candidate'))).toBeGreaterThan(0);
  expect((await r.query(ws('pick-target-use')))!.text).toBe('Use for step');
  await r.clickPanel(ws('pick-target-use'));
  const step = await r.until((s) => (s.host?.targetEdit === null ? stepsOf(s)[0] : undefined));
  expect(step.target!.fingerprint?.tag).toBe('p');
  expect(step.kind).toBe('click');

  // A reactive flow's trigger is re-picked with the same editor.
  await r.clickPanel(ws('flow-menu-toggle'));
  await r.clickPanel(ws('flow-menu-reactive'));
  await r.until((s) => s.ui.picking);
  await r.click('#spa-login');
  const name = (await r.until((s) => s.host?.draft.flows[0]?.trigger && s.host.draft.flows[0])).name;
  await r.clickPanel(ws('trigger-target-edit-repick'));
  const trigger = await r.until((s) => (s.host?.targetEdit?.phase === 'picking' ? s.host.targetEdit : undefined));
  expect(trigger.strip).toBe(`Picking trigger for ${name}`);
  await r.click('#spa-logged-out');
  await r.until((s) => s.host?.targetEdit?.phase === 'picked');
  await r.clickPanel(ws('pick-target-use'));
  const flow = await r.until((s) => (s.host?.targetEdit === null ? s.host.draft.flows[0] : undefined));
  expect(flow.trigger!.fingerprint?.tag).toBe('p');
  expect((await r.closeWindow()).code).toBe(0);
});

test('a popup step is re-picked in the open popup, which takes the panel', async ({ scoop }) => {
  const r = await scoop.record([`http://127.0.0.1:${scoop.playground.port}/spa`, '--name', 'spa-popup-target']);
  await r.browse();
  const [popup] = await Promise.all([r.page.context().waitForEvent('page'), r.click('#spa-login')]);
  await popup.waitForLoadState();
  const call = <T>(p: Page, name: string, ...params: unknown[]) =>
    p.evaluate(([n, a]) => (window as unknown as Record<string, Record<string, (...x: unknown[]) => unknown>>).__webscoopTest![n as string]!(...(a as unknown[])), [name, params] as const) as Promise<T>;
  const popupState = () => call<HookState>(popup, 'state');
  await expect.poll(async () => (await popupState().catch(() => null))?.host?.panelMode ?? null, { timeout: 15_000 }).toBe('owner');
  await popup.keyboard.press('b');
  await popup.locator('#spa-user-input').click();
  await popup.keyboard.type('u');
  // Leaving the input records its fill.
  await popup.locator('#spa-password-input').click();
  await expect.poll(async () => stepsOf(await popupState()).findIndex((s) => s.window === 'popup'), { timeout: 15_000 }).toBeGreaterThan(0);
  await popup.keyboard.press('b');
  const index = stepsOf(await popupState()).findIndex((s) => s.window === 'popup');

  // Take the panel back to the main window, then re-pick the popup step from there.
  await r.mousePanel(ws('panel-rail'));
  await r.until((s) => s.ui.panelMode === 'owner');
  await r.clickPanel(ws('step-edit-toggle'), index);
  await r.clickPanel(ws('step-target-edit-repick'));
  // The popup owns the panel and picks.
  await expect.poll(async () => (await popupState()).host?.targetEdit?.phase ?? null, { timeout: 15_000 }).toBe('picking');
  expect((await popupState()).host!.popup).toBe(true);
  const box = (await popup.locator('#spa-password-input').boundingBox())!;
  await popup.mouse.click(box.x + 8, box.y + box.height / 2);
  await expect.poll(async () => (await popupState()).host?.targetEdit?.phase ?? null, { timeout: 15_000 }).toBe('picked');
  await call(popup, 'click', ws('pick-target-use'), 0);
  await expect.poll(async () => (await popupState()).host?.targetEdit === null, { timeout: 15_000 }).toBe(true);
  const step = stepsOf(await popupState())[index]!;
  expect(step).toMatchObject({ kind: 'fill', window: 'popup' });
  expect(step.target!.fingerprint?.attrs).toMatchObject({ id: 'spa-password-input' });
  await popup.close();
  expect((await r.closeWindow()).code).toBe(0);
});
