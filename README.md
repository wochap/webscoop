# webscoop

Record a scraper by clicking elements on a live page, then run it unattended
from the command line. The browser is a real, visible Chromium with a
persistent profile, so a site you log into once stays logged in.

This release has the recipe format, the `webscoop` CLI, a runner that heals
selectors and walks pages, the recorder (`webscoop record`), and a local
playground site for tests. Login and captcha guards arrive in a later change.

## Setup

Requirements: Linux with a Wayland or X11 desktop session. webscoop never runs
headless; tests open visible Chromium windows.

### With Nix (recommended on NixOS)

```sh
nix develop            # node 22 with npm, Chromium from nixpkgs
npm install
npm run build
```

The dev shell sets `PLAYWRIGHT_BROWSERS_PATH` to nixpkgs' Playwright
browsers, so no browser download is needed. nixpkgs' `playwright-driver`
version must equal the `playwright` version pinned in `package.json`
(currently 1.59.1); bump both together.

### Without Nix

Node 22 or newer (npm ships with it):

```sh
npm install
npx playwright install chromium
npm run build
```

### Tests

Tests run locally, from a desktop session:

```sh
npm run lint
npm test             # unit tests plus browser integration tests
npm run test:e2e     # builds the CLI and runs it against the playground
```

Browser integration tests are skipped when neither `WAYLAND_DISPLAY` nor
`DISPLAY` is set. Tests never need a language model: the model rung runs
against scripted answers (`WEBSCOOP_LLM_MOCK`, below). `e2e/llm.real.spec.ts`
runs `bench` on tiers 0 to 4 against a real model, only when
`WEBSCOOP_LLM_ENDPOINT` is set:

```sh
WEBSCOOP_LLM_ENDPOINT=http://127.0.0.1:11434/v1 WEBSCOOP_LLM_MODEL=qwen3.5:9b \
  npm run test:e2e -- llm.real
```

`e2e/window.spec.ts` moves a real browser window around a Hyprland desktop and
runs only when asked, from a Hyprland session:

```sh
WEBSCOOP_E2E_HYPRLAND=1 npm run test:e2e -- window
```

### Chromium override

To use a different Chromium binary, set `WEBSCOOP_CHROMIUM=/path/to/chrome`,
or `browser.executablePath` in the config file. `webscoop doctor` shows which
binary would be used and whether it starts.

### Install on NixOS

The flake exports the CLI as `packages.x86_64-linux.default`, wrapped with
Node and nixpkgs' Chromium:

```nix
# flake.nix of your system configuration
inputs.webscoop.url = "path:/path/to/webscoop"; # or a git URL
# ...
environment.systemPackages = [ inputs.webscoop.packages.x86_64-linux.default ];
```

Try it without installing: `nix run . -- doctor`. After changing
dependencies, update the `npmDeps` hash in `flake.nix` (build once, copy the
`got:` hash from the error).

## Usage

```sh
webscoop record <url-template> [--name recipe] [--var name=value]... [--profile name] [--timeout ms]
webscoop record --edit <recipe> [--repick field]
webscoop run <recipe> [--var name=value]... [--jsonl] [--out path]
                      [--profile name] [--timeout ms] [--lock-timeout ms] [--report]
                      [--no-heal] [--no-save] [--no-llm] [--interactive]
                      [--pages 1|N|all] [--max-pages n] [--delay ms]
                      [--guard-timeout ms] [--no-guards] [--no-notify] [--skip-steps]
webscoop test <recipe> [--var name=value]... [--profile name] [--timeout ms] [--json] [--no-llm]
                       [--pages 1|N|all] [--max-pages n] [--delay ms]
                       [--guard-timeout ms] [--no-guards] [--no-notify] [--skip-steps]
webscoop bench <recipe> [--tiers 0-4] [--seed n] [--json] [--no-llm]
webscoop export <recipe> [--format ts|py] [--out path] [--headless]
webscoop recipes [--json]
webscoop doctor
```

After `npm run build` the CLI is a single file: `node packages/cli/dist/webscoop.js`.

- `<recipe>` is a name in the recipes directory or a path to a recipe file.
- Extracted rows go to stdout only; logs, progress, and errors go to stderr.
  The default output is one JSON array. `--jsonl` prints one JSON object per
  line as rows become available. `--out` writes the same content to a file.
- Every row has one key per recipe field plus `_page` (1-based) and `_index`
  (0-based within the page).
