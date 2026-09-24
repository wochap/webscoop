# webscoop

Record a scraper by clicking elements on a live page, then run it unattended
from the command line. The browser is a real, visible Chromium with a
persistent profile, so a site you log into once stays logged in.

This release has the recipe format, the `webscoop` CLI, a runner for static
selectors, the recorder (`webscoop record`), and a local playground site for
tests. Selector healing, running pagination, and login/captcha guards arrive in
later changes.

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
`DISPLAY` is set.

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
webscoop record --edit <recipe>
webscoop run <recipe> [--var name=value]... [--jsonl] [--out path]
                      [--profile name] [--timeout ms] [--lock-timeout ms] [--report]
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
- `--report` prints the full run report (candidate used and status per field)
  to stderr.

```sh
webscoop run shop --var category="running shoes" | jq length
webscoop run shop --jsonl > rows.jsonl
```

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
   **Pagination target** to record pagination (it runs in a later change).
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
| `Esc` | cancel picking, close a menu |
| `Alt`+click | pick through overlays while picking |
| `Enter` | confirm the proposed item container |
| `Left` / `Right` | walk the selection up and back down its ancestors |
| `Alt`+`Up` / `Alt`+`Down` | move the focused field |
| `Ctrl+S` | save |

Shortcuts do not fire while typing in an input.

### Exit codes

| Code | Meaning | Cron should |
| ---- | ------- | ----------- |
| 0 | Success | carry on |
| 1 | Error to fix or unexpected failure: bad arguments, invalid recipe, missing variable, no display, busy profile, navigation timeout, browser crash, interrupted | fix the setup |
| 2 | A run paused for user input and the wait timed out | retry later |
| 3 | A required field matched no element and nothing could recover it | alert a human |

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
  "llm": { "endpoint": "http://127.0.0.1:11434/v1", "model": "qwen3.5:9b", "contextTokens": 32768 }
}
```

The `llm` block is read and reported by `doctor`; selector healing uses it in a
later change.

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
- `pagination`, `guards`, `healing`: fixed now, used by later changes, filled
  with defaults when absent.

## Playground

```sh
npm run playground   # serves http://127.0.0.1:4777 (PLAYGROUND_PORT to change)
```

`/catalog?tier=0&seed=1&delayMs=0` renders 24 products from
`packages/playground/src/dataset.ts`. Tiers 1 to 4 return 501 until later
changes add them. `chrome=hostile` wraps the catalog in adversarial page
chrome (fixed header, promo bar, cookie modal, aggressive global CSS, a click
recorder in `window.__hostClicks`), and `sponsored=N` marks the first N cards
with class `sponsored`; the recorder tests use both. `POST /__control` with `{"tier","seed","delayMs"}` sets
defaults, `GET /__control` reads them, `POST /__control/reset` restores them.
With the playground running, `webscoop run packages/cli/fixtures/playground-catalog.json`
extracts all 24 products.

## Layout

```
packages/
  core        recipe schema, URL template, value conversion, runner, events, ports (pure TypeScript)
    src/selectors   selector candidates, stability, item inference, fingerprints
    src/recorder    recorder protocol, draft state, host-side session controller
  browser     BrowserPort adapter over Playwright
  cli         webscoop command, paths, config, profile lock, output
  llm         placeholder for the LLM adapter
  inject      recorder UI injected into the page (React in a closed shadow root, esbuild IIFE)
  playground  fixture site, dataset, tier renderer
e2e/          Playwright tests that run the built CLI against the playground
```

`packages/core` must not import Playwright, Node APIs, or other workspace
packages; `npm run lint` enforces it.

## License

[MIT](LICENSE)
