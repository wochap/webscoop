import type { Env } from '../paths';

/**
 * A window provider: shell command templates that move the browser window
 * away and back through the desktop's compositor. `{pid}` is replaced by the
 * Chromium main process id, `{workspace}` by the output of `workspace`.
 */
export interface ProviderDef {
  /** Passes when the environment variable is set and the binary is on the PATH. */
  detect: { env: string; binary: string };
  hide: string;
  show: string;
  focus?: string;
  /**
   * Run once before the browser launches, without placeholders: installs a
   * compositor rule that sends the window away as it maps, so it never shows.
   */
  prepare?: string;
  /** Chromium arguments added to hiding runs, for the `prepare` rule to match (such as `--class=webscoop`). */
  args?: string[];
  /**
   * Prints the workspace the user is on, run right before `show`. A JSON
   * object yields its `id` (else its `name`); anything else is used trimmed.
   */
  workspace?: string;
}

/** Run a shell command line; resolves its stdout, rejects on a non-zero exit or the timeout. */
export type Exec = (line: string, opts: { timeoutMs: number; env: Env }) => Promise<string>;
