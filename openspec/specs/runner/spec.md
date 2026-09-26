# runner Specification

## Purpose

Defines how a recipe is executed against a live page: browser session, navigation, element resolution, extraction, and the events a run emits. This change covers the static case; healing, pagination, and guards extend these requirements in later changes.

## Requirements

### Requirement: Headed persistent browser session
The runner SHALL open Chromium in headed mode using a persistent profile directory chosen by the recipe's profile name (default: the recipe name). Cookies and storage SHALL survive between runs so a site logged into once stays logged in. The runner SHALL NOT use headless mode.

#### Scenario: Cookie persists across runs
- **WHEN** a run sets a cookie on the playground and a second run uses the same profile
- **THEN** the second run's first request carries that cookie

### Requirement: Profile lock
Two runs SHALL NOT open the same profile concurrently. The runner SHALL take a lock per profile; a second run SHALL wait up to `--lock-timeout` (default 30 seconds) and then exit 1 with a message naming the profile and the holding process id.

#### Scenario: Concurrent runs on one profile
- **WHEN** a second run starts while the first holds the profile lock and does not release it within the timeout
- **THEN** the second run exits 1 and names the profile

### Requirement: URL substitution
The runner SHALL replace every `{name}` in the URL template with the URL-encoded variable value before navigation.

#### Scenario: Value with spaces
- **WHEN** `category` is `running shoes` and the template is `/c/{category}`
- **THEN** the runner navigates to `/c/running%20shoes`

### Requirement: Navigation and readiness
The runner SHALL navigate to the substituted URL and wait until the document is loaded and network activity has settled, bounded by `--timeout` (default 30 seconds). A timeout SHALL fail the run with exit 1.

#### Scenario: Slow page within timeout
- **WHEN** the playground delays its response by 2 seconds
- **THEN** the run completes normally

### Requirement: Candidate resolution order
For the list parent, the item container, and each field, the runner SHALL try selector candidates in listed order and use the first that resolves at least one element. When no candidate resolves and healing is enabled, the runner SHALL continue down the healing ladder defined by the healing capability before treating the target as missing. The candidate or healing rung used SHALL be recorded in the run report. Candidate strategies resolve as follows: `role` by accessible role and whole accessible name compared without whitespace (accessible name implementations differ on spaces between child elements), or by role alone when the value has no name part, `testid` by `data-testid`, `id` by element id, `text` by exact visible text, `css` and `class` by CSS selector, `xpath` by XPath.

#### Scenario: First candidate fails, second succeeds
- **WHEN** a field's first candidate matches nothing and its second matches one element
- **THEN** the field is extracted from the second candidate and the report names it as used

#### Scenario: All candidates fail, fuzzy match succeeds
- **WHEN** no candidate of a field matches and its fingerprint matches a live element above the threshold
- **THEN** the field is extracted from that element and the report records the fuzzy outcome

#### Scenario: Role-only candidate
- **WHEN** the item container's first candidate is `role` `listitem`
- **THEN** every element with role `listitem` inside the list parent is a container

### Requirement: Item scoped extraction
When the recipe has an `item` block, the runner SHALL resolve the list parent from `item.within` when present and resolve containers inside it, else against the document; drop containers matching an `exclude` selector; and resolve each `item` scoped field relative to each remaining container. A field that resolves more than one element within a container SHALL use the first. Page scoped fields SHALL be resolved once against the document and repeated on every row. When `within` is present and resolves nothing, the container SHALL count as unresolved and the run report SHALL name `within` as the missing target.

#### Scenario: Mixed scopes
- **WHEN** a recipe has 24 containers, an item field `title`, and a page field `category`
- **THEN** 24 rows are emitted and each carries the same `category` value

#### Scenario: Containers scoped by within
- **WHEN** `item.within` resolves the product list and `item.selectors` also matches 4 cards in a sidebar
- **THEN** 24 rows are emitted and the sidebar cards are ignored

#### Scenario: Within missing
- **WHEN** no `within` candidate resolves
- **THEN** the run report marks the item container missing and names `within`

### Requirement: Missing fields
A required field that resolves no element for a given row, after the healing ladder has been exhausted for that field, SHALL mark the row's field status `missing` and the row SHALL be dropped: it SHALL NOT be emitted and SHALL NOT count toward the row count. Field resolution and healing SHALL happen on the first page where the field is needed and the resolved selector SHALL be reused on later pages. After the first page is processed, if any required field was missing on every row, or no row is left after dropping, the run SHALL fail with exit 3 and name the fields. On later pages a required field missing on every row SHALL fail the run with exit 3 after emitting the earlier pages; a later page with no row left after dropping SHALL NOT fail the run. When a required field is missing on some rows only, those rows SHALL be dropped, the run SHALL succeed, and a warning on stderr SHALL name the field, the page, and the container indexes dropped. Optional fields SHALL always yield `null` when missing and SHALL still go through the ladder once. A page scoped required field that resolves nothing SHALL count as missing on every row.

#### Scenario: Required field absent everywhere
- **WHEN** `price` is required and no rung of the ladder resolves it
- **THEN** no rows are emitted to stdout and the exit code is 3

#### Scenario: Required field absent on one row
- **WHEN** `price` is required and one of 24 containers lacks it
- **THEN** 23 rows are emitted, none with `price: null`, and a warning names `price` and the container index dropped

