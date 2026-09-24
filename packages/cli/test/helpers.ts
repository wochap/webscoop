import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoopWindow, type BrowserPort, type Notification, type WindowPort } from '@webscoop/core';
import { afterEach } from 'vitest';
import type { ChromiumInfo, CliIo, WindowMode } from '../src';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export async function tempDir(prefix = 'webscoop-cli-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

export interface TestIo extends CliIo {
  out: () => string;
  err: () => string;
  browserCreated: () => number;
  interrupt: () => void;
  prompts: () => string[];
  /** Notifications sent through `createNotify`. */
  notifications: Notification[];
  /** Calls to `createWindow`, in order. */
  windows: { profileDir: string; mode: WindowMode }[];
}

export function testIo(opts: {
  env?: Record<string, string | undefined>;
  cwd?: string;
  homedir?: string;
  browser?: BrowserPort;
  chromium?: Partial<ChromiumInfo>;
  /** Answers for terminal prompts, in order; null plays closed input. */
  answers?: (string | null)[];
  /** Port `createWindow` returns. Default: a `NoopWindow`. */
  window?: WindowPort;
}): TestIo {
  const answers = [...(opts.answers ?? [])];
  const prompts: string[] = [];
  let out = '';
  let err = '';
  let created = 0;
  const handlers = new Set<() => void>();
  const notifications: Notification[] = [];
  const windows: TestIo['windows'] = [];
  return {
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    env: opts.env ?? {},
    cwd: opts.cwd ?? '/',
    homedir: opts.homedir ?? '/home/test',
    createBrowser() {
      created++;
      if (!opts.browser) throw new Error('browser code must not run in this test');
      return opts.browser;
    },
    async chromium() {
      return { path: '/opt/chromium/chrome', source: 'playwright', installed: true, version: 'Chromium 1', ...opts.chromium };
    },
    onInterrupt(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async prompt(question) {
      prompts.push(question);
      return answers.length > 0 ? answers.shift()! : null;
    },
    async recorderBundle(variant) {
      return `/* recorder ${variant} */`;
    },
    createNotify: () => ({ notify: async (n) => void notifications.push(n) }),
    createWindow(_config, _env, window) {
      windows.push(window);
      return opts.window ?? new NoopWindow();
    },
    notifications,
    windows,
    prompts: () => prompts,
    out: () => out,
    err: () => err,
    browserCreated: () => created,
    interrupt: () => handlers.forEach((h) => h()),
  };
}
