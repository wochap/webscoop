# window-provider Specification

## Purpose

Defines how webscoop keeps the browser window out of the user's way during unattended runs on a Wayland desktop and brings it back when a human is needed: how the window is identified, which providers exist, how they are selected, and how users add their own.

## Requirements

### Requirement: Provider model
A window provider SHALL consist of a `detect` rule (an environment variable that must be set and a binary that must be on the PATH), a `hide` command template, a `show` command template, and an optional `focus` command template. Templates SHALL be shell command lines in which `{pid}` is replaced by the browser process id and `{workspace}` by the active workspace identifier when the provider supplies one. Each command SHALL be run with a 2 second timeout; a failure SHALL be logged once to stderr and SHALL NOT fail the run.

#### Scenario: Command failure does not fail the run
- **WHEN** the `hide` command exits non-zero
- **THEN** stderr carries one line naming the provider and the run continues visible

### Requirement: Built-in providers
Two providers SHALL be built in:
- `hyprland`: detected when `HYPRLAND_INSTANCE_SIGNATURE` is set and `hyprctl` is on the PATH. `hide` moves the window to the `special:webscoop` workspace silently; `show` moves the window to the active workspace and focuses it. The active workspace SHALL be read from `hyprctl activeworkspace -j` at show time.
- `none`: detects nothing and runs no commands.

#### Scenario: Hyprland detected
- **WHEN** `HYPRLAND_INSTANCE_SIGNATURE` is set and `hyprctl` is found
- **THEN** the `hyprland` provider is selected under `auto`

#### Scenario: Nothing detected
- **WHEN** neither built-in nor user provider detects
- **THEN** `none` is selected and the window stays visible

### Requirement: User-defined providers
The config file MAY declare `window.providers`, a map from name to a provider definition with `detect` (`env` and `binary`), `hide`, `show`, and optional `focus` templates. A user provider SHALL be selectable by name through `window.provider` and SHALL take part in `auto` detection after the built-in ones.

#### Scenario: Custom sway provider
- **WHEN** config declares provider `sway` detected by `SWAYSOCK` and `swaymsg` with hide `swaymsg '[pid={pid}] move scratchpad'`
- **THEN** `window.provider: sway` uses those commands with the browser pid substituted

### Requirement: Selection
`window.provider` SHALL default to `auto`, which picks the first provider whose detect rule passes in the order built-in `hyprland`, then user providers in declaration order, else `none`. A named provider whose detect rule fails SHALL be reported as a warning and fall back to `none`.

#### Scenario: Named provider missing binary
- **WHEN** `window.provider` is `hyprland` and `hyprctl` is not on the PATH
- **THEN** a warning names `hyprctl` and the run proceeds without hiding

### Requirement: Window identification by process id
The provider SHALL identify the browser window by the process id of the Chromium main process for the run's profile, found among running processes by a command line containing `--user-data-dir=<profile directory>` and no `--type=` argument. When no such process is found within 5 seconds of the browser opening, hiding SHALL be skipped with a warning.

#### Scenario: Pid found
- **WHEN** Chromium is launched for profile `/home/u/.local/share/webscoop/profiles/shop`
- **THEN** the provider resolves the pid of the process whose command line contains that `--user-data-dir` and lacks `--type=`

### Requirement: When to hide and show
In an unattended run the window SHALL be hidden as soon as the browser has opened and the pid is known, shown when a guard is raised, and hidden again when the guard clears. The window SHALL NOT be hidden during recording, during an interactive run, or when the user passes `--show`. `--hide` SHALL hide even when config selects `none`, provided a provider detects. At the end of a run the window closes with the browser; no show is needed.

#### Scenario: Unattended run stays hidden
- **WHEN** `webscoop run shop` starts on Hyprland
- **THEN** the browser window is moved to `special:webscoop` before the first page is extracted and never appears on the active workspace

#### Scenario: Guard brings it back
- **WHEN** a login guard is raised
- **THEN** the window is moved to the active workspace and focused, and after the user logs in it is hidden again

#### Scenario: Interactive run stays visible
- **WHEN** `webscoop run shop --interactive` starts
- **THEN** no hide command is run

### Requirement: First frame
A provider MAY declare `prepare`, a command template without placeholders run once before the browser launches, and `args`, Chromium arguments added only to runs that hide. The `hyprland` preset SHALL launch hiding runs with `--class=webscoop` and SHALL, on a Lua Hyprland config, install at run time a window rule that places windows of class `webscoop` on `special:webscoop` silently as they map, at most once per Hyprland config load. On a classic config the `prepare` step SHALL fail silently and the user relies on the rule printed by `doctor`. Runs that never hide SHALL NOT receive these arguments.

#### Scenario: Window never flashes on a Lua config
- **WHEN** `webscoop run shop` starts on Hyprland with a Lua config
- **THEN** the browser window is on `special:webscoop` the first time the compositor lists it

#### Scenario: Visible runs keep their class
- **WHEN** `webscoop run shop --show` starts
- **THEN** Chromium is launched without `--class=webscoop`

### Requirement: Doctor output
`webscoop doctor` SHALL report the selected provider, its detection result, the binary path when found, and for Hyprland the window rule that prevents the window from appearing before the first hide: `windowrulev2 = workspace special:webscoop silent, class:^(webscoop)$`, its Lua form, and the note that hiding runs launch Chromium with `--class=webscoop` to match it.

#### Scenario: Doctor on Hyprland
- **WHEN** `webscoop doctor` runs on Hyprland with `hyprctl` present
- **THEN** it prints `window: hyprland (hyprctl at <path>)` and the rule line
