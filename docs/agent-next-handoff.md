# Handoff: agent step, next round (help text, navigation, trust)

Written 2026-10-15 from an explore session. Nothing here is implemented or
proposed in OpenSpec yet. Read `docs/agent-handoff.md` first; this file builds on
its "Follow-ups" list and changes some of its order.

## Decisions taken

- **Help text design: option C.** Inline `ws-meta` one-liners stay, a `?` hint is
  added per field, and real warnings are inline. No popover component yet.
- **Side effects: confirm before submit**, with a dry-run flag. Same mechanics as
  `await-user`.
- **Packaging: three changes, in this order.**
  1. `agent-step-help` (small, independent)
  2. `agent-navigate` (scope ladder + `back` + verifiable `until`)
  3. `agent-trust` (secret refs + confirm-before-submit + dry-run)

  Promotion of a run into recorded steps comes after these (see "Later").

## Open questions (not answered yet)

- **File uploads**: should the agent get an `upload` action for `<input type=file>`
  from a variable path? Not decided.
- **Entry field**: should it be a dropdown of the config's `llms` names? We have
  not checked whether the recorder can read the config.
- **Example goals**: should a `?` list two or three good goals?
- **`?` convention**: agent fields only for now, or recorder-wide? Leaning toward
  adding the `EditLine` prop now, using it on agent fields only, and spreading it
  later.

---

## Change 1: `agent-step-help`

### Current state

The whole editor is in `packages/inject/src/ui/flows.tsx`:

| Piece | Lines |
|---|---|
| `EditLine` (label + row; no hint prop) | 185-193 |
| `GoalField` (textarea + `{var}` chips) | 241-280 |
| `AgentLimits` (entry, turns) | 282-305 |
| `StepEditor` agent branch | 334-351 |
| Value row (only when `until === 'download'`) | 361-365 |
| Window row | 366-369 |
| Optional row | 383-386 |
| `StepMeta` collapsed summary | 83-89 |
| `VALUE_HINT.agent` | 33 |

The recorder has no tooltip or `?` component. It uses two hint patterns:

- a native `title=` attribute, in about 15 places (e.g. `flows.tsx:99`, `fields.tsx:33`, `tables.tsx:235`);
- `<span className="ws-meta">` after the control, plus `ws-tone-warn-text` for
  warnings (e.g. the await-user budget note at `flows.tsx:378-380`).

The panel is in a closed shadow root (`packages/inject/src/mount.ts:93`), so all
CSS goes in `packages/inject/src/styles.css` (`.ws-meta` L121, `.ws-edit-line`
L846, `.ws-edit-label` L847, `.ws-tone-warn-text` L848).

`scope` is not shown in the editor. `AGENT_SCOPES = ['page']`
(`packages/core/src/recipe/constants.ts:19`).

The recorder spec ("Steps list editing", `openspec/specs/recorder/spec.md:522-546`)
has no help-text requirement for agent fields. Wording to copy for hints is at
L1193 ("with a short hint that…") and L1306 ("SHALL explain…").

### Plan

1. Add an optional `hint` prop to `EditLine`. It renders a small focusable `?`
   that carries `title` and `aria-label`. No popover.
2. Make the one-liners sharper:

   | Field | Hint (`?`) | Inline meta |
   |---|---|---|
   | goal | The model sees the page outline and this goal; `{var}` values are sent to the model; the runner, not the model, decides success (except `until: done`) | none |
   | entry | A name from config `llms`; empty uses `--llm` or the default entry | none |
   | turns | Each turn is one LLM request; when the cap is reached the step ends as `max-turns` | "at most · 1 request each" |
   | until | download is checked by the runner; done is only the model's word | the existing text |
   | value | Save-as name for the download | none |
   | window | the existing text | the existing text |
   | optional | A required step that fails ends the run with `missing-required` (exit 3) | the existing text |

3. Add an **inline warning** when the goal contains a `secret` variable: "will be
   sent to the model". Change 3 replaces this with secret refs, so this stays
   until then.
4. Show scope as a read-only tag, "page only". Change 2 makes it a segmented
   control.
5. Spec delta: in `recorder` "Steps list editing", each agent field SHALL show a
   hint, and the secret warning gets its own scenario. Tests go in
   `packages/inject/test/flows.test.tsx`.

---

