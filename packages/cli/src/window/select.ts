import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Env } from '../paths';
import { PRESETS } from './presets';
import type { ProviderDef } from './types';

export interface WindowConfig {
  /** `auto`, `none`, a preset name, or a user provider name. */
  provider: string;
  providers: Record<string, ProviderDef>;
}

/** Path of an executable on `PATH`, or null. */
export type FindBinary = (name: string, env: Env) => string | null;

export const findOnPath: FindBinary = (name, env) => {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Not here.
    }
  }
  return null;
};

export type Selection =
  | { name: string; def: ProviderDef; binaryPath: string }
  | {
      name: 'none';
      def: null;
      /** Why a named provider was not used, for stderr and `doctor`. */
      warning?: string;
    };

/** Why a provider's detect rule fails, or null when it passes (with the binary path). */
function detect(def: ProviderDef, env: Env, findBinary: FindBinary): { ok: true; path: string } | { ok: false; why: string } {
  if (!env[def.detect.env]?.trim()) return { ok: false, why: `${def.detect.env} is not set` };
  const path = findBinary(def.detect.binary, env);
  if (!path) return { ok: false, why: `${def.detect.binary} is not on the PATH` };
  return { ok: true, path };
}

/**
 * Pick the window provider. `auto` tries the built-in `hyprland` (or a user
 * provider of that name, which replaces it), then user providers in
 * declaration order, else `none`. A named provider that does not detect falls
 * back to `none` with a warning. Only Linux has providers.
 */
export function selectProvider(config: WindowConfig, env: Env, opts: { findBinary?: FindBinary; platform?: NodeJS.Platform } = {}): Selection {
  const findBinary = opts.findBinary ?? findOnPath;
  const platform = opts.platform ?? process.platform;
  const lookup = (name: string): ProviderDef | undefined => config.providers[name] ?? PRESETS[name];

  if (config.provider === 'none') return { name: 'none', def: null };
  if (platform !== 'linux') {
    return config.provider === 'auto'
      ? { name: 'none', def: null }
      : { name: 'none', def: null, warning: `window provider ${config.provider} is for Linux only` };
  }

  if (config.provider === 'auto') {
    const order = [...new Set([...Object.keys(PRESETS), ...Object.keys(config.providers)])];
    for (const name of order) {
      const def = lookup(name)!;
      const found = detect(def, env, findBinary);
      if (found.ok) return { name, def, binaryPath: found.path };
    }
    return { name: 'none', def: null };
  }

  const def = lookup(config.provider);
  if (!def) return { name: 'none', def: null, warning: `unknown window provider ${config.provider}; the window stays visible` };
  const found = detect(def, env, findBinary);
  if (!found.ok) return { name: 'none', def: null, warning: `window provider ${config.provider} not usable: ${found.why}; the window stays visible` };
  return { name: config.provider, def, binaryPath: found.path };
}
