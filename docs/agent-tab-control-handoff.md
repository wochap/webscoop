# Handoff: Interactive Agent Tab Control & Direct Automation

Written from an explore session on 2026-11-05. This document specifies the design, protocol extensions, CLI commands, and implementation plan for external AI agents (Claude Code, Antigravity/AGY, Codex) to interactively control Webscoop browser tabs without authoring recipes.

---

## 1. Executive Summary & Decisions Taken

### The Problem
Currently, Webscoop requires users or agents to execute pre-recorded or pre-authored YAML recipes ([`packages/core/src/recipe/`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/core/src/recipe)). While effective for static and repetitive scraping, recipes are rigid for dynamic, exploratory, or multi-faceted scraping tasks where an external LLM agent needs to:
1. Open multiple tabs to parallelize work across one shared warm browser profile.
2. Inspect open tabs and popups dynamically using compact accessible outlines (`[e1]`, `[e2]`).
3. Click filters, fill inputs/selects/comboboxes, press keys, scroll, or evaluate JavaScript expressions on the fly.
4. Directly save downloads into target paths (`--out <filepath>`) relative to the caller's working directory.
5. Request user attention on a specific tab when a login wall or CAPTCHA appears on a Wayland desktop.
6. See visual feedback in real-time on a Wayland headed desktop without disrupting the user.

### Decisions Taken
1. **Primary Interface: CLI Tab Control (`webscoop tab ...` / `webscoop tabs`)**:
   - Chosen over raw CDP or standalone MCP server because every agent harness (Claude Code, AGY, Codex, terminal) has immediate shell execution tools (`rtk webscoop tab ...`). Zero agent-specific MCP configuration needed.
2. **Action Parity with `agent-step`**:
   - Exposes the full action vocabulary already built for [`agent-step`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/openspec/specs/agent-step/spec.md) (`open`, `goto`, `back`, `outline`, `find`, `html`, `click`, `fill`, `press`, `scroll`, `eval`, `download`, `attend`, `close`) so agents rarely need raw JS `eval` for standard UI interactions.