## Change 2: `agent-navigate`

### Why it is needed

The agent already has the actions it needs: click, fill (text, select, checkbox)
and press. What blocks forms, search and wizards is the scope gate in
`packages/core/src/agent/actions.ts:223-228`:

```ts
const left = stripFragment(now) !== stripFragment(this.ctx.startUrl);
if (left && !settled?.download) { /* 'the page was restored' */ info = await this.restore(); }
```

Any URL change except the `#fragment` is reverted to the start URL with
`session.goto`. This includes:

- a form POST that loads a thank-you page (the form state is lost);
- `?q=` and `?page=2`;
- SPA `pushState` routes.

Only SPAs that submit in place work today. Popups are closed unless they produced
a download (L209-217).

### Scope ladder

| scope | Allowed | Use |
|---|---|---|
| `page` | Start URL only (today's behaviour, stays the default) | PDF download |
| `site` (new) | Any HTML document on the same origin; path and query may change | Forms, search, wizards |
| `domain` | Same registrable domain (e.g. `login.x.com` → `app.x.com`) | Auth hops (follow-up 3 in the old handoff) |

- The gate code stays the same with a predicate per scope. Asset URLs and other
  hosts are still undone, and popups are still closed.
- `startUrl` becomes a history stack. A new `back` action pops it, and `restore()`
  goes to the top of the stack.
- The outline re-roots on each new document. The turn report says "now at <path>"
  (the existing `The page URL is now …` branch).
- Decide whether `domain` ships in this change or stays reserved. `site` is the
  must-have.

### Verifiable ends

| until | Ends when | Note |
|---|---|---|
| `download` | A download of this window was saved | exists |
| `appears <target>` (new) | A target resolves; same shape as step targets | Reuse the await-user condition check. This is follow-up 2 in the old handoff. |
| `url <glob>` (new) | The current URL matches | Trivial |
| `done` | The model says so | Keep it; the help text warns that it cannot be checked |

Spec touch points: `steps` (scope values, until variants), `agent-step` (gate
predicate, `back`, history, end reasons), `recorder` (scope and until editors,
hints), `ai-skill`.

---

## Change 3: `agent-trust`

### Secret refs (replaces "reject secrets in goal", follow-up 6)

The model sees only placeholders, and the runner expands them:

```
goal sent:    "Log in with {username} / {password}, then download the invoice"
model acts:   fill e4 "{password}"
runner:       expands {password} -> real value -> page
outline:      password inputs show value=•••
```

- Never put the expanded secret in history, transcript, report or stderr.
- Refuse a secret `fill` into a field on a host other than the step's start host.
  Consider also refusing secrets typed into non-password fields.
- Once this lands, remove the change-1 warning, or turn it into "sent as a
  reference".

### Confirm before submit (decided: option b, with c as a flag)

- **Trigger.** Before executing an action that would submit a form, or click a
  control whose accessible name matches a risk list (pay, buy, order, delete,
  send, submit, confirm…), pause the way `await-user` does. Show "agent wants to
  click 'Place order'", then allow or deny.
- **Denied.** The model is told so and may try something else, or the step ends
  with a new reason such as `denied`.
- **Headless.** Fail, unless `--yes` or a recipe field (e.g. `confirm: never`)
  allows it.
- **Dry-run** (flag, e.g. `--dry-run` or `confirm: dry-run`). Stop at the first
  action that would trigger a confirm, with end reason `ready-to-submit`. Good for
  testing recipes on real sites.
- **Open.** How should "would submit" be detected: from the outline role and form
  ancestry, or from the button `type`? Also decide where the risk list lives:
  hardcoded, or in config.

---

## Later: promote a run to recorded steps

After a successful run, generate selectors for every acted ref in the transcript
with the existing healing and selector code. The recorder then offers "replace
agent step with N recorded steps", and the next run needs no model. This makes
the old follow-ups 4 (per-domain cache) and 1A (agent picks, runner extracts) one
mechanism. Extraction (old follow-up 1) is still the biggest win for scraping,
and it can slot in after change 2.

## How to pick this up

```
/openspec-propose agent-step-help      # start with change 1; this file has the plan
```

Then `agent-navigate`, then `agent-trust`. For each one, re-read the code at the
line numbers above. They were correct on `cfff6a5` and may have moved.
