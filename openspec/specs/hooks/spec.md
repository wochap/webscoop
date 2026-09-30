# hooks Specification

## Purpose

Lets users react to webscoop lifecycle events with their own shell commands, so window placement, notifications, and other desktop integration stay under the user's control instead of being built into webscoop.

## Requirements

### Requirement: Hook config
The config file MAY declare `hooks`, a map from an event name to a command line or a list of command lines. Event names SHALL be the ones defined in "Lifecycle events"; an unknown event name SHALL be a config error that names it. The config MAY declare `hookTimeoutMs`, a positive integer defaulting to 5000. With no `hooks` block, no commands SHALL run.

#### Scenario: One command for an event
- **WHEN** the config has `"hooks": { "attention.needed": "~/bin/ws-show.sh" }` and a guard is raised
- **THEN** `~/bin/ws-show.sh` runs once for that event

#### Scenario: Unknown event rejected
- **WHEN** the config has `"hooks": { "attention.maybe": "true" }`
- **THEN** every command that loads the config exits 1 with an error naming `attention.maybe`

### Requirement: Lifecycle events
The CLI SHALL fire these events:
- `browser.starting`: before a browser is launched for a command.
- `browser.started`: after the browser has opened, once its main process id is known or 5 seconds have passed.
- `browser.closed`: after the browser has closed.
- `run.start`: when `run` or `test` starts navigating a recipe.
- `run.done`: when a run or test ends successfully.
- `run.failed`: when a run or test ends unsuccessfully, including a guard timeout and an abort.
- `attention.needed`: when a run needs the user in the browser. The reason SHALL be `guard` when a guard is raised and `repick` when an interactive run asks for a re-pick.
- `attention.resolved`: when that need ends: the guard cleared, the re-pick was answered, or the run ended while it was open. Every `attention.needed` SHALL be followed by exactly one `attention.resolved`.
- `browser.show` and `browser.hide`: fired only by the `webscoop browser` command.

`record`, `edit`, `run`, `test`, and `bench` SHALL fire the browser events.

#### Scenario: Unattended run with a guard
- **WHEN** `webscoop run shop` hits a login guard on page 2, the user logs in, and the run finishes
- **THEN** the events fire in the order `browser.starting`, `browser.started`, `run.start`, `attention.needed`, `attention.resolved`, `run.done`, `browser.closed`

#### Scenario: Guard timeout closes the attention
- **WHEN** a guard is raised and its timeout elapses
- **THEN** `attention.resolved` fires before `run.failed`

### Requirement: Hook command contract
Each command SHALL be run with `/bin/sh -c`, with the environment of the webscoop process plus:
- `WEBSCOOP_EVENT`: the event name
- `WEBSCOOP_COMMAND`: the webscoop subcommand (`run`, `test`, `record`, `edit`, `bench`, `browser`)
- `WEBSCOOP_PROFILE` and `WEBSCOOP_PROFILE_DIR`: the profile name and directory
- `WEBSCOOP_BROWSER_PID`: the browser main process id, when known
- `WEBSCOOP_RECIPE`: the recipe name, when there is one
- `WEBSCOOP_RUN_ID`: an identifier unique to the command invocation
- `WEBSCOOP_URL`: the page URL, when there is one
- `WEBSCOOP_REASON`: the attention reason, or the failure reason for `run.failed`

Its stdin SHALL receive one JSON object holding `event`, `at` (ISO timestamp), the same values as the variables above, the recipe's variable values as `vars`, and the event's details: for `attention.needed` the guard kind or re-pick target and the page number; for `run.done` and `run.failed` the row count, the page count, and the failure message. Values SHALL never be substituted into the command line.

#### Scenario: Script reads the pid
- **WHEN** a hook for `browser.started` runs `hyprctl dispatch focuswindow pid:$WEBSCOOP_BROWSER_PID`
- **THEN** the command receives the browser main process id in `WEBSCOOP_BROWSER_PID`

#### Scenario: Payload on stdin
- **WHEN** `webscoop run bing --var query=cat` fires `run.start` to a hook running `jq -r .vars.query`
- **THEN** the hook prints `cat`

### Requirement: Hook ordering and failure
Hook commands of one webscoop process SHALL run one at a time, in the order their events fired, and for one event in the order configured. The command SHALL wait for `browser.starting` hooks to finish before launching the browser. It SHALL NOT wait for other hooks, except that before the process exits it SHALL wait for hooks still pending. A command that runs longer than `hookTimeoutMs` SHALL be killed. A command that fails to start, exits non-zero, or times out SHALL produce one stderr warning naming the event and the command, and SHALL NOT change the outcome or exit code of the webscoop command.

#### Scenario: Slow hook does not slow extraction
- **WHEN** a hook for `run.start` sleeps 3 seconds
- **THEN** extraction starts without waiting for it

#### Scenario: Failing hook
- **WHEN** a hook for `run.done` exits 1
- **THEN** stderr has a warning naming `run.done` and the command, and `webscoop run` still exits 0

#### Scenario: Rule installed before the window maps
- **WHEN** a hook for `browser.starting` installs a window manager rule
- **THEN** the browser is launched only after that hook exits

### Requirement: `browser` command
`webscoop browser show [--profile <name>]` and `webscoop browser hide [--profile <name>]` SHALL resolve the profile as `run` does without a recipe, find the running browser main process for that profile directory, and fire `browser.show` or `browser.hide` with `WEBSCOOP_BROWSER_PID` set. The command SHALL exit 0 after the hooks finish, and exit 1 with a message naming the profile when no browser is running for it. With no hook configured for the event, it SHALL print a warning saying so and exit 0.

#### Scenario: Bring the browser back
- **WHEN** a run on profile `default` is paused on a guard and the user runs `webscoop browser show`
- **THEN** the `browser.show` hooks run with the pid of that run's browser

#### Scenario: Nothing running
- **WHEN** no browser is running for profile `shop` and the user runs `webscoop browser show --profile shop`
- **THEN** it exits 1 with a message naming `shop`
