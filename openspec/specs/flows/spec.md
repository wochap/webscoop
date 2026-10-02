# flows Specification

## Purpose
Defines how a recipe says what runs and when: named flows of steps, the ordered sequence of flow, extract, and paginate blocks, reactive flows that fire when an element appears, handing control to the user, acting in popup windows, and restoring the page state after an interruption.

## Requirements

### Requirement: Flows
A recipe MAY declare `flows`, a list of flows. Each flow SHALL have:
- a `name`, kebab-case and unique within the recipe
- an optional `description`
- `steps`, a non-empty list of steps as defined by the steps capability
- an optional `trigger`

A flow without `trigger` is a called flow. A flow with `trigger` `{ "appears": <target> }` is a reactive flow. A reactive flow MAY declare:
- `maxRetries`, a positive integer, default 2
- `recover`, a boolean, default false

`maxRetries` and `recover` SHALL be rejected on a called flow.

#### Scenario: Called and reactive flows
- **WHEN** a recipe declares a flow `reach-report` with three steps and a flow `login-wall` with trigger `appears` on the "Log in" button
- **THEN** the recipe validates, `reach-report` is a called flow, and `login-wall` is a reactive flow with `maxRetries` 2 and `recover` false

#### Scenario: Duplicate flow name
- **WHEN** two flows are named `setup`
- **THEN** validation fails naming `setup`

### Requirement: Sequence
A recipe SHALL declare `sequence`, a non-empty ordered list of blocks. A block SHALL be one of:
- `{ "flow": <name> }`, naming a called flow
- `{ "extract": <table name> }`
- `{ "paginate": <settings> }`, where the settings are those of the pagination capability plus `do`, a non-empty list of `flow` and `extract` blocks

Validation SHALL reject, naming the offending block:
- a `flow` block naming an unknown or reactive flow
- an `extract` block naming an unknown table
- a table extracted more than once
- a `paginate` block inside `do`
- more than one `paginate` block
- a table never extracted
- a called flow never used

A flow MAY appear in more than one block.

#### Scenario: Typical sequence
- **WHEN** the sequence is `reach-report`, `extract summary`, `open-detail`, then `paginate` (kind `next`, table `results`) with `do: [extract results]`
- **THEN** the recipe validates

#### Scenario: Table extracted twice
- **WHEN** `summary` is extracted before and inside the paginate block
- **THEN** validation fails naming `summary`

#### Scenario: Reactive flow in the sequence
- **WHEN** the sequence has a `flow` block naming the reactive flow `login-wall`
- **THEN** validation fails saying `login-wall` is reactive

### Requirement: Sequence execution
The runner SHALL navigate to the recipe URL, wait for the page to settle, check guards, and then run the sequence blocks in order:
- **`flow`**: replay the flow's steps in order.
- **`extract`**: extract the table on the main window's current page and emit its rows at once.
- **`paginate`**: run its `do` blocks for the current page, then advance as the pagination capability defines, and repeat until a stop rule, the limit, or the cap ends it.

Blocks outside a paginate block run once. `_page` SHALL be 1 for extractions before the paginate block, the page number inside it, and the last page number after it. A recipe whose sequence holds no `extract` block SHALL succeed when every block completes, and emit no rows.

#### Scenario: Extract, switch tab, extract
- **WHEN** the sequence is `extract summary`, `flow open-detail` (a click on an SPA tab that does not change the URL), `extract details`
- **THEN** `summary` rows come from the page before the click and `details` rows from the page after it

#### Scenario: Flow inside paginate
- **WHEN** a `flow` block clicks the Products tab inside `paginate` (kind `next`, limit 3)
- **THEN** the flow runs three times, once before each page's extraction

#### Scenario: Automation only
- **WHEN** a recipe has no tables and its sequence is one flow that fills and submits a form
- **THEN** the run succeeds with no rows once the flow completes

### Requirement: Reactive flows and checkpoints
At each checkpoint the runner SHALL check every reactive flow's trigger in every open window of the run: the main window and the popups opened by the run. A trigger matches when its target resolves to at least one element. The checkpoints are:
- after a page settles
- before each step
- before each extraction
- every second while a step waits for the user or a guard is paused

When triggers match, the runner SHALL run the first matching reactive flow in recipe order, in the window where the trigger matched, and then continue where it was. While a reactive flow runs, no other reactive flow SHALL fire, and its own trigger SHALL NOT be re-checked. After a reactive flow with `recover` completes, the runner SHALL restore the page state as defined in "Recovery". The report SHALL record each firing.

#### Scenario: Cookie banner whenever it shows
- **WHEN** a reactive flow `cookie-banner` triggers on the consent button and clicks it, and the banner appears on page 1 and again on page 3
- **THEN** the flow fires twice, before the extractions of pages 1 and 3

