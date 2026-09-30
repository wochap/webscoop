import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserPort, Notification } from '@webscoop/core';
import { afterEach } from 'vitest';
import type { BrowserInfo, CliIo } from '../src';

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
  /** Profile directories `findBrowserPid` was asked about, in order. */
  pidLookups: string[];
}

export function testIo(opts: {
  env?: Record<string, string | undefined>;
  cwd?: string;
  homedir?: string;
  browser?: BrowserPort;
  chromium?: Partial<BrowserInfo>;
  /** Answers for terminal prompts, in order; null plays closed input. */
  answers?: (string | null)[];
  /** Process id `findBrowserPid` returns. Default: null, at once. */
  pid?: number | null;
}): TestIo {
  const answers = [...(opts.answers ?? [])];
  const prompts: string[] = [];
  let out = '';
  let err = '';
  let created = 0;
  const handlers = new Set<() => void>();
  const notifications: Notification[] = [];
  const pidLookups: string[] = [];
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
      return { driver: 'playwright', channel: 'chromium', id: '', path: '/opt/chromium/chrome', source: 'playwright', installed: true, version: 'Chromium 1', ...opts.chromium };
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
    async findBrowserPid(profileDir) {
      pidLookups.push(profileDir);
      return opts.pid ?? null;
    },
    notifications,
    pidLookups,
    prompts: () => prompts,
    out: () => out,
    err: () => err,
    browserCreated: () => created,
    interrupt: () => handlers.forEach((h) => h()),
  };
}
