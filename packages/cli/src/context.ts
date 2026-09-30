import type { BrowserPort, NotifyPort } from '@webscoop/core';
import type { BrowserChoice } from './browser';
import type { Config } from './config';
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
  createNotify(env: Env): NotifyPort;
  /** Main process id of the browser running on an absolute profile directory, or null when none shows up within the deadline. */
  findBrowserPid(profileDir: string, deadlineMs: number): Promise<number | null>;
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