#### Scenario: Session expires mid-run
- **WHEN** after page 4 of a paginated run the "Log in" button appears and the reactive flow `login-wall` with `recover` runs
- **THEN** the run restores the page state as defined in "Recovery" before continuing

### Requirement: Reactive flow retries
A reactive flow SHALL fire at most `maxRetries` times between two successful extractions. The firing that would exceed it SHALL instead fail the run with reason `flow-loop`, naming the flow, and exit 1. A successful extraction SHALL reset the count of every reactive flow.

#### Scenario: Login keeps failing
- **WHEN** `login-wall` has `maxRetries` 2 and the login button reappears after each firing without an extraction in between
- **THEN** the third match fails the run with `flow-loop` naming `login-wall`

### Requirement: Await user
An `await-user` step SHALL pause the run until its target appears or disappears, as its `until` says, in the step's window. The pause SHALL:
- acquire attention for the run's browser as defined by the browser-daemon capability
- bring the step's window to the front
- emit `attention.needed` with reason `await-user` and the step's label
- send the desktop notification when notifications are on
- show the guard banner with the step's label as the reason, unless the banner is turned off

The runner SHALL check the condition at least every second, and Continue SHALL check it at once. The step completes when the condition holds. The wait SHALL draw on the run's guard timeout budget, or on the step's `timeoutMs` when given. When the time runs out, the run SHALL fail with reason `paused` and exit 2, keeping the rows already emitted. Abort SHALL fail the run with reason `aborted`. Attention SHALL resolve when the step ends by any of these paths.

#### Scenario: Manual login in a popup
- **WHEN** the flow clicks "Log in", which opens a popup, and then runs `await-user` in the popup until the "Log in" button disappears from the main window
- **THEN** the run waits, the user logs in, and the step completes within a second of the button disappearing

#### Scenario: Await user times out
- **WHEN** the guard timeout budget is 0 and an `await-user` step's condition does not hold
- **THEN** the run fails with `paused` and exit 2

### Requirement: Windows
A step with `window` `popup` SHALL act in the newest popup opened by an earlier step of the same flow run. When no such popup exists yet, the runner SHALL wait for one up to the navigation timeout. When none opens, or it has closed, the step's target SHALL count as not resolving. A step with `window` `same` SHALL act in the window where the flow started: the main window for a called flow, and the trigger's window for a reactive flow. A popup that closes while the run continues SHALL leave the main window current. Extraction SHALL always use the main window.

#### Scenario: Fill inside the popup
- **WHEN** a flow clicks "Log in", which runs `window.open`, and the next step is a `fill` with `window` `popup`
- **THEN** the value is typed into the popup's input

#### Scenario: Popup never opens
- **WHEN** a required `popup` step runs and no popup opens within the navigation timeout
- **THEN** the run fails with `missing-required` naming the step

### Requirement: Recovery
Recovery SHALL restore the state the sequence had built at the current point.
- **The batch.** The current batch is the part of the sequence that ran since the last navigation the runner made itself: from the start of the sequence, or, inside a `url` paginate block, from the start of the current page.
- **The restore.** The runner SHALL navigate to the URL where the batch began, wait for it to settle, check guards, and replay, in order, the `flow` blocks of the batch that ran before the current point. `extract` blocks SHALL NOT be repeated.
- **Skipping.** When the batch has no such flow blocks and the main window is already on the batch URL, the runner SHALL skip the navigation.
- **Click pagination.** When the current point is on page 2 or later of a `next` or `more` paginate block, the runner SHALL instead fail the run with reason `pagination-lost`, exit 1, and a message naming the page. Rows already emitted SHALL stay emitted.

#### Scenario: SPA state rebuilt after login
- **WHEN** the sequence is `reach-report` then `extract results`, and a guard clears before the extraction
- **THEN** the runner reloads the recipe URL, replays `reach-report`, and extracts `results`

#### Scenario: Recovery on a later clicked page
- **WHEN** a `next` paginate block is on page 3 and a guard clears
- **THEN** the run fails with `pagination-lost` naming page 3, and the rows of pages 1 and 2 are kept

### Requirement: Flow reporting
The runner SHALL emit:
- `flow.started`, with the flow name, `called` or `reactive`, the page number, and for a reactive flow the window
- `flow.done`, with the flow name and its outcome

The run report SHALL list each flow run with name, kind, page number, and outcome, and each step under its flow as defined by the steps capability. The stderr summary SHALL mention how many times reactive flows fired, when any did.

#### Scenario: Report with a reactive firing
- **WHEN** a run calls `reach-report` once and `cookie-banner` fires once
- **THEN** the report lists two flow runs, one `called` and one `reactive`, each with its steps
