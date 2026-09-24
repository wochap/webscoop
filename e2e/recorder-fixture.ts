import { createServer } from 'node:net';
import { chromium, type Browser, type Page } from '@playwright/test';
import type { RecorderState } from '@webscoop/core';
import type { CliResult, CliRun, Scoop } from './fixtures';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

interface PanelInfo {
  text: string;
  value: string;
  rect: { x: number; y: number; w: number; h: number };
  fontFamily: string;
  backgroundColor: string;
  disabled: boolean;
  attrs: Record<string, string>;
}

export interface HookState {
  host: RecorderState | null;
  ui: { picking: boolean; browsing: boolean; drawerOpen: boolean; focusedField: number | null; focusedStep: number | null };
  mode: string;
}

/** A running `webscoop record`, with Playwright attached to its Chromium over CDP. */
export interface Recording {
  run: CliRun;
  browser: Browser;
  page: Page;
  /** Panel and host state through the e2e test hook. */
  state(): Promise<HookState>;
  /** Poll the state until the check returns a value other than undefined or false. */
  until<T>(check: (s: HookState) => T | undefined | false | null, timeoutMs?: number): Promise<NonNullable<T>>;
  query(selector: string, index?: number): Promise<PanelInfo | null>;
  count(selector: string): Promise<number>;
  /** Click a panel element (inside the closed shadow root). */
  clickPanel(selector: string, index?: number): Promise<void>;
  /** Replace a panel input's value and commit it. */
  fill(selector: string, value: string, index?: number): Promise<void>;
  /** Replace an input's value and submit its form. */
  submit(selector: string, value: string, index?: number): Promise<void>;
  /** Move the mouse to the middle of a page element. */
  hover(selector: string, index?: number): Promise<{ x: number; y: number }>;
  /** Click a page element with the real mouse, optionally holding Alt. */
  click(selector: string, index?: number, opts?: { alt?: boolean }): Promise<void>;
  key(key: string): Promise<void>;
  /** Turn browse mode on with `b`, so what the page is used for is recorded as steps. */
  browse(): Promise<void>;
  /** Click a page element with the real mouse and type into it with the keyboard. */
  typeOnPage(selector: string, text: string): Promise<void>;
  /** Choose an option of a page `select`, as the user would. */
  selectOnPage(selector: string, value: string): Promise<void>;
  /** Start picking with `p`, click the element, and wait for the host's selection. */
  pick(selector: string, index?: number, opts?: { alt?: boolean }): Promise<HookState>;
  /** Close the browser window like the user would, and wait for the CLI to exit. */
  closeWindow(): Promise<CliResult>;
}

async function connect(port: number, run: CliRun, timeoutMs = 30_000): Promise<Browser> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (run.child.exitCode !== null) throw new Error(`webscoop exited with ${run.child.exitCode}`);
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 });
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function recorderPage(browser: Browser, timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const page of browser.contexts().flatMap((c) => c.pages())) {
      const ready = await page
        .evaluate(() => (window as unknown as { __webscoopTest?: { state(): { host: unknown } } }).__webscoopTest?.state().host != null)
        .catch(() => false);
      if (ready) return page;
    }
    if (Date.now() > deadline) throw new Error('the recorder panel did not appear');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Start `webscoop record` (or `webscoop run --interactive`, whose recorder
 * shows up when a re-pick is needed) with a DevTools port and attach to its page.
 */
export async function startRecording(
  scoop: Scoop,
  args: string[],
  cleanups: (() => Promise<void>)[],
  command: 'record' | 'run' = 'record',
): Promise<Recording> {
  const port = await freePort();
  const argv = command === 'run' ? ['run', ...args, ...(args.includes('--interactive') ? [] : ['--interactive'])] : ['record', ...args];
  const run = scoop.spawn(argv, { WEBSCOOP_E2E_CDP_PORT: String(port) });
  const browser = await connect(port, run);
  cleanups.push(async () => {
    await browser.close().catch(() => {});
  });
  const page = await recorderPage(browser);
  const call = <T>(name: string, ...params: unknown[]): Promise<T> =>
    page.evaluate(([n, p]) => (window as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>).__webscoopTest![n as string]!(...(p as unknown[])), [name, params] as const) as Promise<T>;
  const center = async (selector: string, index = 0) => {
    const target = page.locator(selector).nth(index);
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`${selector} has no box`);
    return { x: box.x + Math.min(12, box.width / 2), y: box.y + box.height / 2 };
  };

  const recording: Recording = {
    run,
    browser,
    page,
    state: () => call<HookState>('state'),
    async until(check, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      let last: HookState | undefined;
      for (;;) {
        last = await recording.state();
        const value = check(last);
        if (value !== undefined && value !== false && value !== null) return value as never;
        if (Date.now() > deadline) throw new Error(`timed out waiting for recorder state; last error: ${last.host?.error ?? 'none'}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    query: (selector, index = 0) => call('query', selector, index),
    count: (selector) => call('count', selector),
    clickPanel: (selector, index = 0) => call('click', selector, index),
    fill: (selector, value, index = 0) => call('fill', selector, value, index),
    submit: (selector, value, index = 0) => call('submit', selector, value, index),
    async hover(selector, index = 0) {
      const point = await center(selector, index);
      await page.mouse.move(point.x, point.y);
      return point;
    },
    async click(selector, index = 0, opts = {}) {
      const point = await center(selector, index);
      if (opts.alt) await page.keyboard.down('Alt');
      await page.mouse.move(point.x, point.y);
      await page.mouse.click(point.x, point.y);
      if (opts.alt) await page.keyboard.up('Alt');
    },
    key: (key) => page.keyboard.press(key),
    async browse() {
      await page.keyboard.press('b');
      await recording.until((s) => s.ui.browsing);
    },
    async typeOnPage(selector, text) {
      await recording.click(selector);
      await page.keyboard.type(text);
    },
    async selectOnPage(selector, value) {
      await page.locator(selector).selectOption(value);
    },
    async pick(selector, index = 0, opts = {}) {
      const before = (await recording.state()).host?.selected?.selection;
      await page.keyboard.press('p');
      await recording.until((s) => s.ui.picking);
      await recording.click(selector, index, opts);
      return recording.until((s) => {
        const now = s.host?.selected?.selection;
        return now && now !== before && JSON.stringify(now.path) !== JSON.stringify(before?.path) && !s.ui.picking ? s : undefined;
      });
    },
    async closeWindow() {
      await page.close().catch(() => {});
      return run.done;
    },
  };
  return recording;
}