3. **Stateful Ref Caching Across CLI Calls**:
   - Because each `webscoop tab ...` command runs in a fresh CLI process, the daemon caches the latest [`Outline`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/core/src/agent/outline.ts#L31) per tab. When a subsequent command targets a ref like `e12` or `[e12]`, the daemon resolves it via the cached `AnnotatedNode` and [`refForNode()`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/core/src/selectors/xpath.ts#L33).
4. **Download Handling: Direct Target `--out <path>`**:
   - The CLI resolves `--out <filepath>` against the client's `io.cwd` before messaging the daemon. The daemon ensures parent directories exist, intercepts the browser download via [`DownloadSaver`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/browser/src/playwright-browser.ts#L175) (or triggers a download from a target/URL), moves the completed file to the exact destination path, fires `download.saved` hooks, and returns metadata (`file`, `bytes`, `url`).
5. **Multi-Tab Concurrency & Lifecycle**:
   - Interactive tabs are held in the profile's [`Slot`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/cli/src/daemon/scheduler.ts#L130) alongside `coldTabs`. They keep the browser open (`Slot.held = true`) without consuming `daemon.concurrency.total` recipe job slots while idle between commands. Popups opened by an interactive tab (`session.onPopup`) are automatically registered in the tab registry with `isPopup: true` and `openerTabId`.
6. **Visual Feedback: Enabled by Default**:
   - Click ripples (expanding circle at pointer coords), pointer motion trails, and targeted element bounding-box flashes (250ms pulse before interaction) rendered via an isolated closed shadow-root custom element `<webscoop-visuals>` on `document.documentElement`. Controlled via `--visual` / `--no-visual`.
7. **Wayland Desktop Environment & Attention Integration**:
   - Always runs headed Chromium (never fully headless). Kept hidden by default via compositor rules / [`packages/cli/src/hooks.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/cli/src/hooks.ts) (`browser.hide`). When an agent encounters a wall or invokes `webscoop tab attend <tabId>`, it acquires the profile browser's [`AttentionGate`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/cli/src/daemon/scheduler.ts#L82), brings the tab to the front, shows the guard banner, fires `attention.needed`, and waits until the user solves it.

---

## 2. North Star Scenario: Incompetech Royalty-Free Music

The canonical task guiding this feature:
- URL: `https://incompetech.com/music/royalty-free/music.html`
- Goal: Filter and download 10 songs for `genre: contemporary + feel: calming`, and 10 songs for `genre: contemporary + feel: driving`.
- Write song metadata (title, artist, license, attribution, mood, bpm, file) to `tracks.yaml`.

```
+--------------------------------------------------------------------------+
|                              AI AGENT                                    |
|                (Claude Code / Antigravity / Codex)                       |
+--------------------------------------------------------------------------+
       |                                                    |
       | Tab 1 Commands                                     | Tab 2 Commands
       v                                                    v
+------------------------------------+   +---------------------------------+
| Tab 1 (Contemporary + Calming)     |   | Tab 2 (Contemporary + Driving)  |
| - webscoop tab open <url>          |   | - webscoop tab open <url>       |
| - webscoop tab outline tab_1       |   | - webscoop tab outline tab_2    |
| - webscoop tab click tab_1 e12     |   | - webscoop tab click tab_2 e12  |
| - webscoop tab fill tab_1 e15 ...  |   | - webscoop tab fill tab_2 e15 ..|
| - webscoop tab eval tab_1 "..."    |   | - webscoop tab eval tab_2 "..." |
| - webscoop tab download tab_1 e42  |   | - webscoop tab download tab_2   |
|   --out ./calm/track01.mp3         |   |   e42 --out ./driving/track01...|
+------------------------------------+   +---------------------------------+
                   \                                      /
                    \____________________________________/
                                       |
                                       v
+--------------------------------------------------------------------------+
|             WEBSCOOP DAEMON & HEADED CHROMIUM (Wayland)                  |
|  - Shared persistent profile & Slot.interactiveTabs                      |
|  - Per-tab cached Outline (maps e1..eN -> AnnotatedNode -> XPath)        |
|  - Visual action feedback (<webscoop-visuals> closed shadow root)        |
|  - Headed window hidden unless `tab attend` / attention needed           |
+--------------------------------------------------------------------------+
                                       |
                                       v
+--------------------------------------------------------------------------+
|                           LOCAL FILESYSTEM                               |
|  - ./calm/*.mp3                                                          |
|  - ./driving/*.mp3                                                       |
|  - ./tracks.yaml                                                         |
+--------------------------------------------------------------------------+
```

---

## 3. Architecture & Daemon Protocol Extensions

### 3.1 Daemon Interactive Tab Registry & Scheduler Integration

In [`packages/cli/src/daemon/scheduler.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/cli/src/daemon/scheduler.ts), extend `Slot` and `Scheduler` to manage interactive tabs alongside recipe jobs and cold tabs:

```
+--------------------------------------------------------------------------+
|                         Scheduler Slot (per profile)                     |
+--------------------------------------------------------------------------+
|  browser: LaunchedBrowser | null                                         |
|  running: Map<runId, Entry>         (active recipe runs, capped)         |
|  queue: Entry[]                     (waiting recipe runs)                |
|  coldTabs: Map<recipe, ColdTab>     (walled tabs waiting for user)       |
|  interactiveTabs: Map<tabId, InteractiveTab>  <-- NEW                    |
|  attention: AttentionGate           (shared across jobs & tabs)          |
+--------------------------------------------------------------------------+
```

- **`InteractiveTab` State**:
  - `tabId: string` (sequentially assigned: `tab_1`, `tab_2`, ...)
  - `profile: string` and `profileDir: string`
  - `session: InteractiveSession` (created via `browser.newSession({ bypassCSP: true, humanize })`)
  - `visual: boolean` (whether visual feedback is active on this tab)
  - `isPopup: boolean` and `openerTabId?: string` (popups opened from `session.onPopup` are automatically wrapped and registered in `interactiveTabs` so the agent can see and control them in `webscoop tabs`)
  - `lastOutline: Outline | null` and `outlineUrl: string | null` (cached from the most recent `tab outline` or `tab find` call; used to resolve `e<n>` refs across separate CLI invocations)
  - `history: string[]` (in-tab document history seeded with initial URL, supporting `tab back`)
  - `lastActiveAt: number` (updated on every command; idle reaper closes tabs untouched for `daemon.idleTabTimeoutMs`, default 30 minutes)
  - `lock: Promise<void>` (per-tab operation mutex so concurrent CLI calls targeting the *same* `tabId` serialize cleanly while calls to *different* `tabId`s run in parallel)
- **Browser Lifecycle & `Slot.held`**:
  - Update `Slot.held` to `return this.busy || this.coldTabs.size > 0 || this.interactiveTabs.size > 0;`.
  - Interactive tabs do **not** occupy `daemon.concurrency.total` slots while idle, allowing multiple tabs and recipe runs to coexist even when `concurrency.total` is `1`.
  - When `webscoop tab open` is called on a profile with no open browser, the scheduler launches the profile's shared browser (acquiring the profile lock and firing `browser.starting` / `browser.started` hooks, just like `DaemonJob.launch`).
  - When the last interactive tab closes (and no jobs or cold tabs remain), `afterJob(slot)` starts the normal `slot.idleTimer` to close the browser and exit the daemon after `daemon.idleMs`.
- **Status & Exclusive Commands (`record`, `edit`, `bench`)**:
  - Extend [`BrowserStatus`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/cli/src/daemon/protocol.ts#L27) with `tabs: { tabId: string; url: string; title: string; isPopup: boolean }[]` so `webscoop daemon status` shows open interactive tabs.
  - Update `Scheduler.usage()` and `Scheduler.release()` so exclusive commands (`record`, `edit`, `bench`) warn when interactive tabs are open on the profile and close them cleanly when confirmed or passed `--force`.

### 3.2 Target Resolution (`<target>`)

Commands that take a `<target>` (`click`, `fill`, `press`, `html`, `download`) resolve it in order:
1. **Outline Ref (`e12` or `[e12]`)**:
   - Matches `/^\[?(e\d+)\]?$/`.
   - Looks up `node = tab.lastOutline?.node(ref)`. If `tab.lastOutline` is missing, or the ref is not in `lastOutline`, or [`refForNode(tab.session, node)`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/core/src/selectors/xpath.ts#L33) returns `null` (DOM mutated), fails with a clear error instructing the agent to run `webscoop tab outline <tabId>` to refresh refs.
2. **Explicit Strategy Prefix (`css=...`, `xpath=...`, `text=...`, `role=...`, `id=...`, `testid=...`)**:
   - Passes the corresponding [`SelectorCandidate`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/core/src/recipe/schema.ts) to `session.resolve(candidate)`.
3. **XPath Shorthand**:
   - Starts with `/` or `./` or `(/`: resolved with `strategy: 'xpath'`.
4. **Default CSS Selector**:
   - Any other string (e.g. `#genre-toggle`, `button.download`): resolved with `strategy: 'css'`.

### 3.3 Session & Port Enhancements ([`packages/core/src/ports.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/core/src/ports.ts) & [`packages/browser/src/playwright-browser.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/browser/src/playwright-browser.ts))

1. **Return Value from `evaluate`**:
   - Update [`InteractiveSession.evaluate`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/core/src/ports.ts#L262) from `evaluate(source: string): Promise<void>` to `evaluate(source: string): Promise<unknown>`.
   - In [`PlaywrightSession.evaluate`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/browser/src/playwright-browser.ts#L835), return the result of `this.mainWorldEvaluate(source)`. Handle both expressions (`document.title`) and IIFEs/statements by evaluating in the page's main world and serializing the return value.
2. **Page Title Helper**:
   - Add `title(): Promise<string>` to [`Session`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/core/src/ports.ts#L88) (implemented via `this.page.title()` in `PlaywrightSession`) so `tab.list` and `tab.outline` can read the current title without a full `settle()` or `goto()`.
3. **Direct Destination Download (`--out <filepath>`)**:
   - Currently, [`DownloadSaver`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/browser/src/playwright-browser.ts#L175) saves every download into `this.dir` and `DownloadQueue.rename` only renames within `this.dir` (and `downloadNameProblem` forbids `/` in recipe download names).
   - For `tab.download`:
     - The CLI client resolves `--out <filepath>` against `io.cwd` into an absolute `outPath` before sending the request to the daemon.
     - In the daemon, `tab.download` marks the download queue (`const since = session.downloadMark()`), triggers the click on `<target>` (or navigates to `<url>` if `--url` is used), awaits `const saved = await session.nextDownload({ since, timeoutMs })`, ensures `mkdir(dirname(outPath), { recursive: true })`, and moves `saved.file` to `outPath` (using `rename`, falling back to `copyFile` + `unlink` if across filesystems `EXDEV`).
     - Fires the `download.saved` hook with `{ file: outPath, name: basename(outPath), url: saved.url, bytes: saved.bytes }`.

### 3.4 Protocol Messages ([`packages/cli/src/daemon/protocol.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/cli/src/daemon/protocol.ts))

Extend `ClientMessage` and `DaemonMessage` with interactive tab request/response variants:

```typescript
export type TabSummary = {
  tabId: string;
  profile: string;
  url: string;
  title: string;
  isPopup: boolean;
  openerTabId?: string;
};

export type TabActionRequest =
  | {
      type: 'tab.open';
      url?: string;
      profile?: string;
      visual?: boolean;
      humanize?: boolean;
      timeoutMs?: number;
      cwd: string;
      env: Record<string, string>;
    }
  | { type: 'tab.list'; profile?: string }
  | { type: 'tab.goto'; tabId: string; url: string; timeoutMs?: number }
  | { type: 'tab.back'; tabId: string; timeoutMs?: number }
  | { type: 'tab.outline'; tabId: string; budgetTokens?: number }
  | { type: 'tab.find'; tabId: string; text: string }
  | { type: 'tab.html'; tabId: string; target: string }
  | { type: 'tab.click'; tabId: string; target: string; visual?: boolean; timeoutMs?: number }
  | { type: 'tab.fill'; tabId: string; target: string; value: string; visual?: boolean; timeoutMs?: number }
  | { type: 'tab.press'; tabId: string; key: string; target?: string; visual?: boolean; timeoutMs?: number }
  | { type: 'tab.scroll'; tabId: string; direction: 'down' | 'up' | 'bottom'; timeoutMs?: number }
  | { type: 'tab.eval'; tabId: string; expression: string }
  | {
      type: 'tab.download';
      tabId: string;
      /** Element ref/selector to click, or omitted when `url` is given. */
      target?: string;
      /** Direct download URL to trigger, when not clicking an element. */
      url?: string;
      /** Absolute destination file path (resolved against client CWD). */
      outPath: string;
      visual?: boolean;
      timeoutMs?: number;
    }
  | { type: 'tab.attend'; tabId: string; reason?: string; timeoutMs?: number }
  | { type: 'tab.close'; tabId?: string; profile?: string; all?: boolean };

export type TabActionResponse =
  | { type: 'tab.opened'; tab: TabSummary }
  | { type: 'tab.list'; tabs: TabSummary[] }
  | { type: 'tab.page'; tabId: string; url: string; title: string; message: string; newPopups?: TabSummary[] }
  | { type: 'tab.outline'; tabId: string; url: string; title: string; outline: string; cut: number }
  | { type: 'tab.find'; tabId: string; matches: string[] }
  | { type: 'tab.html'; tabId: string; html: string }
  | { type: 'tab.eval'; tabId: string; result: unknown }
  | { type: 'tab.download'; tabId: string; file: string; bytes: number; url: string }
  | { type: 'tab.closed'; closed: string[] }
  | { type: 'tab.error'; message: string; exitCode?: number };
```

---

## 4. CLI Command Specification

Implemented in [`packages/cli/src/commands/tab.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/cli/src/commands/tab.ts) and registered in [`packages/cli/src/main.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/cli/src/main.ts).

### `webscoop tab open [url]`
- Flags: `--profile <name>`, `--visual / --no-visual` (default: `--visual`), `--humanize / --no-humanize`, `--timeout <ms>` (default: `30000`), `--json`
- Behavior: Ensures daemon is running, launches or reuses the profile's shared browser, opens a new tab with `bypassCSP: true`, injects the visual feedback overlay (when `--visual`), navigates to `[url]` if provided, and prints the tab summary.
- Output (text): `tab_1  https://incompetech.com/music/royalty-free/music.html  "incompetech Music"`
- Output (`--json`): `{ "tabId": "tab_1", "profile": "default", "url": "...", "title": "...", "isPopup": false }`

### `webscoop tabs` (alias: `webscoop tab list`)
- Flags: `--profile <name>`, `--json`
- Behavior: Queries a running daemon (without starting one if none runs) for all active interactive tabs and their popups.
- Output (`--json`):
  ```json
  [
    { "tabId": "tab_1", "profile": "default", "title": "incompetech Music", "url": "https://incompetech.com/music/royalty-free/music.html", "isPopup": false },
    { "tabId": "tab_2", "profile": "default", "title": "incompetech Music", "url": "https://incompetech.com/music/royalty-free/music.html", "isPopup": false }
  ]
  ```

### `webscoop tab goto <tabId> <url>` & `webscoop tab back <tabId>`
- Flags: `--timeout <ms>`, `--json`
- Behavior: Navigates `<tabId>` to `<url>` (appending to tab history) or pops the tab history and navigates back, invalidating `lastOutline` and printing the new URL and title.

### `webscoop tab outline <tabId>`
- Flags: `--budget <tokens>` (default: `12000`, or `0` for uncut), `--json`
- Behavior: Takes a DOM snapshot of `<tabId>`, builds the accessible outline via [`buildOutline()`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/core/src/agent/outline.ts#L179), caches the `Outline` in the daemon for `<tabId>`, and prints the URL, title, and bracketed ref lines matching the [`agent-step`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/openspec/specs/agent-step/spec.md) format:
  ```text
  URL: https://incompetech.com/music/royalty-free/music.html
  Title: incompetech Music
  [e1] button "Filter by Genre"
  [e2] button "Filter by Feel"
  [e3] textbox "Search" value=""
  [e4] button "⬇ Download"
  ```

### `webscoop tab find <tabId> <text>`
- Flags: `--json`
- Behavior: Searches all lines of `<tabId>`'s cached outline (taking a fresh snapshot first if none is cached) case-insensitively across accessible name, text, and `href`, returning up to 20 matching `[e<n>] ...` lines (including lines cut by the token budget).

### `webscoop tab html <tabId> <target>`
- Flags: `--json`
- Behavior: Resolves `<target>` (ref `e<n>` or selector) and prints its outer HTML (capped at `2000` characters, matching [`outerHtml`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/core/src/agent/actions.ts#L133)).

### `webscoop tab click <tabId> <target>`
- Targets: Outline ref (`e12` or `[e12]`), CSS selector, XPath (`/html/...` or `./...`), or prefixed selector (`role=button|Search`, `text=Calming`).
- Flags: `--visual / --no-visual`, `--timeout <ms>`, `--json`
- Behavior: Resolves target, flashes bounding box and click ripple (if visual), clicks element, waits for `session.settle()`, registers any newly opened popups as `tab_<n>`, and reports URL/title/popup/download changes.

### `webscoop tab fill <tabId> <target> <value>`
- Flags: `--visual / --no-visual`, `--timeout <ms>`, `--json`
- Behavior: Resolves target, flashes bounding box, and delegates to [`Session.fill()`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/core/src/ports.ts#L118) (automatically handling text inputs, `<select>` options by value or label, combobox options, checkboxes/radios with `true`/`false`, and file inputs), then waits for `session.settle()`.

### `webscoop tab press <tabId> <key> [target]`
- Flags: `--visual / --no-visual`, `--timeout <ms>`, `--json`
- Behavior: Presses `<key>` (e.g., `Enter`, `Escape`, `Tab`, `ArrowDown`) on `[target]` (or the focused element when omitted) and waits for `session.settle()`.

### `webscoop tab scroll <tabId> <direction>`
- Arguments: `<direction>` is `down`, `up`, or `bottom`.
- Flags: `--timeout <ms>`, `--json`
- Behavior: Scrolls the viewport via `session.scrollBy()` or `session.scrollToBottom()` and waits for `session.settle()`.

### `webscoop tab eval <tabId> <expression>`
- Flags: `--json`
- Behavior: Evaluates `<expression>` in the tab's main world via `session.evaluate()` and prints the result (raw string when primitive and `--json` is not set, or JSON-serialized output).

### `webscoop tab download <tabId> [target] --out <filepath>`
- Flags: `--out <path>` (required), `--url <directUrl>` (alternative to `[target]`), `--visual / --no-visual`, `--timeout <ms>` (default: `30000`), `--json`
- Behavior:
  1. Resolves `--out` against the client's `io.cwd` to an absolute path.
  2. Records `session.downloadMark()` on `<tabId>`.
  3. Either clicks `[target]` (with visual feedback) or triggers navigation to `--url`.
  4. Waits for `session.nextDownload({ since, timeoutMs })`, creates parent directories (`mkdir -p`), moves the downloaded file to `outPath`, fires `download.saved` hooks, and outputs the result.
- Output (`--json`):
  ```json
  { "tabId": "tab_1", "file": "/abs/path/to/calm/track01.mp3", "bytes": 5214012, "url": "https://incompetech.com/music/royalty-free/mp3-royaltyfree/..." }
  ```

### `webscoop tab attend <tabId>`
- Flags: `--reason <text>` (default: `"agent requested user attention"`), `--timeout <ms>` (default: `600000`), `--json`
- Behavior: Acquires the profile browser's `AttentionGate` for `<tabId>`, focuses `<tabId>`, shows the in-page guard banner, fires `attention.needed` hooks (which unhide the Wayland window via `browser.show` / user hook config), prompts `Solved? [Y/n/a]` if attached to a TTY (or waits for banner Continue / `webscoop attention continue`), and releases attention once resolved.

### `webscoop tab close [tabId]`
- Flags: `--all`, `--profile <name>`, `--json`
- Behavior: Closes `<tabId>` (and any popups it opened) and removes it from the daemon's `interactiveTabs` registry. With `--all`, closes all interactive tabs (optionally filtered by `--profile`).

---

## 5. Visual Feedback System

Implemented in [`packages/inject/src/visual-feedback.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/inject/src/visual-feedback.ts) (or bundled inline for `PlaywrightSession` injection) following the isolation conventions of [`packages/inject/src/mount.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/inject/src/mount.ts).

### Mechanisms
1. **Isolated Shadow Root Host on `<html>`**:
   - Appends a custom element `<webscoop-visuals>` directly to `document.documentElement` (`<html>`, not `<body>`, with a `MutationObserver` re-attaching it if the page wipes `<html>` children, matching [`mount.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/inject/src/mount.ts#L108)).
   - Uses `#shadow-root (closed)` with `:host { all: initial; }` and a fixed overlay container (`position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; contain: strict;`).
   - Exposes `window.__webscoopVisuals` with methods `flashRect(rect, label?)`, `ripple(x, y)`, and `trail(from, to)` invoked by the session before pointer/keyboard actions.
2. **Target Element Flash**:
   - Measures target via [`session.geometry(ref)`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/browser/src/playwright-browser.ts#L885) after scrolling into view.
   - Renders a glowing bounding box (`border: 2px solid #9184d9; background: rgba(145, 132, 217, 0.16);`) with an optional small tag (e.g. `click e12` or `fill e15`) for 250ms prior to pointer dispatch.
3. **Action Ripple Animation**:
   - Coordinate ring created at pointer `(x, y)`:
     ```css
     @keyframes ws-ripple {
       0% { transform: translate(-50%, -50%) scale(0.2); opacity: 0.9; }
       100% { transform: translate(-50%, -50%) scale(2.2); opacity: 0; }
     }
     ```
   - Auto-removes DOM node on `animationend`.
4. **Motion Trail (Hover & Drag)**:
   - Subtle dot/line indicator that interpolates between previous and next pointer coordinates when moving across the viewport.

---

## 6. Implementation Phases

```
+--------------------------------------------------------------------------+
| Phase 1: Core & Browser Port Enhancements                                |
| - Update InteractiveSession.evaluate to return Promise<unknown>          |
| - Add Session.title() to ports.ts, playwright-browser.ts, fake-browser   |
| - Implement visual-feedback script & helper in @webscoop/browser         |
+--------------------------------------------------------------------------+
                                     |
                                     v
+--------------------------------------------------------------------------+
| Phase 2: Daemon Protocol & InteractiveTab Registry                       |
| - Extend packages/cli/src/daemon/protocol.ts with tab.* messages         |
| - Add InteractiveTab registry, Outline caching, popup auto-registration, |
|   Slot.held updates, and idle tab reaper to scheduler.ts & server.ts     |
+--------------------------------------------------------------------------+
                                     |
                                     v
+--------------------------------------------------------------------------+
| Phase 3: Target Resolution, Actions & Direct Download Routing            |
| - Resolve e<n> refs via cached Outline + refForNode, or selectors        |
| - Wire click, fill, press, scroll, goto, back, find, html, eval, attend  |
| - Route tab.download from DownloadSaver to client-resolved outPath       |
+--------------------------------------------------------------------------+
                                     |
                                     v
+--------------------------------------------------------------------------+
| Phase 4: CLI Commands (`webscoop tab` & `webscoop tabs`)                 |
| - Implement packages/cli/src/commands/tab.ts                             |
| - Register commands in packages/cli/src/main.ts & update daemon status   |
+--------------------------------------------------------------------------+
                                     |
                                     v
+--------------------------------------------------------------------------+
| Phase 5: Verification & End-to-End Tests                                 |
| - Unit tests for protocol, scheduler tab lifecycle, and ref caching      |
| - E2E tests: parallel multi-tab filtering, eval, & direct --out download |
+--------------------------------------------------------------------------+
```

---

## 7. Relevant Codebase References

- **Browser & Session Abstractions**: [`packages/core/src/ports.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/core/src/ports.ts) (`Session`, `InteractiveSession`, `BrowserPort`)
- **Playwright Session & DownloadSaver**: [`packages/browser/src/playwright-browser.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/browser/src/playwright-browser.ts) (`PlaywrightSession`, `SharedBrowser`, `DownloadSaver`, `bypassPageCSP`)
- **Agent Outline & Action Helpers**: [`packages/core/src/agent/outline.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/core/src/agent/outline.ts) (`buildOutline`, `Outline`) and [`packages/core/src/agent/actions.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/core/src/agent/actions.ts) (`outerHtml`, `refForNode`)
- **Daemon Server & Scheduler**: [`packages/cli/src/daemon/server.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/cli/src/daemon/server.ts) and [`packages/cli/src/daemon/scheduler.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/cli/src/daemon/scheduler.ts)
- **Daemon Client Link**: [`packages/cli/src/daemon/client.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/cli/src/daemon/client.ts)
- **Overlay & Shadow DOM Mounting**: [`packages/inject/src/mount.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/inject/src/mount.ts) and [`packages/inject/src/overlay.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/inject/src/overlay.ts)
- **Pointer & Humanized Movement**: [`packages/browser/src/humanize.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/browser/src/humanize.ts)
- **Wayland Window Hooks**: [`packages/cli/src/hooks.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/cli/src/hooks.ts) and [`packages/cli/src/commands/browser.ts`](file:///home/gean/Sandboxes/sandbox/projects/webscoop/packages/cli/src/commands/browser.ts)
