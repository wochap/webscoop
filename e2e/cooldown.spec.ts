import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { e2eConfig, expect, hasDisplay, test, type Scoop } from './fixtures';
import { freePort } from './recorder-fixture';
import { ws } from './sidebar';

test.skip(!hasDisplay, 'the CLI needs WAYLAND_DISPLAY or DISPLAY');

/** The reference recipe behind the playground's captcha wall. */
async function captchaRecipe(scoop: Scoop, name: string): Promise<string> {
  const recipe = structuredClone(scoop.recipe);
  recipe.name = name;
  recipe.url += '&wall=captcha';
  return scoop.writeRecipe(recipe);
}

async function connect(port: number): Promise<Browser> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 });
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** Open pages showing the playground's catalog, in any context of the browser. */
const catalogPages = (browser: Browser): Page[] =>
  browser
    .contexts()
    .flatMap((c) => c.pages())
    .filter((p) => !p.isClosed() && p.url().includes('/catalog'));

/** Call a page test hook of the injected bundle. */
const hook = <T>(page: Page, name: string, ...params: unknown[]) =>
  page.evaluate(([n, p]) => (window as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>).__webscoopTest?.[n as string]?.(...(p as unknown[])), [name, params] as const) as Promise<T>;

async function coldRecipes(scoop: Scoop): Promise<string[]> {
  const result = await scoop.run(['cooldown', 'list', '--json']);
  return (JSON.parse(result.stdout) as { recipe: string }[]).map((e) => e.recipe);
}

test('a captcha timeout leaves a cold tab, refuses the next run without a request, and warms up after the period', async ({ scoop }) => {
  await writeFile(join(scoop.home, 'config.json'), `${JSON.stringify(e2eConfig({ guards: { cooldownMs: 5000 } }))}\n`);
  const name = await captchaRecipe(scoop, 'cold-period');
  const port = await freePort();
  const env = { WEBSCOOP_E2E_CDP_PORT: String(port) };
  const first = await scoop.run(['run', name, '--guard-timeout', '0', '--no-notify'], env);
  expect(first.code, first.stderr).toBe(2);
  const browser = await connect(port);
  try {
    await expect.poll(() => catalogPages(browser).length).toBe(1);
    expect(await coldRecipes(scoop)).toEqual([name]);

    const before = scoop.playground.requests.length;
    const second = await scoop.run(['run', name, '--no-notify'], env);
    expect(second.code, second.stderr).toBe(2);
    expect(second.stderr).toMatch(new RegExp(`${name} is cold until \\d\\d:\\d\\d:\\d\\d after a captcha guard on page 1`));
    expect(JSON.parse(second.stdout)).toEqual([]);
    expect(scoop.playground.requests.length).toBe(before);

    await expect.poll(() => catalogPages(browser).length, { timeout: 15_000 }).toBe(0);
  } finally {
    await browser.close().catch(() => {});
  }
  expect(await coldRecipes(scoop)).toEqual([]);
  const before = scoop.playground.requests.length;
  const third = await scoop.run(['run', name, '--guard-timeout', '0', '--no-notify']);
  expect(third.code, third.stderr).toBe(2);
  expect(scoop.playground.requests.length).toBeGreaterThan(before);
});

test('the cold tab shows the cold banner, and Continue warms the recipe once the captcha is gone', async ({ scoop }) => {
  await writeFile(join(scoop.home, 'config.json'), `${JSON.stringify(e2eConfig({ guards: { cooldownMs: 120_000 } }))}\n`);
  const name = await captchaRecipe(scoop, 'cold-banner');
  const port = await freePort();
  const first = await scoop.run(['run', name, '--guard-timeout', '0', '--no-notify'], { WEBSCOOP_E2E_CDP_PORT: String(port) });
  expect(first.code, first.stderr).toBe(2);
  const browser = await connect(port);
  try {
    await expect.poll(() => catalogPages(browser).length).toBe(1);
    const page = catalogPages(browser)[0]!;
    await expect.poll(() => hook<{ text?: string } | null>(page, 'query', ws('guard-reason')).then((r) => r?.text ?? null)).toMatch(/^Cold until \d\d:\d\d$/);
    expect(await hook(page, 'query', ws('guard-abort'))).toBeNull();

    // The site clears the wall itself once the check passes; the run would have reloaded, the cold tab only watches.
    await page.context().request.post(`${scoop.playground.url}/challenge`);
    await page.reload();
    await hook(page, 'click', ws('guard-continue')).catch(() => {});
    await expect.poll(() => coldRecipes(scoop), { timeout: 15_000 }).toEqual([]);
    await expect.poll(() => catalogPages(browser).length).toBe(0);
  } finally {
    await browser.close().catch(() => {});
  }
});
