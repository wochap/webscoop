import { resolve } from 'node:path';
import { loadConfig } from '../config';
import { log, type CliIo } from '../context';
import { CliError, ExitCode, type ExitCode as Code } from '../exit';
import { HookRunner } from '../hooks';
import { resolvePaths } from '../paths';
import { checkProfileName, profileDirFor } from '../profiles';

export interface BrowserCommandOptions {
  profile?: string;
}

/** How long `browser show|hide` looks for the running browser. */
export const BROWSER_COMMAND_PID_DEADLINE_MS = 1000;

/** Profile used without `--profile` and without `profiles.default`. */
export const FALLBACK_PROFILE = 'default';

/**
 * `webscoop browser show|hide`: find the browser running on a profile and fire
 * `browser.show` or `browser.hide` with its pid, so the user's own hooks move
 * the window. Exits 1 when no browser runs on the profile.
 */
export async function browserCommand(io: CliIo, action: 'show' | 'hide', opts: BrowserCommandOptions): Promise<Code> {
  const paths = resolvePaths(io.env, io.homedir);
  const config = await loadConfig(paths, (message) => log(io, message));
  const profile = opts.profile ?? config.profiles.default ?? FALLBACK_PROFILE;
  checkProfileName(profile);
  const browser = await io.chromium(config, io.env);
  const profileDir = resolve(profileDirFor(paths, profile, browser));
  const pid = await io.findBrowserPid(profileDir, BROWSER_COMMAND_PID_DEADLINE_MS);
  if (pid === null) throw new CliError(`no browser is running for profile "${profile}" (${profileDir})`);
  const event = action === 'show' ? 'browser.show' : 'browser.hide';
  const hooks = new HookRunner(config, { command: 'browser', profile, profileDir }, io);
  if (!hooks.has(event)) {
    log(io, `warning: no hook is configured for ${event}; add one under "hooks" in the config`);
    return ExitCode.Ok;
  }
  hooks.setPid(pid);
  await hooks.fire(event);
  return ExitCode.Ok;
}
