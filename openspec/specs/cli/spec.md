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

#### Scenario: Required field missing on some rows
- **WHEN** a required field resolves on some containers of the page and not on others
- **THEN** the rows without it are not in the output, stderr names the field and the dropped rows, and the exit code is 0

#### Scenario: Optional field missing
- **WHEN** only optional fields fail to resolve
- **THEN** rows are emitted with `null` for those fields and the exit code is 0

### Requirement: Output streams
Extracted data SHALL go to stdout only. Logs, progress, and errors SHALL go to stderr only. For a recipe with one table, the default stdout format SHALL be a single JSON array of row objects, and with `--jsonl` stdout SHALL carry one JSON object per line, written as soon as each row is available. For a recipe with several tables, the default stdout format SHALL be a single JSON object with one key per table name, in recipe order, each holding that table's array of rows; with `--jsonl` each line SHALL be one row carrying `_table` with its table name, written as soon as the row is available. `--table <name>` SHALL restrict the output to that table in the single table shapes and SHALL exit 1 naming the table when the recipe has none by that name. With `--out <path>`, the same content SHALL be written to that file instead of stdout; when `<path>` is an existing directory or ends with a path separator, one file per table named `<table>.json` (or `<table>.jsonl` with `--jsonl`) SHALL be written into it, each in the single table shape.

#### Scenario: Piping into jq
- **WHEN** `webscoop run shop | jq length` is executed
- **THEN** jq receives only the JSON array and prints the row count

#### Scenario: JSONL streams rows
- **WHEN** `webscoop run shop --jsonl` is executed
- **THEN** each row appears on stdout as its own line, and stderr carries the log

#### Scenario: Two tables as JSON
- **WHEN** `webscoop run results` is executed for a recipe with tables `page` and `products`
- **THEN** stdout is one JSON object with keys `page` and `products`, each an array of rows

#### Scenario: Two tables as JSONL
- **WHEN** `webscoop run results --jsonl` is executed for the same recipe
- **THEN** every line carries `_table` set to `page` or `products`

#### Scenario: One table of many
- **WHEN** `webscoop run results --table products | jq length` is executed
- **THEN** jq receives only the `products` array and prints its row count

#### Scenario: Directory output
- **WHEN** `webscoop run results --out ./data/` is executed
- **THEN** `./data/page.json` and `./data/products.json` exist, each a JSON array, and stdout is empty

### Requirement: Row shape
Each emitted row SHALL contain one key per field of its table, plus `_page` (1-based page number) and `_index` (0-based index within the page and table). In JSONL output of a recipe with several tables, each row SHALL also carry `_table`. Values SHALL be converted per field type: `number` parses the first numeric token in the text and yields `null` when none is found; `url` and `image` resolve relative URLs against the page URL; `date` yields an ISO 8601 string when parseable, else the raw text; `html` yields inner HTML; `text` yields trimmed, whitespace-collapsed text.

#### Scenario: Number parsing
- **WHEN** a `number` field's text is `$1,299.00`
- **THEN** the row value is `1299`

#### Scenario: Relative URL resolution
- **WHEN** a `url` field reads `href="/p/42"` on `https://shop.test/c/shoes`
- **THEN** the row value is `https://shop.test/p/42`

#### Scenario: Page table row
- **WHEN** the table `page` has a `heading` field and the run extracts 2 pages
- **THEN** `page` yields two rows with `_page` 1 and 2, both with `_index` 0

### Requirement: `run` command
`webscoop run <recipe> [--var name=value]... [--jsonl] [--out path] [--table name] [--profile name] [--timeout ms]` SHALL load the named recipe, substitute variables from `--var` and declared defaults, fail with exit 1 when a variable has no value, execute the recipe, and emit rows. `<recipe>` SHALL be either a recipe name in the recipes directory or a path to a recipe file.

#### Scenario: Missing variable value
- **WHEN** the recipe declares `category` without a default and `--var category=...` is not given
- **THEN** stderr names `category` and the exit code is 1

#### Scenario: Run by path
- **WHEN** `webscoop run ./my.json` is executed
- **THEN** the recipe at that path is used without consulting the recipes directory