#### Scenario: Optional field absent on one row
- **WHEN** `price` is optional and one of 24 containers lacks it
- **THEN** 24 rows are emitted, one with `price: null`, and the exit code is 0

#### Scenario: Every row dropped on the first page
- **WHEN** `url` is required and missing on containers 0 to 11 and `price` is required and missing on containers 12 to 23
- **THEN** no rows are emitted and the exit code is 3 naming `url` and `price`

#### Scenario: Required field vanishes on page 2
- **WHEN** `price` resolves on page 1 and no container on page 2 has it
- **THEN** page 1 rows were emitted, the run fails with exit 3, and stderr names page 2

#### Scenario: Every row dropped on page 2
- **WHEN** page 2 has 8 containers, 4 lack the required `url` and the other 4 lack the required `price`, so no required field is missing on every container
- **THEN** page 2 contributes no rows, the run continues to the stop rules, and the exit code is 0

### Requirement: Run report
The runner SHALL produce a run report available to the CLI with: start and end time, final URL, page count, row count, duplicate count, dropped count, stop reason, per page URL, row count, and dropped count, and per field the candidate used, the healing outcome, a status among `ok`, `healed`, `partial`, `missing`, and the container indexes on which it was missing. The report SHALL state whether the recipe was written back and to which path. The CLI SHALL print a one-line summary to stderr including the page count, the number of healed fields, the number of dropped duplicates, and the number of rows dropped for missing required fields when non-zero, and the full report with `--report`.

#### Scenario: Report after success
- **WHEN** a run extracts 24 rows with all fields ok
- **THEN** stderr ends with a summary line containing the row count and duration

#### Scenario: Report after healing
- **WHEN** a run heals two fields and writes the recipe back
- **THEN** the summary line reports 2 healed fields and the report names the written path

#### Scenario: Report after pages
- **WHEN** a run extracts 3 pages with 2 duplicates dropped
- **THEN** the summary line contains the page count 3 and the duplicate count 2

#### Scenario: Report after dropped rows
- **WHEN** a run drops 6 rows because `url` was missing on them
- **THEN** the summary line says 6 rows were dropped for missing fields, the report's dropped count is 6, and `url` has status `partial` with the 6 container indexes

### Requirement: Run events
The runner SHALL emit typed events during a run: `run.start`, `page.loaded`, `guard.raised`, `guard.cleared`, `guard.timeout`, `step.replayed`, `step.skipped`, `field.resolved`, `field.healed`, `repick.requested`, `repick.resolved`, `row.emitted`, `page.done`, `page.advanced`, `pagination.stopped`, `recipe.saved`, `run.done`, `run.failed`. Consumers SHALL be able to subscribe without changing runner behavior. JSONL output SHALL be driven by `row.emitted`.

#### Scenario: Event order
- **WHEN** a run succeeds on one page
- **THEN** events are observed in the order `run.start`, `page.loaded`, `field.resolved` (one or more), `row.emitted` (one or more), `page.done`, `pagination.stopped`, `run.done`

#### Scenario: Healing events
- **WHEN** a field heals and the recipe is written back
- **THEN** `field.healed` is observed before that field's `field.resolved`, and `recipe.saved` is observed before `run.done`

#### Scenario: Multi-page order
- **WHEN** a run extracts two pages
- **THEN** `page.done` for page 1 is observed before `page.advanced` for page 2, which precedes `page.loaded` for page 2

#### Scenario: Guard events
- **WHEN** a login guard is raised on page 1 and cleared
- **THEN** `guard.raised` follows `page.loaded` and `guard.cleared` precedes the first `field.resolved`

#### Scenario: Step events
- **WHEN** a recipe has one `first-page` step
- **THEN** `step.replayed` is observed after `page.loaded` and any guard events, and before the first `field.resolved`

### Requirement: Clean shutdown
On success, failure, guard timeout, or SIGINT the runner SHALL close the browser context and release the profile lock before the process exits. A run that ends while paused on a guard SHALL close the browser like any other run.

#### Scenario: Interrupted run
- **WHEN** SIGINT is received mid-run
- **THEN** the browser closes, the lock is released, and the exit code is 1

#### Scenario: Interrupted while paused
- **WHEN** SIGINT is received while the run is paused on a guard
- **THEN** the browser closes, the lock is released, and the exit code is 1

### Requirement: Window hiding hooks
When a window port is supplied, the runner SHALL call `hide` after the browser session opens and before the first navigation, `show` when a guard is raised, and `hide` again when a guard clears. Window port failures SHALL NOT fail the run. The runner SHALL set the initial page title to `webscoop` before the first navigation. Before opening the browser, the runner SHALL call the window port's optional `prepare` and append its optional `launchArgs` to the browser's launch arguments.

#### Scenario: Hide after open
- **WHEN** a run opens the browser with a window port
- **THEN** `hide` is called before `page.loaded` is emitted for page 1

#### Scenario: Prepare before launch
- **WHEN** the window port declares `prepare` and `launchArgs`
- **THEN** `prepare` is called before the browser opens and the browser is opened with the launch arguments appended

#### Scenario: Show then hide around a guard
- **WHEN** a guard is raised and later clears
- **THEN** `show` is called on raise and `hide` on clear
