# code-export Specification

## Purpose

Defines the standalone script produced from a recipe: which recipe behavior it reproduces, how it maps to plain Playwright, its command line, and the limits it declares. The export lets a recipe live outside webscoop with predictable, reduced behavior.

## Requirements

### Requirement: Targets and invocation
The export SHALL produce either a TypeScript script for Node using the `playwright` package, runnable with `npx tsx <file>`, or a Python script using the `playwright` sync API, runnable with `python3 <file>`. Both SHALL accept variables as `--var name=value` arguments and as environment variables named `WEBSCOOP_VAR_<NAME>` (uppercased), with arguments taking precedence and recipe defaults as the fallback, and SHALL exit 1 naming any variable without a value. Both SHALL accept `--jsonl`, `--out <path>`, `--pages <1|N|all>`, and `--headless`. Export SHALL accept recipes with one table, in either the shorthand or the `tables` form, and SHALL refuse recipes with more than one table with exit 1 until export supports them.

#### Scenario: Variable from the environment
- **WHEN** the exported script runs with `WEBSCOOP_VAR_CATEGORY=shoes` and no `--var`
- **THEN** the template variable `category` is `shoes`

#### Scenario: Missing variable
- **WHEN** a variable has no argument, environment value, or default
- **THEN** the script exits 1 and names the variable

#### Scenario: Single table in tables form
- **WHEN** a recipe declares `tables` with one entry
- **THEN** export renders the same script it renders for the shorthand form

### Requirement: Header and declared limits
The script SHALL start with a comment naming the recipe, the export timestamp, the webscoop version, and a fixed list of behaviors it does not include: fingerprint healing, model healing, guards, notifications, window hiding, recipe write-back. It SHALL advise re-exporting after re-recording rather than editing selectors in place.

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
The script SHALL replay steps by kind and `when` as the runner does, skipping optional steps whose target is absent and exiting 3 for required ones; SHALL resolve the list parent from `item.within` when present and the item container inside it, drop excluded containers, read item scoped fields within each container and page scoped fields once; SHALL read attributes, inner HTML, or text per field type and attribute; SHALL convert values with the same rules as the CLI (`number`, `url`, `image`, `date`, `html`, `text`); and SHALL emit rows with `_page` and `_index`. The script SHALL resolve `class` candidates as CSS selectors.

#### Scenario: Rows equal the runner
- **WHEN** the reference catalog recipe is exported and run against playground tier 0
- **THEN** the script's rows equal `webscoop run` rows on every field including `_page` and `_index`

#### Scenario: Within honoured
- **WHEN** a recipe with `item.within` is exported and run against a page with a sidebar list
- **THEN** the script's rows equal `webscoop run` rows and exclude the sidebar

#### Scenario: Required step absent
- **WHEN** a required click step finds no target
- **THEN** the script exits 3 naming the step

### Requirement: Pagination parity
The script SHALL implement the recipe's pagination kind (`url`, `next`, `more`, `scroll`), the limit with `--pages` override and a 500 page cap on `all`, disabled and missing target detection, dedup by key or by all values, and the stop rules `no-new-items`, `first-item-repeats`, plus the loop guard and zero-row stop.

#### Scenario: Paged recipe parity
- **WHEN** the paged reference recipe is exported and run with `--pages all` against the playground
- **THEN** the script emits 24 rows across 3 pages equal to `webscoop run --pages all`

### Requirement: Missing field policy
The script SHALL apply the runner's missing field policy: a required field missing on every row exits 3 with no rows, a row on which a required field is missing is dropped with a warning on stderr naming the field and the container index, a first page with no rows left after dropping exits 3, and optional fields yield `null`.

#### Scenario: Required field missing everywhere
- **WHEN** no container resolves the `price` field
- **THEN** the script prints nothing to stdout and exits 3

#### Scenario: Required field missing on some rows
- **WHEN** 2 of 24 containers lack the required `url` field
- **THEN** the script prints 22 rows, none with a `null` `url`, and exits 0

### Requirement: Output contract
Rows SHALL go to stdout as a JSON array, or one JSON object per line with `--jsonl`, or to the `--out` file; logs to stderr; exit codes 0, 1, and 3 with the CLI's meanings.

#### Scenario: JSONL output
- **WHEN** the script runs with `--jsonl`
- **THEN** stdout carries one JSON object per row and nothing else
