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
- `run.queued`: when a `run` or `test` job has to wait for a free slot in the daemon, with the number of jobs ahead.
- `browser.starting`: before a browser is launched for a command.
- `browser.started`: after the browser has opened, once its main process id is known or 5 seconds have passed.
- `browser.closed`: after the browser has closed.
- `run.start`: when `run` or `test` starts navigating a recipe.
- `run.done`: when a run or test ends successfully.
- `run.failed`: when a run or test ends unsuccessfully, including a guard timeout and an abort.
- `attention.needed`: when a run needs the user in the browser. The reason SHALL be:
  - `guard` when a guard is raised
  - `repick` when an interactive run asks for a re-pick
  - `await-user` when an `await-user` step waits for the user, with `WEBSCOOP_URL` set to the URL of the step's window and the step's label in the JSON details
- `attention.resolved`: when that need ends: the guard cleared, the re-pick was answered, the `await-user` condition held, or the run ended while it was open. Every `attention.needed` SHALL be followed by exactly one `attention.resolved`.
- `browser.show` and `browser.hide`: fired only by the `webscoop browser` command.

`record`, `edit`, and `bench` SHALL fire the browser events for the browser they launch. For `run` and `test`, the daemon SHALL fire `browser.starting` and `browser.started` when it launches a profile's browser and `browser.closed` when it closes it, once per browser lifetime, not once per job; a job served by an already open browser fires no browser events.

#### Scenario: Unattended run with a guard
- **WHEN** `webscoop run shop` hits a login guard on page 2, the user logs in, and the run finishes
- **THEN** the events fire in the order `browser.starting`, `browser.started`, `run.start`, `attention.needed`, `attention.resolved`, `run.done`, `browser.closed`

#### Scenario: Guard timeout closes the attention
- **WHEN** a guard is raised and its timeout elapses
- **THEN** `attention.resolved` fires before `run.failed`

#### Scenario: Warm browser fires no browser events
- **WHEN** a daemon browser for profile `default` is open and idle and `webscoop run shop` runs on it
- **THEN** the hooks see `run.start` and `run.done` and no `browser.*` event

#### Scenario: Queued job
- **WHEN** `daemon.concurrency` is 1, a job runs on profile `default`, and a second job on `default` is submitted
- **THEN** `run.queued` fires for the second job with 1 job ahead

#### Scenario: Await-user attention
- **WHEN** a run's `await-user` step labeled "Log in to SOL" waits in a popup and the user logs in
- **THEN** `attention.needed` fires with reason `await-user` and the popup's URL, followed by `attention.resolved`

### Requirement: Hooks in the daemon
Hooks for events of `run` and `test` SHALL be run by the daemon, one at a time per daemon, with the same contract as other hooks. Hooks of `run.*` and `attention.*` events SHALL receive the environment of the command that submitted the job. Hooks of browser events SHALL receive the environment of the job that caused the launch, or of the last job served by that browser for `browser.closed`. A hook's standard output and error SHALL go to the daemon log.

#### Scenario: Job environment reaches the hook
- **WHEN** `FOO=1 webscoop run shop` runs through a daemon started from a shell without `FOO`, and an `attention.needed` hook runs `test "$FOO" = 1`
- **THEN** the hook exits 0

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

Its stdin SHALL receive one JSON object holding `event`, `at` (ISO timestamp), the same values as the variables above, the recipe's variable values as `vars` (secret variables left out), and the event's details: for `attention.needed` the guard kind or re-pick target and the page number; for `run.done` and `run.failed` the row count, the page count, and the failure message. Values SHALL never be substituted into the command line.

#### Scenario: Script reads the pid
- **WHEN** a hook for `browser.started` runs `hyprctl dispatch focuswindow pid:$WEBSCOOP_BROWSER_PID`
- **THEN** the command receives the browser main process id in `WEBSCOOP_BROWSER_PID`

#### Scenario: Payload on stdin
- **WHEN** `webscoop run bing --var query=cat` fires `run.start` to a hook running `jq -r .vars.query`
- **THEN** the hook prints `cat`

#### Scenario: Secrets stay out of hooks
- **WHEN** a run with secret variable `pass` fires `run.start` to a hook running `jq .vars`
- **THEN** the printed object has no `pass` key

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
