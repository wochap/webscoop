# code-export Specification

## Purpose

Defines the standalone script produced from a recipe: which recipe behavior it reproduces, how it maps to plain Playwright, its command line, and the limits it declares. The export lets a recipe live outside webscoop with predictable, reduced behavior.

## Requirements

### Requirement: Targets and invocation
The export SHALL produce either a TypeScript script for Node using the `playwright` package, runnable with `npx tsx <file>`, or a Python script using the `playwright` sync API, runnable with `python3 <file>`. Both SHALL take variables from these sources, the first that gives a value winning:
1. the arguments `--var name=value`, `--var-file name=PATH`, or `--var-command name=CMD` (trimmed standard output of `/bin/sh -c CMD`)
2. the environment variable `WEBSCOOP_VAR_<NAME>` (uppercased)
3. the recipe default

Both SHALL exit 1 naming any variable without a value. Secret variables follow the variables capability: the script SHALL NOT print their values. Path variables SHALL be split on `:` and checked for readability before use. Both SHALL accept `--jsonl`, `--out <path>`, `--table <name>`, `--pages <1|N|all>`, `--await-timeout <ms>`, and `--headless`. Export SHALL accept every valid recipe, with any number of tables, in either the shorthand or the `tables` form.

#### Scenario: Variable from the environment
- **WHEN** the exported script runs with `WEBSCOOP_VAR_CATEGORY=shoes` and no `--var`
- **THEN** the template variable `category` is `shoes`

#### Scenario: Missing variable
- **WHEN** a variable has no argument, environment value, or default
- **THEN** the script exits 1 and names the variable

#### Scenario: Single table in tables form
- **WHEN** a recipe declares `tables` with one entry
- **THEN** export renders the same script it renders for the shorthand form

#### Scenario: Unknown table flag
- **WHEN** the exported script runs with `--table ads` and the recipe has no such table
- **THEN** the script exits 1 naming `ads` and the declared tables

#### Scenario: Secret from a command
- **WHEN** the script runs with `--var-command pass='pass show sunat/sol'` and a later step fails
- **THEN** the step runs with the command's output, and stderr names the step without the value

### Requirement: Header and declared limits
The script SHALL start with a comment naming the recipe, the export timestamp, the webscoop version, and a fixed list of behaviors it does not include: fingerprint healing, model healing, guards, notifications, hooks, recipe write-back. It SHALL advise re-exporting after re-recording rather than editing selectors in place.

#### Scenario: Header present
- **WHEN** a recipe is exported
- **THEN** the first lines of the file name the recipe and list the six excluded behaviors

### Requirement: Browser session
The script SHALL launch Chromium headed by default and headless with `--headless`, with the same automation-hiding arguments the runner uses, a persistent profile directory given by `--profile <dir>` or a temporary directory otherwise, and SHALL wait for load and network idle after each navigation with a 30 second timeout.

#### Scenario: Headless flag
- **WHEN** the script runs with `--headless`
- **THEN** no browser window is shown and the rows are produced

### Requirement: Selector mapping
Each stored selector candidate SHALL map to the same Playwright locator the runner uses: `role` to `getByRole(role, { name })` with the name matched as a whole but ignoring whitespace (or `getByRole(role)` without a name), `testid` to `getByTestId`, `id` to a CSS id locator, `text` to `getByText(value, { exact: true })`, `css` to `locator('css=...')`, `xpath` to `locator('xpath=...')`. For every target the script SHALL try candidates in stored order and use the first with at least one match.

#### Scenario: Second candidate used
- **WHEN** a field's first candidate matches nothing and its second matches
- **THEN** the script extracts with the second candidate

### Requirement: Steps and extraction parity
The script SHALL run the recipe's sequence as the runner does, as defined by the flows capability:
- flow, extract, and paginate blocks in order
- reactive flows checked at the same checkpoints, with `maxRetries`, `flow-loop`, and `recover`
- recovery by reloading the batch URL and replaying earlier flow blocks, and `pagination-lost` exiting 1
- `window` `popup` steps acting in the newest popup opened by an earlier step of the flow
- frame targets resolved before their inner targets
- `fill` acting by element kind as defined by the steps capability

It SHALL:
- skip optional steps whose target is absent, and exit 3 naming the flow and the step for required ones
- for each extracted table, resolve the list parent from `item.within` when present and the item container inside it, drop excluded containers, read item scoped fields within each container and page scoped fields once, and yield one row per extraction for a table without an item block
- read attributes, inner HTML, or text per field type and attribute
- convert values with the same rules as the CLI (`number`, `url`, `image`, `date`, `html`, `text`)
- emit rows with `_page` and `_index` per table
- resolve `class` candidates as CSS selectors

An `await-user` step SHALL print its label and the condition on stderr. It SHALL check the condition at least every second in every open window, and re-check at once when Enter is pressed on a terminal. It SHALL fail with exit 2 when `--await-timeout` (default 600000 milliseconds) runs out.

#### Scenario: Rows equal the runner
- **WHEN** the reference catalog recipe is exported and run against playground tier 0
- **THEN** the script's rows equal `webscoop run` rows on every field including `_page` and `_index`

#### Scenario: Within honoured
- **WHEN** a recipe with `item.within` is exported and run against a page with a sidebar list
- **THEN** the script's rows equal `webscoop run` rows and exclude the sidebar

