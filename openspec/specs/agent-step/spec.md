# agent-step Specification

## Purpose

Defines the `agent` step: a bounded loop in which a language model reads a compact outline of the step's window and acts on it one JSON action at a time, within a page scope, until a goal such as a download is reached, and how the loop is reported.

## Requirements

### Requirement: Agent loop
An `agent` step SHALL run as a loop in the step's window. Each turn the runner SHALL build the page outline defined in "Page outline", send the conversation to the step's language model asking for one JSON action, validate the answer against the action schema of "Agent actions", execute the action, append its result and a fresh outline to the conversation, and continue. The conversation SHALL start with a system message (the runner's role statement, the action schema with one example per action, the scope rule, and the instruction to answer with exactly one action) and a user message holding the goal with its non-secret variables substituted and its secret variables left as placeholders as defined in "Secret placeholders", the window's URL, and its title. The system message SHALL also explain secret placeholders and how to type them. The step's model SHALL be the LLM entry named by the step's `llm`, else the run's entry as defined by the llm-adapter capability's "Entry resolution". Requests SHALL use the entry's effort and output budget and temperature 0.

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
- `back`: return to the previous document of the step's history as defined in "Scope gate"; on the first document it SHALL do nothing and say there is no earlier page.
- `done` with `reason`: end the loop as defined in "Termination".
- `give_up` with `reason`: end the loop as failed.

After `click`, `fill`, `press`, and `back`, the runner SHALL wait for the window to settle and check guards as it does after a step. Each action's result SHALL be text saying what happened: the window's URL and title when they changed, downloads saved during the action by name, popups opened and what became of them, or the action's own answer. An answer that is not valid JSON or does not match the schema SHALL get a result naming the problem and asking for one JSON action; three such answers in a row SHALL end the loop as failed. A `click`, `fill`, or `press` repeated on the same ref with the same arguments as the previous turn SHALL get a result saying it was already done, and SHALL still be executed.

#### Scenario: Find beyond the cut
- **WHEN** the outline was cut and the model answers `find "pdf"`
- **THEN** the result lists the lines containing `pdf` whether or not they were in the outline

#### Scenario: Invalid answer
- **WHEN** the model answers `{"action":"tap","ref":"e2"}`
- **THEN** the result says the action is unknown, lists the valid actions, and the loop continues

#### Scenario: Three invalid answers
- **WHEN** the model gives three consecutive answers that fail the schema
- **THEN** the step ends failed with end reason `invalid-answers`

#### Scenario: Back on the first page
- **WHEN** the model answers `back` before any navigation
- **THEN** the window is unchanged and the result says there is no earlier page

### Requirement: Scope gate
The step SHALL keep a history of documents, starting with the URL the step started on. After each action that can navigate, the runner SHALL compare the main window's URL with the latest entry of the history, both without their fragment.

- With `scope` `page`, any difference is out of scope.
- With `scope` `site`, a URL whose origin (scheme, host, and port) equals the starting URL's origin is in scope. An in-scope URL that differs from the latest entry SHALL be appended to the history. The history SHALL hold at most 50 entries, dropping the oldest after the first.

When the URL is out of scope and the navigation was not a download, the runner SHALL navigate the window to the latest history entry and wait for it to settle. It SHALL give the model a result saying that the action navigated to the other URL, which is outside the step's scope, and that the page was restored.

`back` SHALL remove the latest entry and navigate to the new latest entry, saying in its result that the page was loaded from its URL.

A popup opened by an action that loaded a document SHALL be closed and reported the same way in every scope. A popup that only started a download SHALL be reported as that download. A navigation that started a download SHALL NOT be gated.

The system message SHALL state the rule of the step's scope, and with `site` it SHALL name the allowed origin and the `back` action. Every message that carries the outline SHALL start with the window's current URL and title.

#### Scenario: Link to another page undone
- **WHEN** the model clicks a link to `/about` on a step scoped to `page`
- **THEN** the window is back on the starting URL, and the result names `/about` as outside the scope

#### Scenario: Form submit kept under site scope
- **WHEN** a step scoped to `site` starts on `https://shop.test/contact`, and the model fills the form and clicks Send, which loads `https://shop.test/contact/thanks`
- **THEN** the window stays on `/contact/thanks`, the history holds both URLs, and the next outline is of the thank-you page under the line `URL: https://shop.test/contact/thanks`

#### Scenario: Other origin undone under site scope
- **WHEN** a step scoped to `site` is on `https://shop.test/cart` after two in-scope navigations, and the model clicks a link to `https://pay.other.test/`
- **THEN** the window is back on `https://shop.test/cart`, not on the starting URL, and the result names `https://pay.other.test/` as outside the scope

#### Scenario: Back to the previous page
- **WHEN** a step scoped to `site` navigated from `/search` to `/search?q=lamp` and then to `/item/7`, and the model answers `back`
- **THEN** the window loads `/search?q=lamp` and the history's latest entry is that URL

#### Scenario: Download popup allowed
- **WHEN** the model clicks a button that opens a popup which starts a PDF download and closes
- **THEN** the result names the saved file and the main window is unchanged

#### Scenario: Fragment change allowed
- **WHEN** the model clicks a link to `#downloads` on the same page
- **THEN** no restore happens and the result reports the new URL

### Requirement: Termination
The loop SHALL end, and the step's outcome SHALL be:
- `ok` as soon as, with `until` `download`, a download that the step's window started during the step is saved, even before the current action's result is built;
- `ok` as soon as, with `until` `appears` or `disappears`, the step's target resolves (`appears`) or resolves nowhere (`disappears`) in the step's window, checked with the stored selector candidates as `await-user` does, before every request including the first and after every executed action has settled; the end reason SHALL be `condition`, and a condition that holds before the first request SHALL end the step with 0 turns and no model request;
- `ok` on `done` when the step has no `until`;
- `ok` with end reason `ready-to-submit` when the effective submit policy is `stop` and the model's action would submit, as defined in "Submit confirmation", without executing the action;
- on `done` with an `until` not met yet: the loop SHALL continue with a result saying that no download has been saved, or that the target named by its primary candidate has not appeared or disappeared, and that the model may keep going or give up; a second such `done` SHALL end the loop as failed with end reason `done-unmet`;
- failed on `give_up` (end reason `gave-up`), on reaching `maxTurns` (`max-turns`), on an adapter error after the adapter's own retries (`llm-error`), or on three invalid answers (`invalid-answers`).

A failed required agent step SHALL fail the run with reason `missing-required` naming the step, and the process SHALL exit 3; a failed optional agent step SHALL be skipped and reported. A download saved during a step with `until` `download` SHALL count as taken by the step for the `downloads` output table, named by the step's `value` with variables substituted when given, else as the server suggests, with the download step's name rules.

#### Scenario: Download ends the loop
- **WHEN** a click starts a download that is saved while the step is waiting for the window to settle
- **THEN** the step ends `ok` without another request to the model

#### Scenario: Banner ends the loop
- **WHEN** a step with `until` `appears` targets `.thanks` and the model's click on Send loads a page showing `.thanks`
- **THEN** the step ends `ok` with end reason `condition` without another request to the model

#### Scenario: Condition already met
- **WHEN** a step has `until` `disappears` targeting the cookie banner and the page shows no banner
- **THEN** the step ends `ok` with end reason `condition`, 0 turns, and no model request

#### Scenario: Done before the banner
- **WHEN** a step has `until` `appears` and the model answers `done` twice while `.thanks` resolves nowhere
- **THEN** the first result names `.thanks` as not yet appeared, and the step ends failed with end reason `done-unmet`

#### Scenario: Dry run stops before ordering
- **WHEN** an agent step runs with `--submit stop` and the model clicks `[e9] button "Place order"`
- **THEN** the button is not clicked and the step ends `ok` with end reason `ready-to-submit`

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
`step.replayed` and `step.skipped` for an agent step SHALL carry `agent` with `turns`, `end` (`download`, `condition`, `ready-to-submit`, `done`, `done-unmet`, `gave-up`, `max-turns`, `llm-error`, `invalid-answers`, or `no-llm`), and `actions`, one entry per turn with `turn`, `action`, `ref` and the ref's outline line when the action had one, `reason`, the first line of the result, and `submit` (`asked`, `allowed`, or `stopped`) when the action was classified as a submit. The run report SHALL list the same under the flow run. Unless `--quiet` is given, stderr SHALL print one line per action, `agent: <action> <outline line> (<reason>)`, and one line with the end reason and turn count. No other page text SHALL be printed.

#### Scenario: Transcript in the report
- **WHEN** an agent step ends after two clicks and a download
- **THEN** the report lists two actions with their outline lines and reasons, `turns` 2, and `end` `download`

#### Scenario: Condition in the report
- **WHEN** an agent step with `until` `appears` ends after a fill and a click that showed its target
- **THEN** the report lists two actions, `turns` 2, and `end` `condition`

#### Scenario: Asked submit in the transcript
- **WHEN** the person allows a submit the agent asked for
- **THEN** that turn's entry has `submit` `asked`

#### Scenario: Quiet run
- **WHEN** `webscoop run grab-pdf --quiet` runs an agent step
- **THEN** stderr has no `agent:` lines

### Requirement: Secret placeholders
A secret variable referenced in an agent step's goal SHALL reach the model only as its placeholder `{name}`, never as its value. When a `fill` action's value contains the placeholder of a secret variable of the run, the runner SHALL replace the placeholder with the variable's value right before filling, and only when both of these hold:
- the ref is a text field: an `input` other than checkbox, radio, file, submit, button, reset, or image, or a `textarea`;
- the window's origin equals the step's starting origin.

Otherwise it SHALL fill nothing and answer that a secret placeholder can only be typed into a text field of the starting site. A placeholder in a `press` key SHALL NOT be expanded.

Everything derived from the page that is sent to the model SHALL be masked: the outline, `find` results, and `html` output.
- A non-empty `value` of an input with `type=password` SHALL be shown as `***`.
- Every occurrence of a secret value SHALL be replaced with its placeholder, longest value first.

The conversation, the transcript, and the repeat check SHALL hold the model's answer with the placeholder, not the value.

#### Scenario: Log in without exposing the password
- **WHEN** the goal is `Log in as {user} with {password}`, `password` is secret with value `hunter2`, `user` is not secret with value `alice`, and the model answers `fill e5 "{password}"` on a password input
- **THEN** the goal sent reads `Log in as alice with {password}`, the field receives `hunter2`, and no request to the model contains `hunter2`

#### Scenario: Password value masked in the outline
- **WHEN** the outline is built after the password field was filled
- **THEN** the field's line shows `value="***"`

#### Scenario: Secret echoed on the page
- **WHEN** `user` is secret with value `alice@x.test` and the page shows `Signed in as alice@x.test`
- **THEN** the outline line reads `Signed in as {user}`

#### Scenario: Placeholder into a non-text element
- **WHEN** the model answers `fill e3 "{password}"` and `e3` is a checkbox
- **THEN** nothing is filled and the result says secret placeholders can only be typed into a text field

### Requirement: Submit confirmation
Before executing a `click` or `press` action, the runner SHALL decide whether the action would submit:
- a click on a `button` whose type is absent or `submit`, or on an `input` of type `submit` or `image`, that belongs to a `form` whose `method` is `post`;
- a press of Enter on a text field that belongs to such a form, or, without a ref, when the last `fill` of the step targeted such a field;
- a click on an element whose accessible name contains, as a whole word and case-insensitively, one of the runner's risk words: pay, buy, purchase, order, checkout, delete, remove, send, submit, confirm, subscribe, transfer, book, sign up, register, publish, post.

The effective submit policy SHALL be the run's `--submit` value when given, else the step's `submit`, else `ask`. For an action that would submit:
- with `allow`, the action SHALL be executed;
- with `stop`, the action SHALL NOT be executed and the step SHALL end as defined in "Termination";
- with `ask`, the runner SHALL hold attention as the flows capability does for `await-user`, with reason `confirm-submit`, the action's outline line as label, and the run's guard timeout budget, and SHALL execute the action once the user allows it. When the budget runs out the run SHALL fail with reason `paused` and exit 2, and Abort SHALL fail it with `aborted`.

A runner with no way to ask the user SHALL treat `ask` as `stop`. Actions that would not submit SHALL run without a pause.

#### Scenario: Order needs a person
- **WHEN** an agent step with the default policy clicks `[e9] button "Place order"` inside a POST form, and the user presses Allow in the banner
- **THEN** the run holds attention with reason `confirm-submit` until Allow, then clicks the button, and the turn's entry has `submit` `asked`

#### Scenario: Search is not a submit
- **WHEN** the model clicks `button "Search"` in a form with method GET
- **THEN** the click runs without a pause

#### Scenario: Recipe allows submits
- **WHEN** a step has `submit` `allow` and the model clicks `button "Send"`
- **THEN** the click runs without a pause and the turn's entry has `submit` `allowed`

#### Scenario: Nobody answers
- **WHEN** the policy is `ask`, a submit is asked, and the guard budget runs out
- **THEN** the button is not clicked and the run fails with `paused` and exit 2
