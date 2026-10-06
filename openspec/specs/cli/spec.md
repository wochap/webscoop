# cli Specification

## Purpose

Defines the `webscoop` command line interface: the commands users and cron jobs invoke, where files live, what goes to stdout and stderr, and what exit codes mean. The CLI is the product surface; every other capability is reached through it.

## Requirements

### Requirement: One process per invocation
The CLI SHALL perform one command per invocation and exit when it completes. `run` and `test` SHALL execute in the browser daemon, which MAY keep running, with its browsers, after the command exits, as defined by the browser-daemon capability. Every other command SHALL NOT leave a daemon, server, or browser process running after exit.

#### Scenario: Process exits after run
- **WHEN** `webscoop run <recipe>` completes
- **THEN** the command's process exits, and any Chromium process left running belongs to the daemon

#### Scenario: Export leaves nothing behind
- **WHEN** `webscoop export shop` completes
- **THEN** no process started by it remains

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
`webscoop recipes` SHALL list the recipes in the recipes directory with name, field count, last modified time, URL template, and description. The DESCRIPTION column SHALL show the first line of the recipe description cut to 60 characters with an ellipsis when cut, and SHALL be empty for a recipe without one.

With `--json` it SHALL print a JSON array with one object per recipe holding `name`, `url`, `fields` (the field count), `modified`, `path`, and:
- `description`: the full recipe description, or absent;
- `vars`: one object per declared variable with `name`, and `default` and `description` when declared;
- `tables`: one object per table in recipe order with `name`, `description` when declared, and `fields`, a list of objects with each field's `name` and `type`. A recipe in the shorthand form SHALL list one table named `items`.

#### Scenario: Empty recipes directory
- **WHEN** no recipes exist
- **THEN** the command prints nothing to stdout and exits 0

#### Scenario: Catalog for an AI harness
- **WHEN** the recipe `bing-search` has description "Bing web search results for a query", a variable `query` described "search terms", and a table `results` with fields `title` (text) and `link` (url), and `webscoop recipes --json` is run
- **THEN** the entry for `bing-search` holds that description, `vars` `[{ "name": "query", "description": "search terms" }]`, and `tables` `[{ "name": "results", "fields": [{ "name": "title", "type": "text" }, { "name": "link", "type": "url" }] }]`

#### Scenario: Text listing shows the first line
- **WHEN** a recipe description is "Google results\nOne row per organic result" and `webscoop recipes` is run
- **THEN** the recipe's DESCRIPTION column reads `Google results`

### Requirement: `doctor` command
`webscoop doctor` SHALL report the resolved config, recipes, and profiles paths, whether a display is available, whether the Chromium build Playwright expects is installed, the configured LLM endpoint if any, and the configured hooks as one line per event with its number of commands (or a line saying no hooks are configured). When an endpoint and model are configured, it SHALL probe the endpoint: reachable or not, whether the model is listed, the round-trip time of a one-token completion, and a warning when `contextTokens` is below 8192. It SHALL exit 1 when Chromium is missing or no display is available; an unreachable or misconfigured LLM SHALL be reported as a warning and SHALL NOT change the exit code.

#### Scenario: No display
- **WHEN** neither `WAYLAND_DISPLAY` nor `DISPLAY` is set
- **THEN** doctor reports the missing display and exits 1

#### Scenario: Endpoint probe
- **WHEN** an endpoint and model are configured and reachable
- **THEN** doctor prints the model as found and the round-trip time, and exits 0

#### Scenario: Endpoint down
- **WHEN** an endpoint is configured but refuses connections
- **THEN** doctor prints a warning naming the endpoint and still exits 0 when display and Chromium are fine

#### Scenario: Hooks listed
- **WHEN** the config has two commands for `attention.needed` and one for `browser.started`
- **THEN** doctor prints a line for `attention.needed` with 2 commands and a line for `browser.started` with 1 command

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
`webscoop run` and `webscoop test` SHALL accept:
- `--pages <1|N|all>`, overriding the paginate block's limit
- `--max-pages <N>` (default 500), capping `all`
- `--delay <ms>`, overriding the paginate block's `delayMs`

`test` SHALL default to one page regardless of the limit; `run` SHALL default to the limit. Invalid values SHALL exit 1 naming the flag. For a recipe without a paginate block, these flags SHALL have no effect.

#### Scenario: Override to all
- **WHEN** the paginate block's limit is 1 and `--pages all` is passed
- **THEN** the run walks pages until a stop rule fires or the cap is hit

