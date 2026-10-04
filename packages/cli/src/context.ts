import type { BrowserPort, NotifyPort, OpenOptions, Session } from '@webscoop/core';
import type { BrowserChoice } from './browser';
import type { Config } from './config';
import type { ExitCode } from './exit';
import type { ClientLink } from './daemon/protocol';
import type { Env } from './paths';

export interface Output {
  write(chunk: string): unknown;
}

/** Everything a command touches in the outside world, injectable for tests. */
export interface CliIo {
  stdout: Output;
  stderr: Output;
  env: Env;
  cwd: string;
  homedir: string;
  /** Build the browser adapter for a resolved browser. Called only after the display check passed. */
  createBrowser(config: Config, env: Env, browser: BrowserInfo): BrowserPort | Promise<BrowserPort>;
  /** Resolve the browser that would be launched and probe its version. */
  chromium(config: Config, env: Env): Promise<BrowserInfo>;
  /** Register a SIGINT handler; returns an unsubscribe function. */
  onInterrupt(handler: () => void): () => void;
  /** Ask a question on the terminal; resolves null when input is closed. */
  prompt(question: string): Promise<string | null>;
  /** The injected recorder bundle; the e2e variant carries the test hook. */
  recorderBundle(variant: 'default' | 'e2e'): Promise<string>;
  /** Desktop notifications, for guards. */
  createNotify(env: Env, stderr?: Output): NotifyPort;
  /** Main process id of the browser running on an absolute profile directory, or null when none shows up within the deadline. */
  findBrowserPid(profileDir: string, deadlineMs: number): Promise<number | null>;
  /** Whether standard input and standard error are a terminal, so the command may ask questions. Default false. */
  terminal?: boolean;
  /** The controlling terminal, for prompts while a job runs; null without one. Default none. */
  tty?(): TtyPort | null;
  /** Launch a browser that jobs share, one tab per job. Default: one `createBrowser` session per tab. */
  launchBrowser?(config: Config, env: Env, browser: BrowserInfo, profileDir: string, opts: OpenOptions): Promise<SharedBrowserHandle>;
  /** The daemon's socket, for `run`, `test`, `daemon`, `attention`, and the exclusive commands. */
  daemon?: DaemonAccess;
  /** `daemon serve`: run the daemon until it has nothing left. */
  serveDaemon?(): Promise<ExitCode>;
}

/** Tab options of a shared browser. */
export interface TabOptions {
  humanize?: boolean;
  bypassCSP?: boolean;
  /** Absolute directory for the tab's downloads. */
  downloadDir?: string;
}

/** One browser shared by the jobs of a profile. */
export interface SharedBrowserHandle {
  /** Open a tab for one job; closing the session closes only the tab. */
  newSession(opts: TabOptions): Promise<Session>;
  close(): Promise<void>;
  /** Called once when the browser closes. Returns an unsubscribe function. */
  onClosed(cb: () => void): () => void;
}

/** Reaching the daemon. */
export interface DaemonAccess {
  /** This program's path, sent in the version handshake. */
  programPath: string;
  /** Connect to a running daemon; null when none answers. */
  connect(): Promise<ClientLink | null>;
  /** Start a daemon in the background. */
  spawn(): Promise<void>;
}

/** The controlling terminal, for the attention prompt. */
export interface TtyPort {
  write(text: string): void;
  /** Called with each line typed. Returns an unsubscribe function. */
  onLine(cb: (line: string) => void): () => void;
  close(): void;
}

/** A resolved browser with the result of its version probe. */
export interface BrowserInfo extends BrowserChoice {
  installed: boolean;
  version?: string;
  error?: string;
}

export function log(io: CliIo, message: string): void {
  io.stderr.write(`webscoop: ${message}\n`);
}

/** Chromium binary override: config first, then `WEBSCOOP_CHROMIUM`. */
export function chromiumOverride(config: Config, env: Env): string | undefined {
  return config.browser.executablePath ?? (env.WEBSCOOP_CHROMIUM?.trim() || undefined);
}
