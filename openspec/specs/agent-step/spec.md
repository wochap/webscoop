# agent-step Specification

## Purpose

Defines the `agent` step: a bounded loop in which a language model reads a compact outline of the step's window and acts on it one JSON action at a time, within a page scope, until a goal such as a download is reached, and how the loop is reported.

## Requirements

### Requirement: Agent loop
An `agent` step SHALL run as a loop in the step's window. Each turn the runner SHALL build the page outline defined in "Page outline", send the conversation to the step's language model asking for one JSON action, validate the answer against the action schema of "Agent actions", execute the action, append its result and a fresh outline to the conversation, and continue. The conversation SHALL start with a system message (the runner's role statement, the action schema with one example per action, the scope rule, and the instruction to answer with exactly one action) and a user message holding the goal with variables substituted, the window's URL, and its title. The step's model SHALL be the LLM entry named by the step's `llm`, else the run's entry as defined by the llm-adapter capability's "Entry resolution". Requests SHALL use the entry's effort and output budget and temperature 0.

Before each request, turns older than the latest SHALL be compressed to their action line and the first line of their result, and the oldest compressed turns SHALL be dropped until the estimated conversation size is at most the entry's effective `contextTokens` minus its effective `maxOutputTokens` minus the outline budget. The latest result SHALL always carry the full outline.

#### Scenario: Two turns to a download
- **WHEN** an agent step with `until` `download` runs on a page whose outline lists `[e3] button "Export"` and then, after clicking it, `[e7] link "PDF"`, and the model answers `click e3` then `click e7`
- **THEN** the step ends `ok` after the second click's download is saved, with two turns in its transcript

#### Scenario: Step names an entry
- **WHEN** the step sets `llm` to `smart` and the run was started with `--llm fast`
- **THEN** every request of the step goes to the `smart` entry

#### Scenario: History trimmed
- **WHEN** a step on a 32768 token entry reaches its twelfth turn
- **THEN** the request holds the system message, the goal, the latest full outline, and only as many older turns, compressed, as fit the budget

### Requirement: Page outline
The outline SHALL be built from a snapshot of the step's window's main document. It SHALL hold one line per kept element in document order, each starting with a ref `e<n>` numbered from 1 in document order, followed by the element's role name (`link`, `button`, `textbox`, `checkbox`, `combobox`, `heading`, `text`, or the ARIA role), its accessible name in quotes when it has one, and for links `href=`, for inputs `value=` cut to 40 characters, and for checkboxes and radios `checked`. Kept elements SHALL be: interactive elements (anchors with `href`, buttons, inputs other than hidden, selects, textareas, `summary`, and elements with an interactive ARIA role or an `onclick` attribute), headings, and elements with own text of at least 3 characters. Elements hidden by the healing capability's hidden rule, and elements inside `head`, SHALL be left out. A line SHALL be cut to 120 characters. The outline SHALL be cut to fit the outline budget, 40 percent of the entry's effective `contextTokens` minus the estimated size of the system message and the goal, keeping interactive lines first, then headings, then text lines, each group in document order; a cut outline SHALL end with a line `... <n> more lines; use find`. Refs SHALL be valid for the turn they were produced in; an action naming a ref from an earlier outline SHALL get a result saying the ref is stale, and a fresh outline.

#### Scenario: Link and button lines
- **WHEN** the page has `<a href="/q3.pdf">Download PDF</a>` and `<button>Export</button>` in that order
- **THEN** the outline has `[e1] link "Download PDF" href=/q3.pdf` before `[e2] button "Export"`

#### Scenario: Hidden element left out
- **WHEN** a button is inside an element with `hidden`
- **THEN** the button has no line in the outline

#### Scenario: Same page, same refs
- **WHEN** the outline is built twice on an unchanged page
- **THEN** every element has the same ref both times

#### Scenario: Outline cut under a small budget
- **WHEN** the page has 300 text paragraphs and 5 links and the entry's `contextTokens` is 8192
- **THEN** the outline holds the 5 link lines, then as many paragraph lines as fit, and ends with the `... more lines; use find` line

#### Scenario: Stale ref
- **WHEN** the model answers `click e9` using a ref from the previous turn's outline after the page changed
- **THEN** the result says `e9` is stale and the model gets the current outline

### Requirement: Agent actions
The model's answer SHALL be a JSON object with `action` and `reason` (a string) and the action's arguments:
- `click` with `ref`: click the element as a `click` step does.
- `fill` with `ref` and `value`: set the value as a `fill` step does by element kind.
- `press` with `key` and optional `ref`: as a `press` step.
- `scroll` with `direction` (`down`, `up`, or `bottom`): scroll the window by one viewport, or to the bottom.
- `find` with `text`: answer with up to 20 outline lines, including lines cut from the outline, whose name, text, or `href` contains `text` case-insensitively.
- `html` with `ref`: answer with the element's outer HTML cut to 2000 characters.
- `wait` with `ms` from 1 to 5000: wait that long.
- `done` with `reason`: end the loop as defined in "Termination".
- `give_up` with `reason`: end the loop as failed.

After `click`, `fill`, and `press`, the runner SHALL wait for the window to settle and check guards as it does after a step. Each action's result SHALL be text saying what happened: the window's URL and title when they changed, downloads saved during the action by name, popups opened and what became of them, or the action's own answer. An answer that is not valid JSON or does not match the schema SHALL get a result naming the problem and asking for one JSON action; three such answers in a row SHALL end the loop as failed. A `click`, `fill`, or `press` repeated on the same ref with the same arguments as the previous turn SHALL get a result saying it was already done, and SHALL still be executed.

#### Scenario: Find beyond the cut
- **WHEN** the outline was cut and the model answers `find "pdf"`
- **THEN** the result lists the lines containing `pdf` whether or not they were in the outline

#### Scenario: Invalid answer
- **WHEN** the model answers `{"action":"tap","ref":"e2"}`
- **THEN** the result says the action is unknown, lists the valid actions, and the loop continues

#### Scenario: Three invalid answers
- **WHEN** the model gives three consecutive answers that fail the schema
- **THEN** the step ends failed with end reason `invalid-answers`

### Requirement: Scope gate
With `scope` `page`, after each action the runner SHALL compare the main window's URL, without its fragment, to the URL the step started on. When they differ and the navigation was not a download, the runner SHALL navigate the window back to the starting URL, wait for it to settle, and give the model a result saying the action navigated to the other URL, which is outside the step's scope, and that the page was restored. A popup opened by an action that loaded a document SHALL be closed and reported the same way; a popup that only started a download SHALL be reported as that download. A navigation that started a download SHALL NOT be gated. The system message SHALL state the scope rule.

#### Scenario: Link to another page undone
- **WHEN** the model clicks a link to `/about` on a step scoped to `page`
- **THEN** the window is back on the starting URL, and the result names `/about` as outside the scope

#### Scenario: Download popup allowed
- **WHEN** the model clicks a button that opens a popup which starts a PDF download and closes
- **THEN** the result names the saved file and the main window is unchanged

#### Scenario: Fragment change allowed
- **WHEN** the model clicks a link to `#downloads` on the same page
- **THEN** no restore happens and the result reports the new URL

### Requirement: Termination
The loop SHALL end, and the step's outcome SHALL be:
- `ok` as soon as, with `until` `download`, a download that the step's window started during the step is saved, even before the current action's result is built;
- `ok` on `done` when the step has no `until`;
- on `done` with `until` `download` and no download saved yet: the loop SHALL continue with a result saying no download has been saved and that the model may keep going or give up; a second such `done` SHALL end the loop as failed with end reason `done-unmet`;
- failed on `give_up` (end reason `gave-up`), on reaching `maxTurns` (`max-turns`), on an adapter error after the adapter's own retries (`llm-error`), or on three invalid answers (`invalid-answers`).

A failed required agent step SHALL fail the run with reason `missing-required` naming the step, and the process SHALL exit 3; a failed optional agent step SHALL be skipped and reported. A download saved during a step with `until` `download` SHALL count as taken by the step for the `downloads` output table, named by the step's `value` with variables substituted when given, else as the server suggests, with the download step's name rules.

#### Scenario: Download ends the loop
- **WHEN** a click starts a download that is saved while the step is waiting for the window to settle
- **THEN** the step ends `ok` without another request to the model

#### Scenario: Done without a download
- **WHEN** the step has `until` `download` and the model answers `done` twice without a download
- **THEN** the step ends failed with end reason `done-unmet`

#### Scenario: Turn cap
- **WHEN** `maxTurns` is 3 and the model answers `scroll` three times
- **THEN** the step ends failed with end reason `max-turns`, and the required step fails the run with exit 3

#### Scenario: Optional step gives up
- **WHEN** an optional agent step ends with `give_up`
- **THEN** the run continues and the report marks the step skipped with end reason `gave-up`

#### Scenario: Model unavailable
- **WHEN** `--no-llm` is given and a required agent step is reached
- **THEN** the run fails with `missing-required` naming the step, exit 3, and stderr names `--no-llm`

### Requirement: Agent reporting
`step.replayed` and `step.skipped` for an agent step SHALL carry `agent` with `turns`, `end` (`download`, `done`, `done-unmet`, `gave-up`, `max-turns`, `llm-error`, `invalid-answers`, or `no-llm`), and `actions`, one entry per turn with `turn`, `action`, `ref` and the ref's outline line when the action had one, `reason`, and the first line of the result. The run report SHALL list the same under the flow run. Unless `--quiet` is given, stderr SHALL print one line per action, `agent: <action> <outline line> (<reason>)`, and one line with the end reason and turn count. No other page text SHALL be printed.

#### Scenario: Transcript in the report
- **WHEN** an agent step ends after two clicks and a download
- **THEN** the report lists two actions with their outline lines and reasons, `turns` 2, and `end` `download`

#### Scenario: Quiet run
- **WHEN** `webscoop run grab-pdf --quiet` runs an agent step
- **THEN** stderr has no `agent:` lines