#### Scenario: Test stays on one page
- **WHEN** `webscoop test shop` runs a recipe whose paginate limit is `all`
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
When a guard is raised and notifications are on, the CLI SHALL send a desktop notification through `notify-send` when it is on the PATH, with critical urgency, the recipe name, the guard kind, and the page number. When `notify-send` is absent, the CLI SHALL log the same text to stderr and continue.

Notifications SHALL be on unless turned off. The config file MAY declare `notify`, a boolean defaulting to `true`; `false` turns notifications off. `webscoop run` and `webscoop test` SHALL accept `--notify` and `--no-notify`; a flag given on the command line SHALL override the config key. A run or test served by the daemon SHALL use the setting resolved by the command that submitted it. The setting SHALL NOT change which hooks fire.

#### Scenario: notify-send absent
- **WHEN** `notify-send` is not installed and a guard is raised
- **THEN** stderr carries the notification text and the run keeps waiting

#### Scenario: Turned off in config
- **WHEN** the config sets `notify` to `false` and a guard is raised during `webscoop run shop`
- **THEN** no desktop notification is sent and the `attention.needed` hook still runs

#### Scenario: Flag overrides config
- **WHEN** the config sets `notify` to `false` and the user runs `webscoop run shop --notify` and a guard is raised
- **THEN** one desktop notification is sent

#### Scenario: Flag turns it off
- **WHEN** the config has no `notify` key and the user runs `webscoop test shop --no-notify` and a guard is raised
- **THEN** no desktop notification is sent

### Requirement: Exit 2 semantics
Exit code 2 SHALL be used only when a run was paused on a guard and the guard timeout elapsed. The stderr message SHALL name the guard kind, the page, and the URL. Rows emitted before the guard SHALL remain on stdout in JSONL mode; in JSON array mode the array SHALL contain the rows of completed pages.

#### Scenario: Partial JSON array on timeout
- **WHEN** pages 1 and 2 completed and page 3 timed out on a guard in JSON array mode
- **THEN** stdout holds an array with the rows of pages 1 and 2 and the exit code is 2

### Requirement: Flows flags and test behavior
`webscoop run` and `webscoop test` SHALL accept `--skip-flows`, which runs no flow, called or reactive, and runs the sequence's `extract` and `paginate` blocks only. `webscoop test` SHALL run flows by default so its result matches a run. The stderr log SHALL print one line per flow run with its name and kind, and one line per replayed or skipped step with its flow, index, kind, and outcome.

#### Scenario: Test replays steps
- **WHEN** `webscoop test shop` runs a recipe whose sequence starts with a flow that clicks through a cookie gate
- **THEN** the flow runs and every field resolves

#### Scenario: Skip steps
- **WHEN** `webscoop run shop --skip-flows` runs the same recipe
- **THEN** no flow runs and the run reports the fields as missing behind the gate

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

### Requirement: Warning for encoded variable values
Variable values are URL-encoded when they are substituted into the URL template, unless the variable is declared `raw`. When `record`, `run`, or `test` receives a `--var` value that contains a `+`, or a `%` followed by two hexadecimal digits, and the template uses that variable and the variable is not raw, the command SHALL print one warning line on stderr per such variable and SHALL continue. The warning SHALL name the variable and say that the value is encoded again. For a `+` it SHALL suggest the value with spaces in place of each `+`; for `%XX` escapes it SHALL suggest the decoded value. At `record`, the warning SHALL also say that the variable can be marked raw in the panel. No warning SHALL be printed for variables that only `type` steps use, because step values are typed as is, nor for raw variables, because their values are not encoded. The command line SHALL offer no option to mark a variable raw.

#### Scenario: Plus sign in a URL variable
- **WHEN** `webscoop record 'https://www.google.com/search?q={query}' --var query=top+llms` is executed
- **THEN** stderr warns that `query` is URL-encoded so `+` stays a literal plus, suggests `top llms` or marking `query` raw in the panel, and the session starts

#### Scenario: Percent escape in a URL variable
- **WHEN** `webscoop run shop --var category=red%20shoes` is executed and the template uses `{category}`
- **THEN** stderr warns that `category` would be encoded again, suggests `red shoes`, and the run continues

#### Scenario: Step-only variable is not flagged
- **WHEN** `--var login_email=a+b@acme.dev` is passed and only a `type` step uses `{login_email}`
- **THEN** no warning is printed