#### Scenario: Unknown table
- **WHEN** `webscoop run results --table ads` is executed and the recipe has no table `ads`
- **THEN** stderr names `ads` and the declared table names, and the exit code is 1

### Requirement: `recipes` command
`webscoop recipes` SHALL list the recipes in the recipes directory with name, URL template, field count, and last modified time. With `--json` it SHALL print the same as a JSON array.

#### Scenario: Empty recipes directory
- **WHEN** no recipes exist
- **THEN** the command prints nothing to stdout and exits 0

### Requirement: `doctor` command
`webscoop doctor` SHALL report the resolved config, recipes, and profiles paths, whether a display is available, whether the Chromium build Playwright expects is installed, and the configured LLM endpoint if any. When an endpoint and model are configured, it SHALL probe the endpoint: reachable or not, whether the model is listed, the round-trip time of a one-token completion, and a warning when `contextTokens` is below 8192. It SHALL exit 1 when Chromium is missing or no display is available; an unreachable or misconfigured LLM SHALL be reported as a warning and SHALL NOT change the exit code.

#### Scenario: No display
- **WHEN** neither `WAYLAND_DISPLAY` nor `DISPLAY` is set
- **THEN** doctor reports the missing display and exits 1

#### Scenario: Endpoint probe
- **WHEN** an endpoint and model are configured and reachable
- **THEN** doctor prints the model as found and the round-trip time, and exits 0

#### Scenario: Endpoint down
- **WHEN** an endpoint is configured but refuses connections
- **THEN** doctor prints a warning naming the endpoint and still exits 0 when display and Chromium are fine

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

### Requirement: `record` command
`webscoop record <url-template> [--name <recipe>] [--var name=value]... [--profile <name>] [--timeout <ms>]` SHALL start a recording session for the given URL template. `webscoop record --edit <recipe>` SHALL start a session for an existing recipe by name or path, whatever its number of tables. The command SHALL require a display, take the profile lock like `run`, and hold the process open until the session ends. When `--name` is omitted, the session SHALL propose a name derived from the URL host and path and let the user change it before saving.

#### Scenario: Record with a template variable
- **WHEN** `webscoop record "http://127.0.0.1:4777/catalog?cat={category}"` is executed
- **THEN** the browser opens after the user supplies `category`, and the panel shows the template

#### Scenario: Edit existing recipe
- **WHEN** `webscoop record --edit playground-catalog` is executed
- **THEN** the session opens the recipe's URL with its fields loaded

#### Scenario: Variable given on the command line
- **WHEN** `--var category=shoes` is passed
- **THEN** the session does not prompt for `category`

#### Scenario: Edit a multi-table recipe
- **WHEN** `webscoop record --edit results` is executed and `results` declares two tables
- **THEN** the session opens with both tables in the panel

### Requirement: `record` exit behavior
The `record` command SHALL exit 0 when the session ends after a save or with no unsaved changes, exit 0 with a stderr warning naming the recipe when the session ends with unsaved changes, and exit 1 on error (invalid URL template, invalid recipe under `--edit`, display or browser failure). Ctrl+C SHALL end the session cleanly, releasing the profile lock.

#### Scenario: Close after save
- **WHEN** the user saves and closes the window
- **THEN** the exit code is 0 and stderr reports the saved recipe path

#### Scenario: Invalid template
- **WHEN** the template is `http://host/{`
- **THEN** stderr reports the template error and the exit code is 1

