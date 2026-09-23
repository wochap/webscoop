import { CliError } from './exit';
import type { Env } from './paths';

export interface DisplayInfo {
  available: boolean;
  /** e.g. `WAYLAND_DISPLAY=wayland-1`. */
  description: string;
}

export function detectDisplay(env: Env): DisplayInfo {
  const found = (['WAYLAND_DISPLAY', 'DISPLAY'] as const).filter((name) => env[name]?.trim());
  if (found.length === 0) return { available: false, description: 'none (WAYLAND_DISPLAY and DISPLAY are unset)' };
  return { available: true, description: found.map((name) => `${name}=${env[name]}`).join(', ') };
}

/** Fail with exit 1 before any browser code runs when no display is available. */
export function requireDisplay(env: Env): void {
  if (!detectDisplay(env).available) {
    throw new CliError(
      'a display is required: webscoop runs a visible browser. Set WAYLAND_DISPLAY or DISPLAY ' +
        '(run from a desktop session, or under a headless compositor such as sway or Xvfb).',
    );
  }
}