#### Scenario: Reserved variable is not flagged
- **WHEN** `webscoop run search --var 'q=a+sentence+with+plus'` is executed and the recipe declares `q` with `raw: true` and uses it as `{q}`
- **THEN** no warning is printed and the run opens the URL with `q=a+sentence+with+plus`

### Requirement: Quiet runs print only errors and prompts
`webscoop run` SHALL accept `--quiet` and its short form `-q`. With it, the run SHALL print on stderr only:
- errors: a failed run, a run that paused and gave up, CLI and config errors, and the line reporting an interrupted run
- lines that ask the user to act in the browser window: a raised guard waiting for the user, the guard banner hint, an interactive re-pick request, and the desktop notification text when `notify-send` is absent

Every other stderr line SHALL NOT be printed. That covers informational lines (the run start, page loads, replayed or skipped steps, healed or resolved fields, pagination progress, recipe write-back, language model messages, the final summary). It also covers every warning (dropped-row warnings, encoded `--var` warnings, profile warnings, fields reported as partial or fallback), guard cleared and guard timed-out lines, and re-pick outcome lines. Stdout content, `--out` files, and exit codes SHALL be the same as without `--quiet`. `--report` SHALL still print the run report when given together with `--quiet`. `webscoop test` and `webscoop record` SHALL NOT accept `--quiet`.

#### Scenario: Only data on a clean run
- **WHEN** `webscoop run shop --quiet` succeeds with every field resolved and no warnings
- **THEN** stdout carries the JSON array and stderr is empty

#### Scenario: Short form
- **WHEN** `webscoop run shop -q` is executed
- **THEN** it behaves exactly like `--quiet`

#### Scenario: Errors still print
- **WHEN** `webscoop run shop --quiet` fails because a required field resolves nowhere
- **THEN** stderr names the failure and the exit code is 3

#### Scenario: Warnings muted
- **WHEN** `webscoop run shop --quiet` drops rows that miss a required field
- **THEN** stderr is empty, stdout carries the kept rows, and the exit code is 0

#### Scenario: Partial fields muted
- **WHEN** `webscoop run shop --quiet` resolves a field on only some rows
- **THEN** stderr carries no `field ...: partial` line

#### Scenario: Guard prompt still prints
- **WHEN** `webscoop run shop --quiet` meets a login wall on page 1
- **THEN** stderr carries the line that names the guard and says the run waits for the user in the browser window

#### Scenario: Report still prints
- **WHEN** `webscoop run shop --quiet --report` is executed
- **THEN** stderr carries the run report and no informational or warning lines

### Requirement: `edit` command
`webscoop edit <recipe> [--repick <field>] [--var name=value]... [--profile <name>] [--timeout <ms>] [--lock-timeout <ms>]` SHALL behave exactly like `webscoop record --edit <recipe>` with the same options: it SHALL open the recipe, by name or path, in a recording session, and with `--repick` it SHALL follow the re-pick behavior of `record --edit --repick`. Exit codes and stderr messages SHALL match `record --edit`. A missing `<recipe>` argument SHALL exit 1. `webscoop record --edit` SHALL keep working unchanged.

#### Scenario: Edit by name
- **WHEN** `webscoop edit playground-catalog` is executed
- **THEN** the session opens the recipe's URL with its fields loaded, as with `webscoop record --edit playground-catalog`

#### Scenario: Re-pick through edit
- **WHEN** `webscoop edit shop --repick price` is executed and the user picks the new price element
- **THEN** the recipe's `price` selectors and fingerprint are replaced and the exit code is 0

#### Scenario: Invalid recipe
- **WHEN** `webscoop edit ./broken.json` is executed and the file is not a valid recipe
- **THEN** stderr reports the recipe error and the exit code is 1

#### Scenario: Help lists the command
- **WHEN** `webscoop --help` is executed
- **THEN** the command list includes `edit` with a description that says it edits an existing recipe

### Requirement: Proxy flags
`webscoop run`, `webscoop test`, `webscoop record` (including `record --edit` and `edit`), and `webscoop bench` SHALL accept `--proxy <url>` and `--no-proxy`, with the meaning defined in the `browser-launch` capability. Passing both SHALL exit 1. The start line of a run SHALL name the proxy in use with its credentials masked, or say that none is used.

#### Scenario: Proxy on the command line
- **WHEN** `webscoop run shop --proxy http://u:p@127.0.0.1:3128` is executed
- **THEN** the browser uses that proxy and stderr names `http://***@127.0.0.1:3128`

#### Scenario: Conflicting flags
- **WHEN** `webscoop run shop --proxy http://127.0.0.1:3128 --no-proxy` is executed
- **THEN** stderr reports the conflict and the exit code is 1

