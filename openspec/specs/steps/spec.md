# steps Specification

## Purpose

Defines recorded user actions that a run replays before extracting: what a step is, when it runs, how its target is resolved and healed, what happens when it cannot run, and how replay is reported.

## Requirements

### Requirement: Step kinds
A step SHALL be one of:
- `click`: resolve the target and click it.
- `type`: resolve the target, clear it, and type the value; the value MAY reference template variables as `{name}`, substituted with the run's variable values.
- `select`: resolve the target, a `select` element, and choose the option whose value or visible label equals the value.
- `press`: press the named key (`Enter`, `Escape`, `Tab`, or a single character) on the target when given, else on the focused element.
- `wait`: wait for the given milliseconds, or until the target resolves, bounded by the navigation timeout.
`click`, `type`, and `select` SHALL require a target; `press` and `wait` MAY have one.

#### Scenario: Type with a variable
- **WHEN** a `type` step has value `{query}` and the run has `query=mouse`
- **THEN** the target receives the text `mouse`

#### Scenario: Wait for a target
- **WHEN** a `wait` step targets the product list and the list appears after 800 milliseconds
- **THEN** the step completes once the list resolves

### Requirement: When steps run
Each step SHALL declare `when`: `first-page` (default) runs once after the first page has loaded and its guards have cleared; `every-page` runs after every page navigation of the run, including the first. Steps SHALL run in list order. After the last step of a batch the runner SHALL wait for the page to settle before extracting.

#### Scenario: Cookie banner once
- **WHEN** a recipe has a `first-page` click on the consent button and pagination kind `url` with 3 pages
- **THEN** the click runs once and pages 2 and 3 extract without it

#### Scenario: Tab on every page
- **WHEN** a recipe has an `every-page` click on the Products tab and pagination kind `next` with 3 pages
- **THEN** the click runs three times, once per page, before each extraction

### Requirement: Target resolution and healing
A step's target SHALL be resolved through the healing ladder like a field target, using the stored candidates, then fuzzy fingerprint match, then the model rung, then failure. A healed step target SHALL be promoted and written back with the recipe. Resolution SHALL happen once per step per page batch; `every-page` steps reuse the resolved selector on later pages and re-heal only when it stops resolving.

#### Scenario: Consent button renamed
- **WHEN** the stored candidates for the consent button fail and the fingerprint matches the new button
- **THEN** the step clicks the new button and the recipe's step target is promoted on write-back

### Requirement: Optional and required steps
When a step's target cannot be resolved, an `optional` step SHALL be skipped and reported; a required step SHALL fail the run with reason `missing-required` naming the step, and the process SHALL exit 3. A `wait` step with a target that never resolves within the timeout SHALL follow the same rule.

#### Scenario: Banner absent
- **WHEN** an optional consent click finds no button
- **THEN** the run continues and the report marks the step skipped

#### Scenario: Search box gone
- **WHEN** a required `type` step finds no input
- **THEN** the run exits 3 and stderr names the step

### Requirement: Navigation caused by a step
When a step causes a navigation, the runner SHALL wait for the new page to settle, re-check guards, and continue with the next step on the new page. The extracted page after the batch SHALL be the page the steps ended on, and its URL SHALL be recorded as the intended URL for guard recovery.

#### Scenario: Search submits to a results page
- **WHEN** a `type` step and a `press` Enter step lead to `/search?q=mouse`
- **THEN** extraction happens on `/search?q=mouse`

### Requirement: Step reporting
The runner SHALL emit `step.replayed` after each completed step with its index, kind, and healing outcome, and `step.skipped` for skipped optional steps. The run report SHALL list each step with kind, outcome (`ok`, `healed`, `skipped`, `failed`), and the page number it ran on. The stderr summary SHALL mention skipped steps when any.

#### Scenario: Report with one healed step
- **WHEN** a run replays two steps and the first heals
- **THEN** the report lists step 0 as `healed` and step 1 as `ok`
