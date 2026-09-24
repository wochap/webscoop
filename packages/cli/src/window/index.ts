import { resolve } from 'node:path';
import { NoopWindow, type WindowPort } from '@webscoop/core';
import type { Config } from '../config';
import type { Output } from '../context';
import type { Env } from '../paths';
import { CommandWindow } from './command-window';
import { findBrowserPid } from './pid';
import { selectProvider, type FindBinary } from './select';
import type { Exec } from './types';

export { CommandWindow, execShell, parseWorkspace, substitute, WINDOW_COMMAND_TIMEOUT_MS, type TemplateVars } from './command-window';
export { findBrowserPid, type FindPidOptions } from './pid';
export { HYPRLAND, HYPRLAND_RULE, HYPRLAND_RULE_LUA, HYPRLAND_WORKSPACE, PRESETS, WINDOW_CLASS } from './presets';
export { findOnPath, selectProvider, type FindBinary, type Selection, type WindowConfig } from './select';
export type { Exec, ProviderDef } from './types';

/** `show` never hides, `hide` hides even when config says `none`, `auto` follows config. */
export type WindowMode = 'hide' | 'show' | 'auto';

/** Window mode from the flags: interactive runs and `--show` stay visible, `--hide` forces hiding. */
export function windowMode(opts: { show?: boolean; hide?: boolean; interactive?: boolean }): WindowMode {
  if (opts.interactive || opts.show) return 'show';
  if (opts.hide) return 'hide';
  return 'auto';
}

export interface CreateWindowOptions {
  profileDir: string;
  mode: WindowMode;
  stderr: Output;
  /** Injectable for tests. */
  findBinary?: FindBinary;
  exec?: Exec;
  findPid?: (profileDir: string) => Promise<number | null>;
  platform?: NodeJS.Platform;
}

/** The window port for a run: a provider's commands, or nothing when none applies. */
export function createWindowPort(config: Config, env: Env, opts: CreateWindowOptions): WindowPort {
  if (opts.mode === 'show') return new NoopWindow();
  const warn = (message: string) => opts.stderr.write(`webscoop: ${message}\n`);
  // `--hide` overrides a config that turned hiding off, but still needs a provider that detects.
  const provider = opts.mode === 'hide' && config.window.provider === 'none' ? 'auto' : config.window.provider;
  const selection = selectProvider({ provider, providers: config.window.providers }, env, {
    ...(opts.findBinary ? { findBinary: opts.findBinary } : {}),
    ...(opts.platform ? { platform: opts.platform } : {}),
  });
  if (!selection.def) {
    if (selection.warning) warn(selection.warning);
    else if (opts.mode === 'hide') warn('--hide: no window provider detected; the window stays visible');
    return new NoopWindow();
  }
  // Chromium gets the profile directory as an absolute path.
  const profileDir = resolve(opts.profileDir);
  return new CommandWindow({
    name: selection.name,
    def: selection.def,
    pid: () => (opts.findPid ?? findBrowserPid)(profileDir),
    env,
    warn,
    ...(opts.exec ? { exec: opts.exec } : {}),
  });
}