### Requirement: Doctor reports the browser setup
`webscoop doctor` SHALL report:
- the configured driver
- the channel
- the resolved browser binary with its version, or that it is missing
- whether the `patchright` package is installed when the driver is `patchright`
- the configured proxy with credentials masked
- the configured timezone and locale
- each profile directory with the driver, channel, and version from its marker, or "unknown" when there is no marker
- `profiles.default` when set, and each rule in `profiles.rules` with its number, its patterns, and its profile
- for each valid recipe in the recipes directory, the profile it resolves to without `--profile` and the source, as named in "Profile resolution"

To resolve a recipe's host, doctor SHALL fill the URL with the declared variable defaults. When a variable in the host has no default, doctor SHALL treat `host` rules as not matching for that recipe and SHALL say that the host needs variables. A recipe that fails to load SHALL be reported as invalid and SHALL NOT change the exit code.

A missing browser binary or a missing `patchright` package for the configured driver SHALL make doctor exit 1, like a missing Chromium does today.

#### Scenario: Patchright configured and missing
- **WHEN** `browser.driver` is `patchright` and the `patchright` package cannot be loaded
- **THEN** doctor reports it missing and exits 1

#### Scenario: Profiles listed with their browser
- **WHEN** profiles `shop` (Chromium) and `shop@chrome` (Chrome) exist with markers
- **THEN** doctor lists both with their driver, channel, and version

#### Scenario: Recipe resolution listed
- **WHEN** a rule maps host `acme\\.com$` to `acme` and recipes `acme-list` (URL on `acme.com`) and `other` (no match, no default) exist
- **THEN** doctor lists `acme-list` with profile `acme` from `config rule 1`, and `other` with profile `other` from `recipe name`

#### Scenario: Host needs variables
- **WHEN** recipe `list` has URL `https://{site}/list` and `site` has no default
- **THEN** doctor lists `list` with the profile resolved without host rules and says the host needs variables

### Requirement: Humanize flags
`webscoop run`, `webscoop test`, and `webscoop bench` SHALL accept `--humanize` and `--no-humanize`, with the meaning defined in "Humanized input" of the `browser-launch` capability. Passing both SHALL exit 1. The config file MAY declare `browser.humanize` as a boolean. When humanized input is on, the start line of a run SHALL say so. `webscoop record` and `webscoop edit` SHALL NOT accept these flags.

#### Scenario: Turn on from the command line
- **WHEN** `webscoop run shop --humanize` is executed for a recipe without `browser.humanize`
- **THEN** the run uses humanized input and its start line says so

#### Scenario: Conflicting flags
- **WHEN** `webscoop run shop --humanize --no-humanize` is executed
- **THEN** stderr reports the conflict and the exit code is 1

### Requirement: Profile rules in config
The config file MAY declare a `profiles` block with these optional keys:
- `default`: a profile name
- `rules`: an ordered list of entries, each with an optional `host` regular expression, an optional `name` regular expression, and a required `profile` name

Each rule SHALL have at least one of `host` and `name`. A rule matches when every key it declares matches. `host` SHALL be tested against the host name (without port) of the recipe's URL, filled with the command's variable values. `name` SHALL be tested against the recipe name. Patterns SHALL be unanchored; a pattern matches when it matches any part of the value.

The config SHALL fail to load, with exit 1 and a message naming the JSON path, when a pattern is not a valid regular expression, when a rule has neither `host` nor `name`, or when `default` or a rule's `profile` is not a valid profile name. A valid profile name starts with a letter or digit, followed by letters, digits, `.`, `_`, or `-`.

#### Scenario: Host rule matches
- **WHEN** the config has the rule `{ "host": "(^|\\.)acme\\.com$", "profile": "acme" }` and `webscoop run shop` is executed for a recipe whose URL is `https://www.acme.com/catalog`
- **THEN** the run uses profile `acme`

#### Scenario: Both keys must match
- **WHEN** a rule declares `host` `acme\\.com$` and `name` `^admin-`, and the recipe `shop` has URL `https://acme.com/`
- **THEN** the rule does not match

#### Scenario: Invalid pattern
- **WHEN** the config has a rule with `host` `acme(`
- **THEN** every command exits 1 and stderr names `$.profiles.rules.0.host`

#### Scenario: Empty rule
- **WHEN** the config has the rule `{ "profile": "acme" }`
- **THEN** every command exits 1 and stderr names `$.profiles.rules.0`

