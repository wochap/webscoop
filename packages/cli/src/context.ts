import type { BrowserPort } from '@webscoop/core';
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
  /** Build the browser adapter. Called only after the display check passed. */
  createBrowser(config: Config, env: Env): BrowserPort | Promise<BrowserPort>;
  /** Report the Chromium binary that would be launched, for `doctor`. */
  chromium(config: Config, env: Env): Promise<ChromiumInfo>;
  /** Register a SIGINT handler; returns an unsubscribe function. */
  onInterrupt(handler: () => void): () => void;
}

export interface ChromiumInfo {
  path: string;
  /** `override` when set by config or `WEBSCOOP_CHROMIUM`, else the build Playwright expects. */
  source: 'playwright' | 'override';
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
