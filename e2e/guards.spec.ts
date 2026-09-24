import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecipeInput } from '@webscoop/core';
import { dataset } from '@webscoop/playground';
import { expect, hasDisplay, PAGED_RECIPE, referenceRecipe, test, type Scoop } from './fixtures';

test.skip(!hasDisplay, 'the CLI needs WAYLAND_DISPLAY or DISPLAY');

/** The reference recipe with extra catalog query switches. */
async function walled(scoop: Scoop, name: string, query: string): Promise<string> {
  const recipe = structuredClone(scoop.recipe);
  recipe.name = name;
  recipe.url += `&${query}`;
  return scoop.writeRecipe(recipe);
}

/** The paged reference recipe on the `url` kind, with extra catalog query switches. */
async function pagedWalled(scoop: Scoop, name: string, query: string): Promise<string> {
  const recipe: RecipeInput = referenceRecipe(scoop.playground.port, PAGED_RECIPE);
  recipe.name = name;
  recipe.vars = recipe.vars!.map((v) => (v.name === 'mode' ? { ...v, default: 'url' } : v));
  recipe.url += `&${query}`;
  return scoop.writeRecipe(recipe);
}

/** The JSON run report `--report` prints on stderr. */
function reportOf(stderr: string): { guards: { kind: string; page: number; url: string; waitedMs: number; cleared: boolean }[] } {
  const start = stderr.indexOf('\n{\n');
  const end = stderr.indexOf('\n}\n', start);
  return JSON.parse(stderr.slice(start + 1, end + 2));
}

const jsonl = (stdout: string) =>
  stdout
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

function chromiumUsing(profileDir: string): string[] {
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out.split('\n').filter((line) => line.includes(`--user-data-dir=${profileDir}`));
}

test('guardedRun attaches to the runner and tears down cleanly', async ({ scoop }) => {
  const name = await walled(scoop, 'guard-teardown', 'wall=login');
  const g = await scoop.guardedRun([name]);
  await g.raised();
  const page = await g.page();
  expect(new URL(page.url()).pathname).toBe('/login');
  g.run.child.kill('SIGINT');
  const result = await g.run.done;
  expect(result.code).toBe(1);
  await expect.poll(() => chromiumUsing(join(scoop.home, 'profiles', name)).length).toBe(0);
});

test('wall=login: the run pauses, the user logs in, and the run finishes with 24 rows', async ({ scoop }) => {
  const name = await walled(scoop, 'guard-login', 'wall=login');
  const g = await scoop.guardedRun([name, '--report']);
  const line = await g.raised();
  expect(line).toContain('guard login on page 1: redirected to a login page (/login)');
  await g.login('ada', 'secret');
  const result = await g.run.done;
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toHaveLength(24);
  expect(result.stderr).toMatch(/guard login on page 1 cleared after \d+\.\ds/);
  const { guards } = reportOf(result.stderr);
  expect(guards).toEqual([expect.objectContaining({ kind: 'login', page: 1, cleared: true })]);
  expect(guards[0]!.url).toContain('/login?next=');
  expect(result.stderr).toMatch(/24 rows from 1 page, 1 guard cleared in/);
});

test('wall=captcha&wallAfterPage=2: pages 1 and 2 are emitted, page 3 pauses, the button clears it', async ({ scoop }) => {
  const name = await pagedWalled(scoop, 'guard-captcha', 'wall=captcha&wallAfterPage=2');
  const g = await scoop.guardedRun([name, '--jsonl']);
  const line = await g.raised();
  expect(line).toContain('guard captcha on page 3');
  // Rows of pages 1 and 2 are out before the pause.
  await expect.poll(() => jsonl(g.run.out()).length).toBe(16);
  await g.solveChallenge();
  const result = await g.run.done;
  expect(result.code, result.stderr).toBe(0);
  const rows = jsonl(result.stdout);
  expect(rows.map((r) => r.title)).toEqual(dataset.map((p) => p.title));
  expect(rows.map((r) => r._page)).toEqual(dataset.map((_, i) => Math.floor(i / 8) + 1));
  expect(result.stderr).toContain('guard captcha on page 3 cleared');
});

test('--guard-timeout 0 exits 2, names the guard, and falls back to stderr without notify-send', async ({ scoop }) => {
  const name = await walled(scoop, 'guard-timeout', 'wall=login');
  // An empty directory as PATH shadows any notify-send on the machine.
  const empty = await mkdtemp(join(tmpdir(), 'webscoop-path-'));
  const result = await scoop.run(['run', name, '--guard-timeout', '0'], { PATH: empty });
  expect(result.code, result.stderr).toBe(2);
  const url = `${scoop.playground.url}/login?next=`;
  expect(result.stderr).toContain(`guard login on page 1: redirected to a login page (/login) (${url}`);
  expect(result.stderr).toMatch(/run paused and gave up waiting: login guard on page 1 .*: http:\/\/127\.0\.0\.1:\d+\/login\?next=/);
  expect(result.stderr).toContain(`webscoop: notification (notify-send is not installed): webscoop: ${name} needs you: login guard on page 1`);
  expect(JSON.parse(result.stdout)).toEqual([]);
});

test('test on a wall exits 2 without waiting', async ({ scoop }) => {
  const name = await walled(scoop, 'guard-test', 'wall=captcha');
  const started = Date.now();
  const result = await scoop.run(['test', name, '--no-notify']);
  expect(result.code, result.stderr).toBe(2);
  expect(result.stderr).toContain('guard captcha on page 1');
  expect(Date.now() - started).toBeLessThan(30_000);
});

test('a tier 0 run raises no guard', async ({ scoop }) => {
  const result = await scoop.run(['run', scoop.recipe.name]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).not.toContain('guard');
  expect(JSON.parse(result.stdout)).toHaveLength(24);
});

test('wall=interstitial raises zero-fields', async ({ scoop }) => {
  const name = await walled(scoop, 'guard-interstitial', 'wall=interstitial');
  const result = await scoop.run(['run', name, '--guard-timeout', '0', '--no-llm', '--no-notify']);
  expect(result.code, result.stderr).toBe(2);
  expect(result.stderr).toMatch(/guard zero-fields on page 1: nothing resolved on an HTTP 503 page/);
});

test('interactive run on wall=login shows the banner, and Continue after logging in resumes the run', async ({ scoop }) => {
  const name = await walled(scoop, 'guard-banner', 'wall=login');
  const r = await scoop.interactiveRun([name]);
  const ctx = await r.until((s) => s.host?.guardContext);
  expect(ctx).toMatchObject({ kind: 'login', page: 1 });
  expect(await r.query('[data-ws="guard-banner"]')).toMatchObject({ rect: expect.objectContaining({ y: 0 }) });
  expect(await r.query('[data-ws="countdown"]')).toMatchObject({ text: expect.stringMatching(/^\d+:\d\d$/) });

  await r.page.locator('input[name="username"]').fill('ada');
  await r.page.locator('input[name="password"]').fill('secret');
  await Promise.all([r.page.waitForURL((url) => url.pathname === '/catalog'), r.page.locator('#login-form button[type="submit"]').click()]);
  // The banner comes back on the catalog until the run sees the guard is gone; Continue checks at once.
  await r.clickPanel('[data-ws="guard-continue"]').catch(() => {});
  await expect
    .poll(async () => r.count('[data-ws="guard-banner"]').catch(() => 0), { timeout: 15_000 })
    .toBe(0);

  const result = await r.run.done;
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toHaveLength(24);
  expect(result.stderr).toContain('guard login on page 1 cleared');
});