### Requirement: Profile resolution
`webscoop run`, `webscoop test`, `webscoop record` (including `record --edit` and `edit`), and `webscoop bench` SHALL resolve the profile name in this order, taking the first that applies:
1. `--profile <name>`
2. the recipe's `browser.profile`
3. the first rule in `profiles.rules`, in list order, that matches the recipe
4. `profiles.default`
5. the recipe name

For a new recording, the recipe name SHALL be the `--name` value or the name proposed from the URL, and the host SHALL come from the URL filled with the session's variable values. The resolved name SHALL select the profile directory as defined in "Profile per browser" of the `browser-launch` capability. The start line of each of these commands SHALL name the profile and its source: `flag`, `recipe`, `config rule <n>` (1-based), `config default`, or `recipe name`.

#### Scenario: No profile config keeps today's behavior
- **WHEN** the config has no `profiles` block and the recipe `shop` has no `browser.profile`
- **THEN** `webscoop run shop` uses profile `shop` and the start line says the source is `recipe name`

#### Scenario: Config default
- **WHEN** the config sets `profiles.default` to `main` and no rule matches recipe `shop`
- **THEN** `webscoop run shop` uses profile `main`

#### Scenario: First matching rule wins
- **WHEN** the rules are `[{ "name": "^acme-admin-", "profile": "acme-admin" }, { "host": "acme\\.com$", "profile": "acme" }]` and recipe `acme-admin-orders` has a URL on `acme.com`
- **THEN** the run uses profile `acme-admin` and the start line says `config rule 1`

#### Scenario: Recipe pin outranks rules
- **WHEN** recipe `shop` declares `browser.profile` `personal` and a config rule matches `shop` with profile `acme`
- **THEN** `webscoop run shop` uses profile `personal`

#### Scenario: Flag outranks everything
- **WHEN** recipe `shop` declares `browser.profile` `personal` and `webscoop run shop --profile scratch` is executed
- **THEN** the run uses profile `scratch` and the start line says the source is `flag`

#### Scenario: Host from variables
- **WHEN** a recipe URL is `https://{site}/list`, a rule matches host `acme\\.com$`, and `webscoop run list --var site=shop.acme.com` is executed
- **THEN** the run uses the rule's profile

### Requirement: Recording pins the profile it used
When `webscoop record` or `webscoop edit` saves a recipe, the CLI SHALL resolve the profile that the saved recipe would get without a `browser.profile` pin and without `--profile`, using the saved name and URL. When that profile differs from the profile the session used, the saved recipe SHALL declare `browser.profile` as the profile the session used. When they are equal, the saved recipe SHALL NOT declare `browser.profile`, and an empty `browser` block SHALL be dropped. As a result, a later `webscoop run` without `--profile` uses the profile the session used.

#### Scenario: Rename during recording keeps the login
- **WHEN** `webscoop record https://example.com/catalog` starts on profile `example-com-catalog` with no profile config, and the user saves the recipe as `shop`
- **THEN** the saved recipe declares `browser.profile` `example-com-catalog`, and `webscoop run shop` uses that profile

#### Scenario: Recipe that follows the config stays unpinned
- **WHEN** a rule maps host `acme\\.com$` to `acme`, `webscoop record https://acme.com/list` starts on profile `acme`, and the user saves the recipe as `acme-list`
- **THEN** the saved recipe has no `browser.profile`

#### Scenario: Recording with an explicit profile
- **WHEN** `webscoop record https://acme.com/list --profile second-account` is executed, a rule maps `acme.com` to `acme`, and the user saves
- **THEN** the saved recipe declares `browser.profile` `second-account`

#### Scenario: Edit keeps an existing pin
- **WHEN** recipe `shop` declares `browser.profile` `personal` and `webscoop edit shop` saves a change
- **THEN** the saved recipe still declares `browser.profile` `personal`

### Requirement: Zsh completion
The CLI package SHALL ship a zsh completion function named `_webscoop`. It SHALL complete:
- the subcommands, each with a short description
- every option of each subcommand, including negated forms such as `--no-heal`
- fixed option values: `ts` and `py` for `--format`; `1` and `all` for `--pages`
- `show` and `hide` for the `browser` subcommand
- recipe names for the `<recipe>` argument of `run`, `test`, `edit`, `export`, and `bench`, and for `record --edit`, alongside ordinary file paths
- profile names for `--profile`