- `--profile` picks the browser profile (default: the recipe name). Two runs
  cannot share a profile at once; the second waits `--lock-timeout` (default
  30000 ms), then exits 1.
- `--timeout` bounds navigation and network settling (default 30000 ms).
- `--report` prints the full run report (candidate used, healing outcome, and
  status per field, and where the recipe was written back) to stderr.
- `--no-heal`, `--no-save`, `--no-llm`, and `--interactive` control healing;
  see below.
- `--pages`, `--max-pages`, and `--delay` control pagination; see below.
- `--guard-timeout`, `--no-guards`, and `--no-notify` control guards; see below.
- `--skip-steps` replays none of the recipe's steps; see below.

```sh
webscoop run shop --var category="running shoes" | jq length
webscoop run shop --jsonl > rows.jsonl
webscoop run shop --pages all --jsonl > every-page.jsonl
```

### Pagination

A recipe's `pagination` block says how to reach the next page. The runner
extracts a page, emits its rows, then advances:

- `url`: the page number is a URL template variable (`pagination.param`: its
  name, `start`, and `step`). The runner fills it in itself, or sets it as a
  query parameter when the URL template has no such variable; `--var n=3`
  starts at page 3 instead of `start`.
- `next`: the runner clicks the next link or button (`pagination.target`) and
  waits for the new page.
- `more`: the runner clicks a load-more button and extracts only the items
  that appeared.
- `scroll`: the runner scrolls to the bottom and extracts the items that
  loaded; it stops when nothing loads within `--timeout`.
- `none`: one page, as before.

`pagination.limit` is `1`, a number of pages, or `all`. `--pages 1|N|all`
replaces it for one run, and `all` stops at `--max-pages` (default 500) with a
warning. The run also stops when the next or load-more target is gone or
disabled (`disabled`, `aria-disabled="true"`, or a link without `href`), when
a page has no items, and when a page repeats the previous page's URL and first
item (a loop). Stop rules in the recipe add `no-new-items` (a page adds nothing
new) and `first-item-repeats` (a page starts with the previous page's first
item; that page is dropped). `pagination.delayMs`, or `--delay`, waits between
pages.

Rows are deduplicated across pages by the field marked `key`, or by all field
values when no field is the key; the first page is never deduplicated.
`_page` counts pages in the order they were extracted, and `_index` restarts
at 0 on each page after dedup. With `--jsonl`, each page's rows are printed
before the next page loads, so a run that fails on page 7 has already printed
pages 1 to 6. The field selectors and the pagination target are resolved (and
healed) on the first page, then reused on later pages; a required field
missing from every item of a later page exits 3 naming the page. The summary
line counts pages and dropped duplicates, for example `24 rows from 3 pages,
2 duplicates dropped in 4.10s (shop)`.

`test` extracts only the first page unless `--pages` is given.

### Healing

Sites change their markup. When a stored selector stops matching, `run` does
not give up at once. For the item container and every field it tries, in
order:

1. the stored selector candidates, in listed order;
2. a fuzzy match of the fingerprint the recorder stored (tag, role,
   accessible name, text, stable attributes, ancestors, position), accepted
   at or above the recipe's `healing.fuzzyThreshold` (default 0.7) and only
   when it beats the runner-up by 0.05;
