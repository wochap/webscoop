import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadRecipe, saveRecipe, type BrowserPort, type Notification, type RecipeInput, type SerializedElement } from '@webscoop/core';
import { h } from '@webscoop/core/testing';
import { afterEach } from 'vitest';
import type { BrowserInfo, CliIo } from '../src';
import type { TtyPort } from '../src/context';
import { linkPair } from '../src/daemon/protocol';
import { DaemonServer } from '../src/daemon/server';
import { VERSION } from '../src/version';

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
  /** The in-process daemon, once a command started it. */
  daemonServer: () => DaemonServer | null;
  /** Daemons started so far. */
  daemonsStarted: () => number;
  /** What the daemon wrote to its log. */
  daemonLog: () => string;
}

/** A fake terminal: lines are typed with `type`, output collects in `output`. */
export interface FakeTty extends TtyPort {
  output: () => string;
  type(line: string): void;
  closed: () => boolean;
}

export function fakeTty(): FakeTty {
  let output = '';
  let closed = false;
  const listeners = new Set<(line: string) => void>();
  return {
    write: (text) => void (output += text),
    onLine(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    close: () => void (closed = true),
    output: () => output,
    type: (line) => [...listeners].forEach((cb) => cb(line)),
    closed: () => closed,
  };
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
  /** Whether stdin and stderr are a terminal. */
  terminal?: boolean;
  /** The controlling terminal for the attention prompt. */
  tty?: TtyPort;
  /** A daemon shared with other test I/Os, as if they ran in one user session. */
  daemon?: SharedDaemon;
}): TestIo {
  const answers = [...(opts.answers ?? [])];
  const prompts: string[] = [];
  let out = '';
  let err = '';
  let created = 0;
  const handlers = new Set<() => void>();
  const notifications: Notification[] = [];
  const pidLookups: string[] = [];
  const shared = opts.daemon ?? sharedDaemon();
  const io: TestIo = {
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
    terminal: opts.terminal ?? false,
    ...(opts.tty ? { tty: () => opts.tty! } : {}),
    daemon: {
      programPath: '/test/webscoop.js',
      connect: async () => shared.connect(),
      spawn: async () => shared.spawn(io),
    },
    daemonServer: () => shared.server,
    daemonsStarted: () => shared.started,
    daemonLog: () => shared.log,
    notifications,
    pidLookups,
    prompts: () => prompts,
    out: () => out,
    err: () => err,
    browserCreated: () => created,
    interrupt: () => handlers.forEach((h) => h()),
  };
  return io;
}

/** An in-process daemon several test I/Os can share; the first I/O that starts it provides its browsers. */
export interface SharedDaemon {
  server: DaemonServer | null;
  started: number;
  log: string;
  /** Version the daemon reports; tests change it to play an upgrade. */
  version: string;
  connect(): ReturnType<NonNullable<CliIo['daemon']>['connect']>;
  spawn(base: CliIo): void;
}

/** `idleMs` defaults to 0, so each test's browser closes after its job and frees the profile lock. */
export function sharedDaemon(opts: { idleMs?: number } = {}): SharedDaemon {
  const daemon: SharedDaemon = {
    server: null,
    started: 0,
    log: '',
    version: VERSION,
    async connect() {
      const server = daemon.server;
      if (!server || server.isExited) return null;
      const [client, end] = linkPair();
      server.accept(end);
      return client;
    },
    spawn(base) {
      if (daemon.server && !daemon.server.isExited) return;
      daemon.started++;
      const server: DaemonServer = new DaemonServer({
        base,
        version: daemon.version,
        programPath: '/test/webscoop.js',
        log: { write: (s: string) => (daemon.log += s) },
        idleMs: opts.idleMs ?? 0,
        onExit: () => {
          if (daemon.server === server) daemon.server = null;
        },
      });
      daemon.server = server;
    },
  };
  return daemon;
}

export const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };
export const SHOP_PAGE = 'https://shop.test/c/shoes';

/** A `WEBSCOOP_HOME` with the `shop` recipe (one `title` per `.card`) and an optional config. */
export async function shopHome(config?: unknown, extra: Partial<RecipeInput> = {}): Promise<string> {
  const dir = await tempDir();
  await mkdir(join(dir, 'recipes'), { recursive: true });
  const recipe: RecipeInput = {
    schemaVersion: 1,
    name: 'shop',
    url: SHOP_PAGE,
    item: { selectors: [{ strategy: 'css', value: '.card', stability: 'medium' }] },
    fields: [{ name: 'title', type: 'text', scope: 'item', selectors: [{ strategy: 'css', value: 'h2', stability: 'medium' }] }],
    ...extra,
  };
  await writeFile(join(dir, 'recipes', 'shop.json'), saveRecipe(loadRecipe(recipe)));
  if (config !== undefined) await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

/** A page with `n` product cards. */
export const shopCards = (n: number, label = 'item'): SerializedElement =>
  h('html', {}, h('body', {}, Array.from({ length: n }, (_, i) => h('div', { class: 'card' }, h('h2', {}, `${label} ${i}`)))));
