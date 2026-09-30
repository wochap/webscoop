import { join } from 'node:path';
import type { Env } from '../paths';

/**
 * The daemon's socket: under `$WEBSCOOP_HOME/run` when set, else
 * `$XDG_RUNTIME_DIR/webscoop`, else `/tmp/webscoop-<uid>`.
 */
export function socketPath(env: Env, uid: number): string {
  const home = env.WEBSCOOP_HOME?.trim();
  if (home) return join(home, 'run', 'daemon.sock');
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  if (runtime) return join(runtime, 'webscoop', 'daemon.sock');
  return join('/tmp', `webscoop-${uid}`, 'daemon.sock');
}

/** The daemon log in the state directory: `$WEBSCOOP_HOME`, else `$XDG_STATE_HOME/webscoop`, else `~/.local/state/webscoop`. */
export function daemonLogPath(env: Env, homedir: string): string {
  const home = env.WEBSCOOP_HOME?.trim();
  if (home) return join(home, 'daemon.log');
  const state = env.XDG_STATE_HOME?.trim();
  return join(state || join(homedir, '.local', 'state'), 'webscoop', 'daemon.log');
}