Recipe names SHALL be the `.json` files in the recipes directory without the extension. Profile names SHALL be the directory names in the profiles directory with any `@<browser>` suffix removed, without duplicates. Both directories SHALL be resolved as the CLI resolves them: `$WEBSCOOP_HOME/{recipes,profiles}` when `WEBSCOOP_HOME` is set, otherwise `${XDG_DATA_HOME:-~/.local/share}/webscoop/{recipes,profiles}`. Completion SHALL NOT start the `webscoop` program or Node. A missing directory SHALL yield no candidates, not an error.

#### Scenario: Subcommands
- **WHEN** the user types `webscoop ` and presses TAB
- **THEN** `run`, `test`, `record`, `edit`, `recipes`, `export`, `bench`, `browser`, and `doctor` are offered with descriptions

#### Scenario: Flags of a subcommand
- **WHEN** the user types `webscoop run shop --` and presses TAB
- **THEN** every option of `run` is offered, including `--no-heal` and `--humanize`, and `--show` and `--hide` are not offered

#### Scenario: Recipe names
- **WHEN** the recipes directory holds `shop.json` and `news.json` and the user types `webscoop run ` and presses TAB
- **THEN** `shop` and `news` are offered

#### Scenario: Profile names
- **WHEN** the profiles directory holds `work@chromium`, `work@chrome`, and `default`, and the user types `webscoop run shop --profile ` and presses TAB
- **THEN** `work` and `default` are offered, each once

#### Scenario: WEBSCOOP_HOME
- **WHEN** `WEBSCOOP_HOME` is set and the user completes a recipe name
- **THEN** names come from `$WEBSCOOP_HOME/recipes`

#### Scenario: Completion stays in sync with the CLI
- **WHEN** a subcommand or option is added to the CLI but not to the completion function
- **THEN** the test suite fails and names the missing command or option

#### Scenario: Installed with the Nix package
- **WHEN** the Nix package is built
- **THEN** `_webscoop` is installed under `share/zsh/site-functions`

### Requirement: Extra browser arguments
The config file MAY declare `browser.args`, a list of strings passed as extra Chromium command line arguments to every browser that `run`, `test`, `record`, `edit`, and `bench` launch. With no `browser.args`, no extra arguments SHALL be passed.

#### Scenario: Window class for a window manager rule
- **WHEN** the config has `"browser": { "args": ["--class=webscoop"] }` and `webscoop run shop` starts
- **THEN** the Chromium main process command line contains `--class=webscoop`

### Requirement: Leftover window config
A config file that declares a `window` block SHALL load, with one stderr warning per command saying that `window` is no longer supported and pointing to `hooks`. The block SHALL be ignored.

#### Scenario: Old config still loads
- **WHEN** the config declares `"window": { "provider": "hyprland" }` and `webscoop run shop` starts
- **THEN** stderr has the warning, no window is hidden, and the run proceeds

### Requirement: Download directory
`run`, `test`, and `record` SHALL accept `--download-dir <path>`. The download directory SHALL be the first of: `--download-dir`, config `downloads.dir`, `~/Downloads/webscoop`. A leading `~/` SHALL be the home directory. A relative `--download-dir` SHALL resolve against the working directory of the command; a relative `downloads.dir` SHALL resolve against the config file's directory. The directory SHALL be created when the first file is saved. Jobs run by the daemon SHALL use the directory resolved by the submitting command.

#### Scenario: Flag wins over config
- **WHEN** config sets `downloads.dir` to `~/files` and `webscoop run gslides --download-dir ./out` runs in `/tmp/w`
- **THEN** files are saved in `/tmp/w/out`

#### Scenario: Default directory
- **WHEN** no flag or config sets the directory
- **THEN** files are saved in `~/Downloads/webscoop`

### Requirement: Downloads table output
A recipe with at least one `download` step SHALL have an output table `downloads`, after the recipe's tables. Each file a `download` step saved SHALL be one row with `file` (absolute path), `name`, `url` (the download's source URL), `bytes`, `_page`, and `_index`, emitted when the file is saved. Downloads that no `download` step took SHALL NOT be rows. The table SHALL follow the output stream and row shape rules like any other table: a recipe with no other tables SHALL print a JSON array of download rows, and `--table downloads` SHALL select it.

#### Scenario: Download-only recipe
- **WHEN** `webscoop run gslides --var id=1Qi | jq -r '.[0].file'` runs and the recipe has no tables and one `download` step
- **THEN** jq prints the absolute path of the saved PDF

#### Scenario: Recipe with a table and a download
- **WHEN** a recipe has a table `page` and a `download` step
- **THEN** stdout is one JSON object with keys `page` and `downloads`
