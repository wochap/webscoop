# steps Specification

## Purpose

Defines recorded user actions that a run replays before extracting: what a step is, when it runs, how its target is resolved and healed, what happens when it cannot run, and how replay is reported.

## Requirements

### Requirement: Step kinds
A step SHALL be one of:
- `click`: resolve the target and click it.
- `fill`: resolve the target and set its value. For a text input, textarea, or contenteditable, clear it and type the value. For a native `select`, choose the option whose value or visible label equals the value. The value MAY reference template variables as `{name}`, substituted with the run's variable values.
- `press`: press the named key (`Enter`, `Escape`, `Tab`, or a single character) on the target when given, else on the focused element.
- `wait`: wait for the given milliseconds, or until the target resolves, bounded by the navigation timeout.
- `await-user`: wait for the user until the target appears or disappears, as defined by the flows capability.

`click`, `fill`, and `await-user` SHALL require a target. `fill` and `press` SHALL require a value. `wait` SHALL have a target or a numeric value. `await-user` SHALL have `until`, either `appears` or `disappears`, and MAY have `timeoutMs`.

Every step MAY have:
- `window`: `same` (default) or `popup`, as defined by the flows capability
- `optional`: a boolean, default false
- `label`: a string

#### Scenario: Type with a variable
- **WHEN** a `fill` step has value `{query}` and the run has `query=mouse`
- **THEN** the target receives the text `mouse`

#### Scenario: Fill a native select by label
- **WHEN** a `fill` step targets a `select` with value `Peru` and the option labeled `Peru` has value `PE`
- **THEN** the option `PE` is selected

#### Scenario: Wait for a target
- **WHEN** a `wait` step targets the product list and the list appears after 800 milliseconds
- **THEN** the step completes once the list resolves

### Requirement: Target resolution and healing
A step's target SHALL be resolved in the step's window through the healing ladder like a field target: the stored candidates, then the fuzzy fingerprint match, then the model rung, then failure. A healed step target SHALL be promoted and written back with the recipe, addressed by its flow name and step index. Within one run, a step that resolved SHALL reuse its resolved selector on its next runs, and re-heal only when that selector stops resolving.

#### Scenario: Consent button renamed
- **WHEN** the stored candidates for the consent button fail and the fingerprint matches the new button
- **THEN** the step clicks the new button and the step target in its flow is promoted on write-back

### Requirement: Optional and required steps
When a step's target cannot be resolved, an `optional` step SHALL be skipped and reported; a required step SHALL fail the run with reason `missing-required` naming the step, and the process SHALL exit 3. A `wait` step with a target that never resolves within the timeout SHALL follow the same rule.

#### Scenario: Banner absent
- **WHEN** an optional consent click finds no button
- **THEN** the run continues and the report marks the step skipped

#### Scenario: Search box gone
- **WHEN** a required `type` step finds no input
- **THEN** the run exits 3 and stderr names the step

### Requirement: Navigation caused by a step
When a step causes a navigation of the main window, the runner SHALL wait for the new page to settle, check guards, and continue with the next block or step on the new page. A navigation inside a popup SHALL be waited for in that popup.

#### Scenario: Search submits to a results page
- **WHEN** a `fill` step and a `press` Enter step lead to `/search?q=mouse`
- **THEN** the next `extract` block reads `/search?q=mouse`

### Requirement: Step reporting
The runner SHALL emit `step.replayed` after each completed step, with its flow name, index, kind, and healing outcome, and `step.skipped` for skipped optional steps. The run report SHALL list each step under its flow run with kind, outcome (`ok`, `healed`, `skipped`, `failed`), and the page number it ran on. The stderr summary SHALL mention skipped steps when there are any.

#### Scenario: Report with one healed step
- **WHEN** a flow replays two steps and the first heals
- **THEN** the report lists step 0 of that flow as `healed` and step 1 as `ok`
