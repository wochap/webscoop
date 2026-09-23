import { join } from 'node:path';

export interface Paths {
  /** Root for recipes and profiles. */
  dataRoot: string;
  /** Root for the config file. */
  configRoot: string;
  recipesDir: string;
  profilesDir: string;
  configFile: string;
  /** Which rule produced the roots, for `doctor`. */
  source: 'WEBSCOOP_HOME' | 'XDG' | 'default';
}

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Resolve every location once, at startup. `WEBSCOOP_HOME` overrides both
 * roots; otherwise the XDG variables apply, falling back to `~/.local/share`
 * and `~/.config`.
 */
export function resolvePaths(env: Env, homedir: string): Paths {
  const home = env.WEBSCOOP_HOME?.trim();
  if (home) {
    return {
      dataRoot: home,
      configRoot: home,
      recipesDir: join(home, 'recipes'),
      profilesDir: join(home, 'profiles'),
      configFile: join(home, 'config.json'),
      source: 'WEBSCOOP_HOME',
    };
  }
  const xdgData = env.XDG_DATA_HOME?.trim();
  const xdgConfig = env.XDG_CONFIG_HOME?.trim();
  const dataRoot = join(xdgData || join(homedir, '.local', 'share'), 'webscoop');
  const configRoot = join(xdgConfig || join(homedir, '.config'), 'webscoop');
  return {
    dataRoot,
    configRoot,
    recipesDir: join(dataRoot, 'recipes'),
    profilesDir: join(dataRoot, 'profiles'),
    configFile: join(configRoot, 'config.json'),
    source: xdgData || xdgConfig ? 'XDG' : 'default',
  };
}
