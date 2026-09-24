import { chromium, type Browser, type Page } from '@playwright/test';
import type { CliRun, Scoop } from './fixtures';
import { freePort } from './recorder-fixture';

/** A running `webscoop run`, with Playwright attached to the runner's own browser over CDP. */
export interface GuardedRun {
  run: CliRun;
  browser: Browser;
  /** The page the runner drives. */
  page(): Promise<Page>;
  /** Wait until the run logs a raised guard; returns that stderr line. */
  raised(timeoutMs?: number): Promise<string>;
  /** Fill the playground's login form in the runner's page and submit it. */
  login(user: string, pass: string): Promise<void>;
  /** Click the playground challenge's `I am human` button in the runner's page. */
  solveChallenge(): Promise<void>;
}

async function connect(port: number, run: CliRun, timeoutMs = 30_000): Promise<Browser> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (run.child.exitCode !== null) throw new Error(`webscoop exited with ${run.child.exitCode}: ${run.err()}`);
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 });
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

export async function startGuardedRun(
  scoop: Scoop,
  args: string[],
  cleanups: (() => Promise<void>)[],
  env: Record<string, string | undefined> = {},
): Promise<GuardedRun> {
  const port = await freePort();
  const run = scoop.spawn(['run', ...args], { ...env, WEBSCOOP_E2E_CDP_PORT: String(port) });
  const browser = await connect(port, run);
  cleanups.push(async () => {
    await browser.close().catch(() => {});
  });

  const page = async (): Promise<Page> => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const found = browser.contexts().flatMap((c) => c.pages())[0];
      if (found) return found;
      if (Date.now() > deadline) throw new Error('the runner has no page');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  return {
    run,
    browser,
    page,
    async raised(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const line = run.err().split('\n').find((l) => /webscoop: guard \S+ on page \d+: .*waiting/.test(l));
        if (line) return line;
        if (run.child.exitCode !== null) throw new Error(`webscoop exited with ${run.child.exitCode} before a guard: ${run.err()}`);
        if (Date.now() > deadline) throw new Error(`no guard was raised: ${run.err()}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    async login(user, pass) {
      const p = await page();
      await p.locator('input[name="username"]').fill(user);
      await p.locator('input[name="password"]').fill(pass);
      await Promise.all([p.waitForURL((url) => url.pathname !== '/login'), p.locator('#login-form button[type="submit"]').click()]);
    },
    async solveChallenge() {
      const p = await page();
      await Promise.all([p.waitForEvent('load'), p.getByRole('button', { name: 'I am human' }).click()]);
    },
  };
}
