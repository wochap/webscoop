# agent-tab-control Specification

## Purpose

Enables external AI coding agents to discover, open, inspect, navigate, manipulate, and download from interactive browser tabs and popups across CLI commands without writing recipes.

## Requirements

### Requirement: Interactive tab lifecycle and multi-tab concurrency
The system SHALL support opening, tracking, and closing interactive browser tabs keyed by unique identifier (`tabId`). Multiple interactive tabs SHALL be capable of remaining open simultaneously within a single browser profile. Interactive tabs SHALL remain open across multiple command invocations until explicitly closed by the agent, until the daemon is stopped, or until an idle timeout of `daemon.idleTabTimeoutMs` (default: 1800000 ms / 30 min) expires without activity. Interactive tabs SHALL NOT count toward `daemon.concurrency.total` while waiting between commands.

#### Scenario: Agent opens multiple tabs for concurrent work
- **WHEN** an agent opens `tab_1` and then opens `tab_2` in the same profile
- **THEN** both tabs remain open concurrently in the shared browser and can be addressed independently by their IDs

#### Scenario: Closing an interactive tab
- **WHEN** an agent issues a close command for `tab_1`
- **THEN** `tab_1` is closed and removed from active tab tracking while other open tabs remain unaffected

### Requirement: Stateful outline reference caching
The system SHALL take snapshots of an interactive tab's document upon request, produce a compact accessible outline matching the `agent-step` format with bracketed element references (`[e1]`, `[e2]`, ...), and cache the resulting node mapping in the daemon for that tab. When a subsequent action command specifies a reference in the form `e<n>` or `[e<n>]`, the system SHALL resolve the reference against the tab's cached outline. If the tab's document has navigated or mutated such that the reference cannot be resolved, the system SHALL return a distinct error indicating that references are stale and instructing the agent to refresh the outline.

#### Scenario: Action referencing cached outline element
- **WHEN** an agent requests an outline for a tab and then issues a click command specifying reference `e14`
- **THEN** the system resolves `e14` from the cached outline and executes the click on that element

#### Scenario: Stale reference error on page navigation
- **WHEN** a tab navigates to a new page and the agent attempts an action using a reference from the previous page's outline
- **THEN** the action fails with an error indicating the reference is stale and prompt for a fresh outline

### Requirement: Tab actions and DOM evaluation
The system SHALL provide interactive tab actions corresponding to standard automation primitives: `goto`, `back`, `click`, `fill`, `press`, `scroll`, `find`, `html`, and `eval`. Targets for interaction SHALL support outline references (`e<n>`), CSS selectors, and XPath expressions. `eval` SHALL execute JavaScript in the tab's main document context and serialize the return value as JSON. Interactive tab actions targeting the same tab SHALL serialize operations to prevent race conditions, while actions targeting different tabs SHALL execute concurrently.

#### Scenario: Evaluating JavaScript in a tab
- **WHEN** an agent evaluates `document.title` on an interactive tab
- **THEN** the system returns the string title of the current page

#### Scenario: Filling form controls and dropdowns
- **WHEN** an agent fills an input or selects a dropdown option by target selector and value
- **THEN** the element is updated according to its control type and the page settles

### Requirement: Direct destination download routing
The system SHALL support downloading files directly from an interactive tab to a specified filesystem destination via `--out <filepath>`. The system SHALL resolve the destination path relative to the client's working directory, create any missing parent directories, await the completion of the download, move the resulting file to the exact target path, and return confirmation metadata including final path, byte count, and source URL.

#### Scenario: Downloading a file to a nested folder
- **WHEN** an agent invokes a download on an element specifying `--out ./calm/track01.mp3`
- **THEN** the directory `./calm` is created if absent, the downloaded file is saved at `./calm/track01.mp3`, and its size is reported

### Requirement: Visual action feedback
Interactive tabs SHALL support visual action feedback on headed displays. When visual feedback is enabled, the system SHALL inject a non-interfering closed shadow-root overlay (`<webscoop-visuals>`) on `document.documentElement`. The overlay SHALL render expanding ripple circles at pointer coordinates upon clicks, motion trails during drags and pointer moves, and a bounding-box highlight outline around targeted elements for 250 milliseconds immediately prior to interaction dispatch. Visual feedback SHALL be enabled by default and SHALL be suppressible via `--no-visual`.

#### Scenario: Visual indicator rendered on click
- **WHEN** an agent performs a click with visual feedback active
- **THEN** the target element flashes a highlight box and a click ripple animation appears at the click coordinates

### Requirement: Popup registration and tracking
When an interactive tab opens a popup window or new tab via `window.open` or link targets, the system SHALL automatically intercept the popup, register it as a tracked interactive tab with an assigned ID and `isPopup: true` referencing its opener tab ID, and make it immediately discoverable and controllable by the agent.

#### Scenario: Agent interacts with a popup window
- **WHEN** an action in an interactive tab triggers a popup window
- **THEN** the popup appears in the active tabs list and the agent can issue actions directly to the popup tab ID

### Requirement: Attention escalation on interactive tabs
The system SHALL allow an agent to request user attention on an interactive tab via `attend`. Invoking `attend` SHALL acquire the browser's attention gate, bring the window to the front, trigger compositor focus hooks, display the in-page guard banner, and wait for confirmation via the terminal prompt or banner continue signal before releasing attention.

#### Scenario: Agent requests user attention for captcha
- **WHEN** an agent issues an attend command on an interactive tab facing a challenge
- **THEN** the browser window surfaces, the attention banner is displayed, and the command waits for user completion