3. a language model, when an endpoint is configured (see [Language
   model](#language-model)) and the recipe's `healing.llm` is true: the
   runner lists the plausible elements of the scope (by field type, visible
   ones only, best fingerprint match first, at most 60 and at most 40 percent
   of the model's context window), and asks the model for the number of the
   element that is the field, or none. A pick counts only with confidence 0.5
   or more, a fingerprint score of 0.4 or more (fields), a value that
   converts for `number` and `date` fields, and, for item fields, a selector
   that holds in at least half of the item containers. Otherwise the field
   stays unresolved rather than take a wrong element;
4. with `--interactive`, you: for a required field nothing else found, the
   browser shows the recorder's re-pick panel and the run waits (no timeout)
   until you click the field's new location, skip it, or abort.

A field found by anything but its first candidate has status `healed` in the
report, and the stderr summary counts it (`24 rows from 1 page, 2 healed in
1.52s`). After a successful run the recipe file is rewritten where it was
loaded from, with fresh selectors for each healed target (the working one
first, old ones that still match after it, dead ones dropped) and a refreshed
fingerprint; nothing else in the file changes. A failed run never writes.

- `--no-save` heals but leaves the recipe file alone.
- `--no-heal` tries only the first candidate per target and never writes;
  anything else missing is missing (exit 3 when required).
- `--no-llm` skips the model rung for this run, whatever the config and recipe
  say.
- `--interactive` opens the browser with the page's Content-Security-Policy
  bypassed so the panel can load; without it a run never injects anything.

A field the model healed is logged with the model's reason, for example
`healed price: model: css=span[data-qa="price"] (price with currency) (was
testid=price)`; the reason is also in the `--report` output. When the model
declines a field, the field's line on stderr, `test --json`, and the report
(`notes`) carry its reason. The model is asked once per target per run. The
first time the endpoint fails (refused, timeout, HTTP error) the run logs one
line and skips the model for the rest of the run.

### Guards

A guard is a page that asks for a human instead of showing the list: a login
wall, a bot check, or an interstitial. Without guards such a page looks like a
broken recipe (exit 3); with them the run pauses and waits for you.

- `login`: the page landed on a login-like path (`/login`, `/signin`,
  `/sign-in`, `/account/login`, `/auth`, `/sso`) that the recipe's URL is not,
  or it shows a visible password field and no item container.
- `captcha`: a frame or element whose `src`, `id`, or class contains
  `turnstile`, `recaptcha`, `hcaptcha`, `challenge`, `cf-chl`, or `arkose`, or
  an HTTP 403 or 429 page whose text says `verify`, `robot`, `human`, or
  `challenge`.
- `zero-fields`: after healing, neither the item container nor any required
  field resolved, and the page was served with HTTP 400 or higher or has under
  500 characters of visible text. A long page where nothing resolves is a
  redesign, not a guard, and still exits 3. On later pages only an errored page
  counts; an empty short page is the end of the list.

`login` and `captcha` are checked after each page loads, `zero-fields` after
extraction; when several match, the first of `captcha`, `login`, `zero-fields`
is reported. When one fires, the run brings the browser window to the front,
sends one desktop notification (`notify-send`, critical urgency, naming the
recipe, the guard, and the page; without `notify-send` the same text goes to
stderr), and checks the page again every second. Once the guard is gone the run
goes back to the page it meant to load if you ended up elsewhere (for example
the home page after logging in), checks once more, and continues on the same
page number; rows already emitted stay emitted. Nothing is injected into the
page unless the run is `--interactive`, where a banner across the top of the
page shows the guard, a countdown, **Continue** (check again now), and
**Abort** (stop the run, exit 1).

All guards of a run share one wait budget, `--guard-timeout` (default 600000
ms for `run`, 0 for `test`, so `test` exits 2 at once on a wall). When it runs
out the run stops with exit 2, stderr names the guard, the page, and the URL,
the recipe is not written back, and stdout keeps the rows of completed pages
(in JSON array mode the array holds just those). `--no-guards` turns every
guard off for the run; a recipe turns single guards off in its `guards` list.
`--no-notify` skips the notification. Guards are logged on stderr
(`guard login on page 1: ...`), listed in the `--report` output (`guards`:
kind, page, URL, wait, cleared), and counted in the summary line.

```sh
webscoop run shop --guard-timeout 300000 >> rows.json   # cron: give up after five minutes, exit 2
```

### Window

Unattended runs keep the browser window out of your way: right after the
browser opens it is moved off screen, when a guard needs you it is brought to
the workspace you are on and focused, and once the guard clears it is moved
away again. `record`, `run --interactive`, and `--show` never hide the window.
`--hide` hides it even when the config sets `window.provider` to `none`, as
long as a provider is detected. Hiding is best effort: a provider command that
fails or takes over 2 seconds is reported once on stderr and the run carries
on with the window visible.

The window is found by process id: the Chromium main process whose command
line carries `--user-data-dir=<profile directory>`. Linux only; elsewhere the
provider is always `none`.

Providers:

- `hyprland` (built in): detected when `HYPRLAND_INSTANCE_SIGNATURE` is set
  and `hyprctl` is on the `PATH`. Hides on the `special:webscoop` workspace
  silently, shows on the active workspace (read from
  `hyprctl activeworkspace -j`) and focuses the window. Works with Lua and
  classic Hyprland configs.
- `none`: does nothing.
- Your own, in the config file (below).

`window.provider` picks one: `auto` (default) tries `hyprland`, then your
providers in the order they are declared, else `none`. A named provider that
is not detected is reported and the window stays visible. `webscoop doctor`
prints the provider in use.

The first frame: moving a window by pid can only happen once it has mapped,
so it would flash on your workspace for a moment. Hiding runs therefore
launch Chromium with `--class=webscoop` (its Wayland app id), and a window
rule on that class sends it to `special:webscoop` as it maps. On a Lua
Hyprland config webscoop adds the rule itself before the first launch, once
per Hyprland session (a config reload drops it and the next run adds it
again). On a classic config, paste the rule `doctor` prints:

```
windowrulev2 = workspace special:webscoop silent, class:^(webscoop)$
```

Visible runs (`record`, `--interactive`, `--show`) keep Chromium's usual
class, so your own rules for it still apply.

A provider is a set of shell command templates: `{pid}` is the browser's
process id, `{workspace}` the output of the optional `workspace` command (a
JSON object's `id`, else the trimmed text). Optional `prepare` runs once
before the browser launches, and `args` are extra Chromium arguments for
hiding runs; together they cover the first frame. For sway:

```json
{
  "window": {
    "provider": "auto",
    "providers": {
      "sway": {
        "detect": { "env": "SWAYSOCK", "binary": "swaymsg" },
        "hide": "swaymsg '[pid={pid}] move scratchpad'",
        "show": "swaymsg '[pid={pid}] scratchpad show'",
        "focus": "swaymsg '[pid={pid}] focus'",
        "args": ["--class=webscoop"]
      }
    }
  }
}
```

With `args` set, `for_window [app_id="webscoop"] move scratchpad` in the sway
config hides the window as it maps. A provider named `hyprland` in
`providers` replaces the built-in one.

Manual check on Hyprland: start the playground (`npm run playground`), write
the paged fixture with `wall=login&wallAfterPage=2` added to its URL, and run
it with `--delay 1500`. The window should never appear on your workspace while
pages 1 and 2 load, come to your workspace with focus when the login wall
shows on page 3, and leave again once you log in (any username and password work).

```sh
webscoop run shop --show        # watch the run
```

### Steps

Some pages need a few actions before the data shows: accept a cookie banner,
type a search term, open a tab, choose a sort order. A recipe records them as
`steps`, and every run replays them.

- `click` a button, link, or tab; `type` text into an input (the value may use
  `{variable}` placeholders, filled from `--var` or the default); `select` an
  option of a `select` by value or visible label; `press` a key (`Enter`,
  `Escape`, `Tab`, or one character) on an element or on whatever has focus;
  `wait` a number of milliseconds or until an element shows up.
- `first-page` steps (the default) run once, after the first page loads and its
  guards clear. `every-page` steps run after every page navigation, including
  the first, for content a page hides again on each load. Steps run in order,
  and the page settles after each one before extraction.
- Step targets go through the same healing ladder as fields (stored selectors,
  fingerprint, model) and are written back when they heal. `every-page` steps
  reuse what worked on the first page until it stops matching.
- When a step's element is gone, an `optional` step is skipped and reported; a
  required one fails the run with exit 3 naming the step. A step that
  navigates (a search submitted with Enter) is followed: guards are checked on
  the new page, and extraction happens on the page the steps end on.

Stderr prints one line per replayed or skipped step (`step 0 (click) on page
1: ok, candidate 0: role=button|Accept all`), the summary line counts skipped
steps, and `--report` lists every step with its page and outcome (`ok`,
`healed`, `skipped`, `failed`). `test` replays steps like a run, so its result
matches what a run will do. `--skip-steps` turns them off, to see what the
page looks like without them.

In the recorder, press `b` (or **Record steps**) to browse the page normally
while the panel records what you do: a click on a button, link, or tab becomes
a `click` step, typing into an input becomes one `type` step with the final
value, a `select` change becomes a `select` step, and Enter in an input becomes
a `press` step. Clicks in the panel are never recorded; `b` or `Esc` stops. A
picked element can also be added with **Record as step**, which does not
perform the action. In the steps list, edit the value (click a `{variable}`
chip to insert it), switch `every page` and `optional`, reorder by drag or
`Alt`+`Up` / `Alt`+`Down`, delete, and replay one step on the live page with
▶. A step whose element no longer matches shows the zero-match warning with
**Re-pick**. The panel's **Test run** does not replay steps: you already
performed them on the live page.

### Checking a recipe

```sh
webscoop test shop            # table on stdout, exit 0 or 3
webscoop test shop --json     # the same as a JSON array
```

`test` runs the recipe's first page with healing on and write-back off, replays
its steps (unless `--skip-steps`), prints
one line per target (`item` and every field) with its status, how many rows it
resolved in, and the selector or rung that found it, and prints no rows. It
exits 0 when every required field resolved on at least one row, 3 when one did
not, 2 when a guard (login wall, bot check) was not cleared (it does not wait
unless given `--guard-timeout`), 1 on errors. Use it from cron before trusting
a recipe.

### Measuring heal rates

```sh
webscoop bench playground-catalog --tiers 0-4          # table on stdout
webscoop bench playground-catalog --tiers 3 --json     # the same as JSON
```

`bench` starts the playground on a free port, fills the recipe's `{port}`
variable (and `{tier}` and `{seed}` when the recipe has them), and runs the
recipe once per tier with write-back off. It prints one row per tier and
target with the rung that resolved it (`candidate`, `fuzzy`, `model`, `user`,
`unresolved`), its status, and the tier's elapsed time. It exits 0 whatever
healed and 1 when a run broke. The playground is only in a development
checkout, so `bench` fails with a message elsewhere.

### Re-picking a field

```sh
webscoop record --edit shop --repick price
```

opens the recipe's page with the recorder in a focused mode for one field: the
panel shows the field's old selector, last value, and stored fingerprint, and
while you hover, the overlay tag and a score bar show how well each element
matches the fingerprint (`likely` at or above the threshold). Click the new
location, then **Use and save**: the field gets fresh selectors for that
element, the picked one first, and a new fingerprint, and the command exits 0.
`s` skips and `Esc` aborts (the first `Esc` only stops picking); both leave
the recipe unchanged. An unknown field name exits 1. `run --interactive` shows
the same panel when a run needs it, with **Use and continue**.

### Recording a recipe

```sh
webscoop record "https://shop.test/c/{category}" --var category=shoes
webscoop record --edit shop      # reopen a saved recipe with its fields loaded
```

`record` opens the page in the same visible, persistent Chromium profile that
`run` uses and docks a 400 px recorder panel on the right; the page is pushed
left, not covered. Variables without a value or default are asked for on the
terminal before the browser opens. Without `--name`, the recipe name is
proposed from the URL host and first path segment and can be changed in the
panel.

1. Press `p` (or **Pick element**), hover, and click an element. Host page
   click handlers do not fire while picking; `Alt`+click picks through cookie
   banners and other overlays.
2. The panel shows the element's tag, role, accessible name, attributes
   (flagged stable or hashed), its ancestors, and ranked selector candidates
   with the number of matches the browser counts on the page.
3. If the element sits in a repeating structure, the panel proposes the item
   container with its match count and highlights every match. Choose a broader
   or narrower level, exclude subsets with a CSS selector (for example
   `.sponsored`), and press `Enter` to confirm. The picked element becomes the
   first item field.
4. Pick more elements and **Add as field**; name, type, optional, and dedup
   key are editable in the field list. Mark a link or button as the
   **Pagination target** to record pagination; the panel sets its kind, page
   limit, stop rules, and the delay between pages.
5. **Test run** extracts the current page with the draft and shows a results
   drawer (table and JSON) with per-field status.
6. `Ctrl+S` saves to the recipes directory. Saving keeps the session open.

Close the browser window or press `Ctrl+C` to end the session. The exit code
is 0 when the session ends, with a warning on stderr naming the recipe when
the draft has unsaved changes, and 1 on errors (invalid template, invalid
recipe under `--edit`, no display, browser failure).

| Key | In the panel |
| --- | ------------ |
| `p` | start picking |
| `b` | record steps while you use the page (browse mode), or stop |
| `Esc` | cancel picking, close a menu, stop browse mode |
| `Alt`+click | pick through overlays while picking |
| `Enter` | confirm the proposed item container |
| `Left` / `Right` | walk the selection up and back down its ancestors |
| `Alt`+`Up` / `Alt`+`Down` | move the focused field or step |
| `Ctrl+S` | save |
| `s` | skip the field (re-pick mode) |
| `Esc` | stop picking, then abort (re-pick mode) |

Shortcuts do not fire while typing in an input.

### Export

```sh
webscoop export shop > shop.ts                        # TypeScript for Node, on stdout
webscoop export shop --format py --out scrape/shop.py # Python, to a file
webscoop export shop --headless                       # the script runs without a window by default
```

`export` writes a standalone Playwright script that runs the recipe without
webscoop, for another project, a CI job, or a language you already use. It
reads the recipe only: no browser, no display, no profile lock. The script
navigates, replays the steps, extracts rows with the same value conversion,
walks the pagination with the same limit, stop rules, and dedup, and prints
rows like `webscoop run` does on a healthy site.

Run the TypeScript script with `npx tsx shop.ts` in a directory where the
`playwright` package is installed (`npm install playwright`, then
`npx playwright install chromium`). The Python script needs Python 3.9 or
later with Playwright for Python (`pip install playwright`, then
`playwright install chromium`) and runs with `python3 shop.py`. Both take:

| Flag | Meaning |
| ---- | ------- |
| `--var name=value` | a recipe variable (repeatable); `WEBSCOOP_VAR_<NAME>` (uppercased) works too, `--var` wins, recipe defaults fill the rest |
| `--jsonl` | one JSON object per line instead of a JSON array |
| `--out <path>` | rows to a file instead of stdout |
| `--pages <1\|N\|all>` | pages to walk, replacing the recipe limit (`all` stops at 500) |
| `--headless` / `--headed` | run without or with a browser window (default: headed, or headless when exported with `--headless`) |
| `--profile <dir>` | keep the browser profile in this directory; without it each run uses a temporary profile removed at exit |

Use `--profile` for sites that need a login: run once headed, log in by hand
in the window, and later runs reuse the cookies. Exit codes are 0, 1, and 3
with the meanings below; logs go to stderr.

The script tries each target's stored selector candidates in order and nothing
more. It does not include fingerprint healing, model healing, guards,
notifications, window hiding, or recipe write-back; its header says so. When a
site changes, re-record (or `webscoop run` to heal) the recipe and export it
again rather than editing selectors in the script: the recipe stays the source
of truth.

### Exit codes

| Code | Meaning | Cron should |
| ---- | ------- | ----------- |
| 0 | Success | carry on |
| 1 | Error to fix or unexpected failure: bad arguments, invalid recipe, missing variable, no display, busy profile, navigation timeout, browser crash, interrupted | fix the setup |
| 2 | A run paused on a guard (login wall, bot check, interstitial) and nobody cleared it within `--guard-timeout`; rows of completed pages are kept | retry later, or log in to the profile |
| 3 | A required field matched no element and no healing rung could recover it (`test`: a required field is unresolved) | alert a human |

### Files

| What | Location |
| ---- | -------- |
| Recipes | `$XDG_DATA_HOME/webscoop/recipes/<name>.json` (default `~/.local/share/webscoop/recipes/`) |
| Browser profiles | `$XDG_DATA_HOME/webscoop/profiles/<name>/` |
| Config | `$XDG_CONFIG_HOME/webscoop/config.json` (default `~/.config/webscoop/config.json`) |

`WEBSCOOP_HOME=/some/dir` replaces both roots: recipes in `/some/dir/recipes/`,
profiles in `/some/dir/profiles/`, config at `/some/dir/config.json`.

Config file, all keys optional:

```json
{
  "browser": { "executablePath": "/path/to/chrome" },
  "window": { "provider": "auto", "providers": {} },
  "llm": {
    "endpoint": "http://127.0.0.1:11434/v1",
    "model": "qwen3.5:9b",
    "apiKey": "optional bearer token",
    "contextTokens": 32768,
    "timeoutMs": 60000,
    "temperature": 0
  }
}
```

### Language model

The model rung talks to any OpenAI-compatible chat completions endpoint
(Ollama, llama.cpp, vLLM, and so on). `endpoint` is the base URL before
`/chat/completions`. `apiKey` is sent as `Authorization: Bearer` only when set.
`contextTokens` (default 32768) sizes the prompt budget: 40 percent of it,
estimated at 3.5 characters per token. `timeoutMs` (default 60000) bounds each
request, and `temperature` defaults to 0. Without both an endpoint and a model
the rung is off and runs behave as before.

These environment variables override the file:

| Variable | Overrides |
| -------- | --------- |
| `WEBSCOOP_LLM_ENDPOINT` | `llm.endpoint` |
| `WEBSCOOP_LLM_MODEL` | `llm.model` |
| `WEBSCOOP_LLM_API_KEY` | `llm.apiKey` |
| `WEBSCOOP_LLM_MOCK` | replaces the endpoint with scripted answers from a JSON file, for tests |

Requests ask for a JSON object (`response_format`), no streaming, and no
reasoning: `chat_template_kwargs.enable_thinking: false` and
`reasoning_effort: "none"`, which a server rejecting either gets once more
without both. A leading `<think>` block and code fences are stripped from the
answer, and an answer that is not the expected JSON is asked for again once.

`webscoop doctor` probes a configured endpoint: whether it answers, whether
`/models` lists the model, the round trip of a one-token completion, and a
warning when `contextTokens` is below 8192. Probe problems are warnings and do
not change the exit code.

A `WEBSCOOP_LLM_MOCK` script is an array of responses, or
`{ "contextTokens"?, "responses": [...] }`. Each response has an optional
`match` (answer only prompts containing this text, such as `"Field: price\n"`),
an optional `repeat` (keep it for later prompts), and one of `reply` (a string
or an object sent as JSON), `error` (fail like an unreachable endpoint), or
`pick` (a regular expression over the numbered candidate lines; the answer is
the number of the first line it matches, or null), with optional `confidence`
(default 0.9) and `reason`. The fixtures in `packages/cli/fixtures/llm/` script
tiers 3 and 4.

## Recipe format

A recipe is one JSON document with `schemaVersion: 1`. The reference example,
used by the end-to-end tests, is
[`packages/cli/fixtures/playground-catalog.json`](packages/cli/fixtures/playground-catalog.json).

- `name`: kebab-case, unique among your recipes.
- `url`: template with `{variable}` placeholders; every placeholder must be
  declared in `vars` (`{ "name", "type": "string", "default"? }`). Values are
  URL-encoded when substituted.
- `item`: optional repeating container, `selectors` plus optional `exclude`.
  Without it, every field has scope `page` and the recipe yields one row.
- `fields`: `name`, `type` (`text`, `number`, `url`, `image`, `date`, `html`),
  `scope` (`item` or `page`), ranked `selectors`, optional `attr`, `optional`
  (default false), `key` (at most one field), and `fingerprint`.
- Selector candidates: `{ "strategy", "value", "stability" }` with strategy
  `role` (`"heading|Wireless Mouse"`: role, then optional exact accessible
  name), `testid`, `id`, `text` (exact), `css`, or `xpath`. The first candidate
  that matches wins.
- `fingerprint` (on the item and on fields): what the element looked like when
  it was recorded; fuzzy healing matches against it. Recipes without
  fingerprints skip that rung.
- `healing`: `fuzzyThreshold` (0 to 1, default 0.7) and `llm` (default true;
  false keeps the model rung off for this recipe).
- `pagination`: `kind` (`none`, `url`, `next`, `more`, `scroll`), `target`
  (selectors and fingerprint of the next or load-more control), `param` (the
  page variable for `url`), `limit` (`1`, N, or `all`), `stopRules`
  (`no-new-items`, `first-item-repeats`, `target-missing`), and `delayMs`.
  Filled with defaults (`none`, one page) when absent.
- `guards`: `[{ "kind": "login" | "captcha" | "zero-fields", "enabled" }]`,
  all enabled by default; `enabled: false` turns one guard off for this
  recipe (see Guards).
- `steps`: ordered actions replayed before extraction (see Steps), default
  `[]`. Each has `kind` (`click`, `type`, `select`, `press`, `wait`), `target`
  (`selectors` and optional `fingerprint`, required for `click`, `type`, and
  `select`), `value` (required for `type`, `select`, and `press`; for `wait`
  a number of milliseconds when there is no target; `{variable}` placeholders
  in a `type` value must be declared in `vars`), `when` (`first-page` or
  `every-page`, default `first-page`), `optional` (default false), and an
  optional `label` used in logs.

```json
"steps": [
  { "kind": "click", "target": { "selectors": [{ "strategy": "role", "value": "button|Accept all", "stability": "stable" }] }, "optional": true },
  { "kind": "type", "target": { "selectors": [{ "strategy": "css", "value": "input[name=\"q\"]", "stability": "medium" }] }, "value": "{q}" },
  { "kind": "press", "value": "Enter" }
]
```

## Playground

```sh
npm run playground   # serves http://127.0.0.1:4777 (PLAYGROUND_PORT to change)
```

`/catalog?tier=0&seed=1&delayMs=0` renders 24 products from
`packages/playground/src/dataset.ts`. Tier 0 is stable markup with ids, test
ids, roles, and readable classes. Tier 1 replaces every class name, `id`, and
`data-testid` value with a seeded hash-like token (`x` plus 6 characters), so
only roles, text, and structure survive. Tier 2 adds tier 1's churn, wraps each
card's content in one or two extra `div` elements, moves the price above or
below the title, and shuffles the cards, all by `seed`; only the fingerprint
survives. Tier 3 adds semantic churn on top of tier 2, one choice per page by
`seed`: cards become `div` or `section`, titles an `h3` or a `div` with
`role="heading"`, the price a `span` after a sibling `Cost:` or `Now:` label,
`data-testid` becomes `data-qa`, the rating is described by `title` instead of
`aria-label`, and the link reads "See product". Fuzzy matching alone does not
survive it; the model rung does. Tier 4 is tier 3 with the rating element
removed from every card, so healing must end with `rating` unresolved rather
than take another element. `chrome=hostile` wraps the catalog in adversarial page
chrome (fixed header, promo bar, cookie modal, aggressive global CSS, a click
recorder in `window.__hostClicks`), and `sponsored=N` marks the first N cards
with class `sponsored`; the recorder tests use both. `POST /__control` with `{"tier","seed","delayMs"}` sets
defaults, `GET /__control` reads them, `POST /__control/reset` restores them.
With the playground running, `webscoop run packages/cli/fixtures/playground-catalog.json`
extracts all 24 products.

`paginate=url|next|more|scroll` splits the catalog into 3 pages of 8, in
dataset order. `url`: `page=N` selects the page, with numbered links and a
`Next` link on pages 1 and 2. `next`: the page lives in the `ws_page` cookie;
the `Next` link (`/catalog?paginate=next&go=next`) advances it and redirects
back, and on page 3 it is disabled (`aria-disabled="true"`, no `href`).
`more`: a `Load more` button appends the next 8 from `/catalog/more?after=N`
and disappears after 24. `scroll`: reaching the bottom appends the next 8,
until 24. Switches for the stop rules: `nextRel=0` drops `rel="next"` from
the `Next` link, `lastPageRepeats=1` serves page 3 again (with a `Next` link)
for every page beyond 3, and `moreDisappears=1` removes the `Load more` button
after its first click.
[`packages/cli/fixtures/playground-paged.json`](packages/cli/fixtures/playground-paged.json)
walks the `url` kind with limit `all`.

Walls for the guards: `wall=login` redirects `/catalog` (302) to
`/login?next=<path and query>` until the `ws_sess` cookie is set; `/login`
shows a username and password form that accepts anything, sets `ws_sess`, and
redirects to `next` (a same-origin path, else `/`); `/logout` clears it.
`wall=captcha` serves `/catalog` with HTTP 403 and a challenge page (a
`turnstile` iframe, `#challenge-form`, "Verify you are human", and an
`I am human` button that posts to `/challenge`, which sets `ws_human`, then
reloads) until `ws_human` is set; `/challenge` shows the same page directly.
`wall=interstitial` serves `/catalog` with HTTP 503 and a one-sentence page
until `ws_human` is set. `wallAfterPage=N` raises the wall only on pages after
N (the `page` parameter, or the `ws_page` cookie of the `next` kind), so
`wall=captcha&wallAfterPage=2&paginate=url` walls page 3 only.

Gates for steps keep the products out of the DOM until an action, so a recipe
without the step finds nothing (exit 3). `gate=cookie` shows a consent modal
with a backdrop and an `Accept all` button (`#consent-accept`); the list waits
in a `template` until the click, which stores `ws_consent` in `localStorage`,
so later loads show no modal. `gate=search` shows a `GET` search form with an
input named `q` above an empty list; `q=<text>` lists the products whose title
contains the text, case-insensitive, in dataset order, and keeps the input
filled. `gate=tabs` shows two `role="tab"` buttons, `About` (active) and
`Products`; the list is inserted into the Products panel when that tab is
clicked, and nothing persists, so every page load needs the click. Gates
compose with tiers (their classes and ids churn too), `paginate`, and walls.

## Layout

```
packages/
  core        recipe schema, URL template, value conversion, runner, events, ports (pure TypeScript)
    src/selectors   selector candidates, stability, item inference, fingerprints
    src/healing     healing ladder, fingerprint score, fuzzy match, model rung, promotion
    src/llm         JSON answers from a language model: stripping, validation, one retry
    src/recorder    recorder protocol, draft state, host-side session controller
    src/export      recipe to standalone Playwright script: plan, TypeScript and Python renderers
  browser     BrowserPort adapter over Playwright
  cli         webscoop command, paths, config, profile lock, output
  llm         OpenAI-compatible chat client, endpoint probe, scripted mock
  inject      recorder UI injected into the page (React in a closed shadow root, esbuild IIFE)
  playground  fixture site, dataset, tier renderers
e2e/          Playwright tests that run the built CLI against the playground
```

`packages/core` must not import Playwright, Node APIs, or other workspace
packages; `npm run lint` enforces it.

## License

[MIT](LICENSE)
