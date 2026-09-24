import type { ProviderDef } from './types';

/** Special workspace the Hyprland preset hides the browser window on. */
export const HYPRLAND_WORKSPACE = 'special:webscoop';
/** Wayland app id of hiding runs' browser windows, set with `--class`. */
export const WINDOW_CLASS = 'webscoop';

/** Rule for `hyprland.conf` that sends the window away as it maps, before the first hide. */
export const HYPRLAND_RULE = `windowrulev2 = workspace ${HYPRLAND_WORKSPACE} silent, class:^(${WINDOW_CLASS})$`;
/** The same rule for a Lua config. */
export const HYPRLAND_RULE_LUA = `hl.window_rule({ match = { class = "^(${WINDOW_CLASS})$" }, workspace = "${HYPRLAND_WORKSPACE} silent" })`;

/**
 * A Lua config takes rules at run time, but never drops them until a reload;
 * a global in the compositor's Lua state (reset by the same reload) keeps it
 * to one rule per session. A classic config needs `HYPRLAND_RULE` pasted in.
 */
const PREPARE = `hyprctl eval 'if not _G.__webscoop_rule then _G.__webscoop_rule = ${HYPRLAND_RULE_LUA} end' >/dev/null 2>&1 || true`;

/**
 * Hyprland dispatches in Lua syntax when the config is Lua (0.56 and later),
 * in the classic syntax otherwise. Each command tries Lua first, which prints
 * `ok` on success, and falls back to the classic dispatcher.
 */
const dispatch = (lua: string, classic: string) => `hyprctl dispatch '${lua}' 2>/dev/null | grep -qx ok || hyprctl dispatch ${classic}`;

export const HYPRLAND: ProviderDef = {
  detect: { env: 'HYPRLAND_INSTANCE_SIGNATURE', binary: 'hyprctl' },
  hide: dispatch(
    `hl.dsp.window.move({ workspace = "${HYPRLAND_WORKSPACE}", follow = false, window = "pid:{pid}" })`,
    `movetoworkspacesilent ${HYPRLAND_WORKSPACE},pid:{pid}`,
  ),
  show: dispatch('hl.dsp.window.move({ workspace = "{workspace}", follow = false, window = "pid:{pid}" })', 'movetoworkspace {workspace},pid:{pid}'),
  focus: dispatch('hl.dsp.focus({ window = "pid:{pid}" })', 'focuswindow pid:{pid}'),
  workspace: 'hyprctl activeworkspace -j',
  prepare: PREPARE,
  args: [`--class=${WINDOW_CLASS}`],
};

/** Built-in providers by name; `none` is handled apart, it runs nothing. */
export const PRESETS: Readonly<Record<string, ProviderDef>> = { hyprland: HYPRLAND };
