# Handoff: the `agent` step and its follow-ups

Written 2026-10-15 after three OpenSpec changes landed on `main`. Read this before
extending the agent step. Specs are the source of truth; this file explains the
why, what was verified, and what comes next.

## What shipped

| change | commits | summary |
|---|---|---|
| `llm-profiles` | `5835ae2`, sync `971ad7c` | Named LLM entries under config `llms`, `--llm <name>` on `run`/`test`/`bench`, `maxOutputTokens` + `maxTokensField`, per-model overrides, `effort`, retry with backoff on 429/502/503/504/529, key redaction, per-entry `doctor` probes. |
| `pdf-download` | `d912d76`, sync `466b0f5` | `browser.pdf` = `download` (default) or `view`; the Chromium preference `plugins.always_open_pdf_externally` is written into the profile before every launch; `--pdf` flag; `pdf` is part of the daemon's launch key; playground `/pdf` and `/pdf-links`. |
| `agent-step` | `f080338`, sync `e9d9697` | Step kind `agent`: goal, `llm` entry, `maxTurns`, `scope: page`, `until: download`; page outline with `e<n>` refs; actions `click fill press scroll find html wait done give_up`; scope gate; transcript in `step.replayed` and the report; recorder editing; `recipes --json` gains `agent` and `downloads`; skill updated. |

Specs: `openspec/specs/agent-step`, `steps`, `llm-adapter`, `browser-launch`,
`cli`, `recorder`, `ai-skill`. Archived change folders with proposal, design, and
tasks: `openspec/changes/archive/2026-10-15-{llm-profiles,pdf-download,agent-step}`.

Code: `packages/core/src/agent/{outline,actions,loop}.ts`, dispatch in
`packages/core/src/flows/replay.ts`, entry resolution in `packages/cli/src/llm.ts`
(`resolveLlm`), preference write in `packages/browser/src/playwright-browser.ts`
(`PDF_PREFERENCE`). Fixtures: `packages/cli/fixtures/playground-pdf-agent.json` and
`packages/cli/fixtures/llm/pdf-agent-*.json`. E2e: `e2e/agent.spec.ts`.

## How the step works, in one screen

```
goto(url) -> flow -> agent step
  loop (max maxTurns):
    outline  = snapshot of the step's window, one line per kept element, refs e1..eN
    answer   = completeJson(entry, [system, goal, ...history, outline], ActionSchema)
    result   = execute(action) ; settle ; guards ; scope gate (undo cross-document navigation)
    if until=download and a download of this window was saved -> ok (ends at once)
    history  = compress older turns, drop oldest until it fits contextTokens - maxOutputTokens - outline budget
  end reasons: download | condition | done | done-unmet | gave-up | max-turns | llm-error | invalid-answers | no-llm
  required step failed -> missing-required, exit 3 ; optional -> skipped
```

Design rules worth keeping:

- Success is decided by the runner, never by the model. `done` without `until`
  is the only exception, and it is the model's word.
- Scope is enforced by the executor, not by the prompt. The prompt repeats it.
- Refs are numbered in document order per observation so the mock script in e2e
  can be deterministic. Do not randomise them.
- Page text never reaches stderr beyond the single outline line of the acted ref.
- The model rung (healing) and the agent loop share `completeJson`, the hidden
  rules, and the role and accessible-name helpers. Keep it that way.

## Verified state