#### Scenario: Required step absent
- **WHEN** a required click step finds no target
- **THEN** the script exits 3 naming the flow and the step

#### Scenario: Multi-table rows equal the runner
- **WHEN** a recipe with tables `page`, `products`, and `questions` is exported and run against `/catalog?mixed=1`
- **THEN** the script's output equals `webscoop run` output table by table, including `_page` and `_index`

#### Scenario: Framed table parity
- **WHEN** the framed fixture recipe is exported and run against `/framed`
- **THEN** the script's rows equal `webscoop run` rows

#### Scenario: Reactive login and popup parity
- **WHEN** a recipe whose reactive flow clicks "Log in" on `/spa`, fills the popup's inputs from variables, and signs in is exported and run
- **THEN** the script logs in through the popup, and its catalog rows equal `webscoop run` rows

#### Scenario: Await-user times out
- **WHEN** a recipe with an `await-user` step is exported and run with `--await-timeout 0` while the condition does not hold
- **THEN** the script exits 2 after printing the step's label

#### Scenario: Forms parity
- **WHEN** the forms fixture recipe is exported and run against `/forms` with the same variables as `webscoop run`
- **THEN** `/forms/submit` echoes the same values for both

### Requirement: Pagination parity
The script SHALL implement:
- the paginate block's kind (`url`, `next`, `more`, `scroll`)
- the limit, with the `--pages` override and a 500 page cap on `all`
- disabled and missing target detection
- dedup per item table, by its key or by all of its values, with no dedup for tables without an item block
- the stop rules `no-new-items` and `first-item-repeats`, the loop guard, and the zero-container stop, all evaluated on the driving table as the runner does

Item counts for `more` and `scroll` SHALL come from the driving table.

#### Scenario: Paged recipe parity
- **WHEN** the paged reference recipe is exported and run with `--pages all` against the playground
- **THEN** the script emits 24 rows across 3 pages equal to `webscoop run --pages all`

#### Scenario: Page table across pages
- **WHEN** a recipe with tables `page` and `products` both in the paginate block's `do` is exported and run with `--pages 2` on the url paginated catalog
- **THEN** `page` has 2 rows and `products` has the deduplicated rows of both pages, equal to `webscoop run`

### Requirement: Missing field policy
The script SHALL apply the runner's missing field policy per table, where a required field is missing on a row when it resolves no element or its converted value is `null` or an empty string after whitespace collapse: a required field missing on every row of its table exits 3 with no rows, a row on which a required field is missing is dropped with a warning on stderr naming the table, the field, and the container index, a first page where an item table with containers has no rows left exits 3, a non-primary item table with no containers yields no rows and a warning, and optional fields yield `null` when missing or empty.

#### Scenario: Required field missing everywhere
- **WHEN** no container resolves the `price` field
- **THEN** the script prints nothing to stdout and exits 3

#### Scenario: Required field missing on some rows
- **WHEN** 2 of 24 containers lack the required `url` field
- **THEN** the script prints 22 rows, none with a `null` `url`, and exits 0

#### Scenario: Required field empty on some rows
- **WHEN** 1 of 24 containers has a `desc` element holding only whitespace and `desc` is required
- **THEN** the script prints 23 rows, none with an empty `desc`, warns on stderr naming `desc`, and exits 0

#### Scenario: Secondary table absent
- **WHEN** `questions` is not the primary table and matches no container
- **THEN** the script prints the other tables' rows, an empty `questions` array, warns on stderr, and exits 0

### Requirement: Output contract
For a recipe with one table, rows SHALL go to stdout as a JSON array, or one JSON object per line with `--jsonl`. For a recipe with several tables, stdout SHALL be a JSON object keyed by table name in recipe order, each an array of rows, or with `--jsonl` one row per line carrying `_table`. `--table <name>` SHALL restrict the output to that table in the single table shapes. `--out <path>` SHALL write the same content to that file; when `<path>` is an existing directory or ends with a path separator, one file per table named `<table>.json` (or `<table>.jsonl`) SHALL be written into it. Logs go to stderr; exit codes 0, 1, and 3 keep the CLI's meanings.

#### Scenario: JSONL output
- **WHEN** the script runs with `--jsonl`
- **THEN** stdout carries one JSON object per row and nothing else

#### Scenario: Multi-table JSON
- **WHEN** a script for tables `page` and `products` runs without flags
- **THEN** stdout is one JSON object with keys `page` and `products`

#### Scenario: Directory output
- **WHEN** the same script runs with `--out ./data/`
- **THEN** `./data/page.json` and `./data/products.json` exist and stdout is empty

### Requirement: Hover parity in exported scripts
An exported script (TS or Python) SHALL, for a field with `hover: true`, hover the field's resolved element with the browser's real mouse before reading it, on each row for item fields and once for page fields, aiming at the center and then at a point just inside the top-left corner when the center does not receive events. A failed hover SHALL NOT stop the script; the value is read anyway. Fields without the flag SHALL NOT be hovered.

#### Scenario: Exported hover
- **WHEN** a recipe with a `hover` field is exported and the script runs against the hover-reveal playground page
- **THEN** its output carries the real URLs, matching `webscoop run`