### Requirement: Healing flags on `run`
`webscoop run` SHALL accept `--no-heal` (try only the first candidate per target, never promote), `--no-save` (heal but never write the recipe back), and `--interactive` (open the recorder's re-pick mode when a required target cannot be healed, instead of failing). `--interactive` SHALL require a display like every browser command and SHALL wait for the user without a timeout.

#### Scenario: Default heals and saves
- **WHEN** `webscoop run shop` heals a field on a successful run
- **THEN** the recipe file in the recipes directory is updated

#### Scenario: No-save keeps the file
- **WHEN** `webscoop run shop --no-save` heals a field
- **THEN** rows are emitted and the recipe file is unchanged

#### Scenario: Interactive re-pick
- **WHEN** `webscoop run shop --interactive` cannot heal `price`
- **THEN** the browser shows the re-pick panel for `price` and the run continues after the user picks

### Requirement: `test` command
`webscoop test <recipe> [--var name=value]... [--profile <name>] [--timeout <ms>] [--json]` SHALL run the recipe on its first page with healing enabled and write-back disabled, print a per-field table to stdout with name, status, matches, and the selector or rung used, and exit 0 when every required field resolved on at least one row, 3 when a required field is unresolved, 1 on error. With `--json` the table SHALL be a JSON array. No rows SHALL be printed.

#### Scenario: Healthy recipe
- **WHEN** `webscoop test playground-catalog` runs against tier 0
- **THEN** every field shows `ok` and the exit code is 0

#### Scenario: Broken field
- **WHEN** a required field cannot be resolved by any rung
- **THEN** its row shows `missing` and the exit code is 3

### Requirement: Re-pick from the command line
`webscoop record --edit <recipe> --repick <field>` SHALL open the recipe's page in the recorder's re-pick mode focused on that field, save the new selection into the recipe on confirmation, and exit 0. `<field>` SHALL be either `table.field` or a bare field name; a bare name SHALL be accepted when exactly one table has a field by that name. An unknown field, an unknown table, or an ambiguous bare name SHALL exit 1 naming it and, for an ambiguous name, the tables that have it.

#### Scenario: Re-pick a field
- **WHEN** `webscoop record --edit shop --repick price` is executed and the user picks the new price element
- **THEN** the recipe's `price` selectors and fingerprint are replaced and the exit code is 0

#### Scenario: Re-pick by table
- **WHEN** `webscoop record --edit results --repick questions.title` is executed and the user confirms a pick
- **THEN** only the `title` field of table `questions` is replaced

#### Scenario: Ambiguous bare name
- **WHEN** `webscoop record --edit results --repick title` is executed and both `page` and `products` have `title`
- **THEN** stderr names `title`, `page`, and `products`, and the exit code is 1

### Requirement: `--no-llm` flag
`webscoop run` and `webscoop test` SHALL accept `--no-llm`, which disables the model rung for that invocation regardless of config and recipe.

#### Scenario: Flag disables model
- **WHEN** `webscoop run shop --no-llm` reaches the model rung
- **THEN** no request is sent to the endpoint

### Requirement: `bench` command
`webscoop bench <recipe> [--tiers <range>] [--seed <n>] [--json]` SHALL run the recipe once per playground tier in the range (default `0-4`) against a playground it starts itself, with write-back disabled, and print a table with one row per tier and field showing the rung that resolved the field (`candidate`, `fuzzy`, `model`, `unresolved`) and the elapsed time per tier. The recipe's `port` variable SHALL be filled with the started playground's port. The command SHALL exit 0 regardless of heal outcomes and 1 on error.

#### Scenario: Bench across tiers
- **WHEN** `webscoop bench playground-catalog --tiers 0-3` is executed with a working model
- **THEN** the table shows `candidate` for every field on tier 0 and at least one `model` on tier 3

### Requirement: Pagination flags
`webscoop run` and `webscoop test` SHALL accept `--pages <1|N|all>` overriding the recipe limit, `--max-pages <N>` (default 500) capping `all`, and `--delay <ms>` overriding `pagination.delayMs`. `test` SHALL default to one page regardless of the recipe limit; `run` SHALL default to the recipe limit. Invalid values SHALL exit 1 naming the flag.

#### Scenario: Override to all
- **WHEN** the recipe limit is 1 and `--pages all` is passed
- **THEN** the run walks pages until a stop rule fires or the cap is hit

#### Scenario: Test stays on one page
- **WHEN** `webscoop test shop` runs a recipe with limit `all`
- **THEN** only the first page is extracted

#### Scenario: Invalid pages value
- **WHEN** `--pages many` is passed
- **THEN** stderr names `--pages` and the exit code is 1

### Requirement: Page variable from the command line
For a `url` kind recipe, a `--var` for the page parameter SHALL set the starting page for that run.

#### Scenario: Start at page 3
- **WHEN** the page parameter is `n` and `--var n=3 --pages 2` are passed
- **THEN** pages 3 and 4 are extracted

### Requirement: Guard flags
`webscoop run` and `webscoop test` SHALL accept `--guard-timeout <ms>` (default 600000) and `--no-guards`. `test` SHALL default to a guard timeout of 0 unless `--guard-timeout` is given, so a wall makes `test` exit 2 promptly.

#### Scenario: Cron-friendly timeout
- **WHEN** `webscoop run shop --guard-timeout 300000` hits a login wall nobody clears
- **THEN** the process exits 2 after five minutes

#### Scenario: Test hits a wall
- **WHEN** `webscoop test shop` hits a captcha wall
- **THEN** the process exits 2 without waiting

### Requirement: Desktop notification
When a guard is raised, the CLI SHALL send a desktop notification through `notify-send` when it is on the PATH, with critical urgency, the recipe name, the guard kind, and the page number. When `notify-send` is absent, the CLI SHALL log the same text to stderr and continue. `--no-notify` SHALL suppress notifications.

#### Scenario: notify-send absent
- **WHEN** `notify-send` is not installed and a guard is raised
- **THEN** stderr carries the notification text and the run keeps waiting

### Requirement: Exit 2 semantics
Exit code 2 SHALL be used only when a run was paused on a guard and the guard timeout elapsed. The stderr message SHALL name the guard kind, the page, and the URL. Rows emitted before the guard SHALL remain on stdout in JSONL mode; in JSON array mode the array SHALL contain the rows of completed pages.

#### Scenario: Partial JSON array on timeout
- **WHEN** pages 1 and 2 completed and page 3 timed out on a guard in JSON array mode
- **THEN** stdout holds an array with the rows of pages 1 and 2 and the exit code is 2

### Requirement: Steps flags and test behavior
`webscoop run` and `webscoop test` SHALL accept `--skip-steps`, which replays no steps. `webscoop test` SHALL replay steps by default so its result matches a run. The stderr log SHALL print one line per replayed or skipped step with its index, kind, and outcome.

#### Scenario: Test replays steps
- **WHEN** `webscoop test shop` runs a recipe with a required click step behind a cookie gate
- **THEN** the step is replayed and every field resolves

#### Scenario: Skip steps
- **WHEN** `webscoop run shop --skip-steps` runs the same recipe
- **THEN** no step is replayed and the run reports the fields as missing behind the gate

### Requirement: Window flags and config
`webscoop run` and `webscoop test` SHALL accept `--show` (never hide) and `--hide` (hide even when config disables it, if a provider detects). The config file MAY declare `window.provider` (`auto` default, `hyprland`, `none`, or a user provider name) and `window.providers`. `record` SHALL never hide.

#### Scenario: Config disables hiding
- **WHEN** `window.provider` is `none` and `webscoop run shop` starts on Hyprland
- **THEN** the window stays visible

#### Scenario: Force hide
- **WHEN** `window.provider` is `none` and `--hide` is passed on Hyprland
- **THEN** the window is hidden

### Requirement: `export` command
`webscoop export <recipe> [--format ts|py] [--out <path>] [--headless]` SHALL load the recipe by name or path, validate it, render the script for the format (default `ts`), and write it to `--out` or print it to stdout. `--headless` SHALL make the generated script default to headless. Invalid recipes SHALL exit 1 with the validation errors. Recipes with any number of tables SHALL be accepted. The command SHALL NOT open a browser and SHALL NOT require a display.

#### Scenario: Export to stdout
- **WHEN** `webscoop export playground-catalog` is executed
- **THEN** stdout holds a TypeScript script whose header names `playground-catalog` and the exit code is 0

#### Scenario: Export Python to a file
- **WHEN** `webscoop export playground-catalog --format py --out scrape.py` is executed
- **THEN** `scrape.py` exists, starts with the header comment, and stdout is empty

#### Scenario: No display needed
- **WHEN** `webscoop export playground-catalog` runs without `WAYLAND_DISPLAY` or `DISPLAY`
- **THEN** it succeeds

#### Scenario: Export a multi-table recipe
- **WHEN** `webscoop export results` is executed and `results` declares two tables
- **THEN** stdout holds a script that declares both tables and the exit code is 0
