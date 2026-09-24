import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserPort } from '@webscoop/core';
import { afterEach } from 'vitest';
import type { ChromiumInfo, CliIo } from '../src';

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
}

export function testIo(opts: {
  env?: Record<string, string | undefined>;
  cwd?: string;
  homedir?: string;
  browser?: BrowserPort;
  chromium?: Partial<ChromiumInfo>;
  /** Answers for terminal prompts, in order; null plays closed input. */
  answers?: (string | null)[];
}): TestIo {
  const answers = [...(opts.answers ?? [])];
  const prompts: string[] = [];
  let out = '';
  let err = '';
  let created = 0;
  const handlers = new Set<() => void>();
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
    prompts: () => prompts,
    out: () => out,
    err: () => err,
    browserCreated: () => created,
    interrupt: () => handlers.forEach((h) => h()),
  };
}
