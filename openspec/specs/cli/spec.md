# cli Specification

## Purpose

Defines the `webscoop` command line interface: the commands users and cron jobs invoke, where files live, what goes to stdout and stderr, and what exit codes mean. The CLI is the product surface; every other capability is reached through it.

## Requirements

### Requirement: One process per invocation
The CLI SHALL perform one command per invocation and exit when it completes. It SHALL NOT leave a daemon, server, or browser process running after exit.

#### Scenario: Process exits after run
- **WHEN** `webscoop run <recipe>` completes
- **THEN** the process exits and no Chromium process started by it remains

### Requirement: Exit codes
The CLI SHALL exit with:
- `0` when the command succeeded
- `1` on an error the user must fix or an unexpected failure (bad arguments, invalid recipe, no display, browser crash)
- `2` when a run was paused for user input and the wait timed out
- `3` when a run could not resolve a required field and no recovery was possible

A cron job SHALL be able to treat `2` as "retry later" and `3` as "alert a human".

#### Scenario: Invalid recipe
- **WHEN** `webscoop run` is given a recipe that fails validation
- **THEN** the errors are printed to stderr and the exit code is 1

#### Scenario: Required field missing
- **WHEN** a required field resolves no element on the page
- **THEN** the exit code is 3

#### Scenario: Optional field missing
- **WHEN** only optional fields fail to resolve
- **THEN** rows are emitted with `null` for those fields and the exit code is 0

### Requirement: Output streams
Extracted data SHALL go to stdout only. Logs, progress, and errors SHALL go to stderr only. Default stdout format SHALL be a single JSON array of row objects. With `--jsonl`, stdout SHALL carry one JSON object per line, written as soon as each row is available. With `--out <path>`, the same content SHALL be written to that file instead of stdout.

#### Scenario: Piping into jq
- **WHEN** `webscoop run shop | jq length` is executed
- **THEN** jq receives only the JSON array and prints the row count

#### Scenario: JSONL streams rows
- **WHEN** `webscoop run shop --jsonl` is executed
- **THEN** each row appears on stdout as its own line, and stderr carries the log

### Requirement: Row shape
Each emitted row SHALL contain one key per recipe field, plus `_page` (1-based page number) and `_index` (0-based index within the page). Values SHALL be converted per field type: `number` parses the first numeric token in the text and yields `null` when none is found; `url` and `image` resolve relative URLs against the page URL; `date` yields an ISO 8601 string when parseable, else the raw text; `html` yields inner HTML; `text` yields trimmed, whitespace-collapsed text.

#### Scenario: Number parsing
- **WHEN** a `number` field's text is `$1,299.00`
- **THEN** the row value is `1299`

#### Scenario: Relative URL resolution
- **WHEN** a `url` field reads `href="/p/42"` on `https://shop.test/c/shoes`
- **THEN** the row value is `https://shop.test/p/42`

### Requirement: `run` command
`webscoop run <recipe> [--var name=value]... [--jsonl] [--out path] [--profile name] [--timeout ms]` SHALL load the named recipe, substitute variables from `--var` and declared defaults, fail with exit 1 when a variable has no value, execute the recipe, and emit rows. `<recipe>` SHALL be either a recipe name in the recipes directory or a path to a recipe file.

#### Scenario: Missing variable value
- **WHEN** the recipe declares `category` without a default and `--var category=...` is not given
- **THEN** stderr names `category` and the exit code is 1

#### Scenario: Run by path
- **WHEN** `webscoop run ./my.json` is executed
- **THEN** the recipe at that path is used without consulting the recipes directory

### Requirement: `recipes` command
`webscoop recipes` SHALL list the recipes in the recipes directory with name, URL template, field count, and last modified time. With `--json` it SHALL print the same as a JSON array.

#### Scenario: Empty recipes directory
- **WHEN** no recipes exist
- **THEN** the command prints nothing to stdout and exits 0

### Requirement: `doctor` command
`webscoop doctor` SHALL report the resolved config, recipes, and profiles paths, whether a display is available, whether the Chromium build Playwright expects is installed, and the configured LLM endpoint if any. It SHALL exit 1 when Chromium is missing or no display is available.

#### Scenario: No display
- **WHEN** neither `WAYLAND_DISPLAY` nor `DISPLAY` is set
- **THEN** doctor reports the missing display and exits 1

### Requirement: File locations
The CLI SHALL use XDG paths: recipes under `$XDG_DATA_HOME/webscoop/recipes/`, browser profiles under `$XDG_DATA_HOME/webscoop/profiles/`, config at `$XDG_CONFIG_HOME/webscoop/config.json`. When the XDG variables are unset, `~/.local/share` and `~/.config` SHALL be used. `WEBSCOOP_HOME` SHALL override both roots when set, so tests can isolate state.

#### Scenario: Isolated home for tests
- **WHEN** `WEBSCOOP_HOME=/tmp/x` is set
- **THEN** recipes are read from `/tmp/x/recipes/` and profiles are created under `/tmp/x/profiles/`

### Requirement: Display required
Every command that opens a browser SHALL check for a display first and exit 1 with a clear message when none is available, without starting Chromium.

#### Scenario: Run without display
- **WHEN** `webscoop run shop` is executed with no display variables set
- **THEN** stderr explains that a display is required and the exit code is 1