- Full unit suite on `e9d9697`: 1762 passed, 4 failed. The failures are headed
  browser tests (`packages/browser/test/playwright-browser.test.ts` "keeps only
  its own tab", `packages/inject/test/live.test.ts` live recorder picks). The same
  tests also fail on `9c38739`, before this work, when another browser owns the
  display. Treat them as environmental until seen on a quiet display.
- The e2e suite was run by the pipeline's apply agents, not independently. Run
  `npm run test:e2e -- agent pdf` on a quiet display before relying on it.
- PDF behaviour was confirmed by a spike (local server, headed Playwright
  Chromium): with the preference, every path downloads, including
  `target=_blank` and `window.open` popups that then close themselves. Without
  it, inline navigation, plain links, and popups show the viewer and fire no
  download event.

## What the agent cannot do yet

- **Scrape.** No action produces rows. An agent-only recipe prints only the
  `downloads` table.
- **Leave the page.** `scope: domain` is reserved in the schema and rejected.
- **End on a visible condition.** Only `until: download` exists.
- **Keep secrets from the model.** A `secret` variable used in `goal` is sent
  in the prompt. Record logins as `fill` steps or use a guard instead.
- **Learn.** A successful run leaves nothing behind for the next run on the
  same domain.

## Follow-ups, in recommended order

### 1. Agent-driven extraction (biggest value)

Two mechanisms; build A, allow B per table.

**A. Agent picks, runner extracts.** A table declared with fields but no
selectors. New `until: resolves <table>`. The agent names refs for the item
container and one example of each field (new action, e.g.
`locate { table, item: ref, fields: { name: ref } }`). The runner then: generates
selectors with the existing selector-generation code, verifies each field
selector resolves in at least half of the containers (same rule as the model
rung's pick verification), extracts deterministically, and promotes the
selectors on write-back. Second run needs no model. This is the recorder's job
done by the agent once, and it is the natural home for per-domain learning.

**B. Agent fills values.** `fill: "model"` on a page-scoped table: an `extract`
action answers a JSON object validated against the field names and types. Only
for pages with no repeating structure. Every run costs model calls; numbers and
dates come from the model, so keep the type converters in the loop.

Spec touch points: `steps` (new `until`), `recipe-format` (table without
selectors), `agent-step` (new actions), `healing` (promotion from an agent
pick), `runner` (extract after resolve).

### 2. `until: appears <target>`

Ends the loop when a target (selector candidates, same shape as step targets)
resolves. Gives forms a verifiable end: "submit, until the thank-you banner
appears". Small change: the condition check already exists for `await-user`.

### 3. `scope: domain`

Same gate code with a looser predicate: allow navigations whose host matches
the start host and whose response is an HTML document; still undo asset URLs
and other hosts. Requires the outline to re-root on the new document and the
start URL to become a stack so `back` is meaningful. Add a `back` action.

### 4. Per-domain promotion cache

After a successful `until: download` run, store the acted ref's generated
selectors and fingerprint under the state dir keyed by recipe and host. Next
run on that host tries the cached target through the healing ladder before
starting the loop. Follow-up 1A makes this general; this is the cheap version
for downloads.

### 5. Cheaper rungs before the loop

For the PDF use case most pages do not need a model: try, in order, a
navigation that already downloaded, `a[href$=.pdf]` / `a[download]` /
`embed|iframe[type=application/pdf]` when exactly one matches, then a one-shot
model pick over the outline (one request, verified by the download), then the
loop. Report which rung won, as healing does.

### 6. Secrets in goals

Reject `secret` variables in `goal` at validation (like the URL template does),
and document the pattern: recorded `fill` for credentials, agent after.

### 7. Batch input

`webscoop run <recipe> --vars-file urls.jsonl` or stdin JSONL, one job per
line, through the daemon queue. Independent of the agent step; the PDF use
case is a list of URLs.

## References used

- wosarcher's LLM adapter (`/home/gean/Sandboxes/sandbox/projects/wosarcher`,
  `src/wosarcher/adapters/llm.py`, `http.py`, `config.py`): source of the
  named-entry, `max_tokens_field`, effort, and retry-budget shapes.
- Stagehand (`/home/gean/Sandboxes/sandbox/vendor/stagehand`,
  `packages/extension/understudy/a11y/snapshot/a11yTree.ts`): how it prunes the
  CDP accessibility tree into lines with ids. Not used as a dependency: it owns
  the browser and the model calls, which conflicts with the daemon and with
  picking the model per entry.
- The PDF spike script: session scratchpad `pdfspike/spike.mjs` (not in the
  repo). Re-creating it is ten minutes: a local HTTP server with inline,
  attachment, and octet PDF routes plus the four link forms, run twice with and
  without the preference in `Default/Preferences`.
