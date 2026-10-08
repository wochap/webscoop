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

### Trying a local build

Run the npm build output directly while iterating:

```sh
npm run build
node packages/cli/dist/webscoop.js record 'https://www.google.com/search?q={query}' --var query="top+llms"
```

Or build the Nix package. `./result` keeps pointing at the last
`nix build`, so rebuild after each change (the `npmDeps` hash in
`nix/package.nix` only changes with `package-lock.json`):

```sh
nix build
./result/bin/webscoop record 'https://www.google.com/search?q={query}' --var query="top+llms"
```

A running record session keeps the recorder it injected; restart it to
pick up a new build.

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

`WEBSCOOP_E2E_DRIVER=patchright` runs the end-to-end suite through Patchright
and the system Chrome. `e2e/stealth.spec.ts` runs the catalog recipe under
Patchright whatever the variable says, and skips when Chrome is not installed.

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

With home-manager, import the module and configure `programs.webscoop`:

```nix
# home-manager configuration
imports = [ inputs.webscoop.homeManagerModules.default ];

programs.webscoop = {
  enable = true;
  # Set for every webscoop command (and the daemon jobs it submits).
  environment.NODE_EXTRA_CA_CERTS = "/etc/ssl/local-ca.pem";
  # Written to ~/.config/webscoop/config.json; option paths match JSON paths.
  settings = {
    browser.driver = "patchright";
    daemon.concurrency = {
      total = 3;
      perRecipe = 1;
      recipes.google-search = 2;
    };
  };
};
```

`settings.daemon.concurrency.{total,perRecipe,recipes}` and
`settings.daemon.idleMs` are typed, so a wrong value fails evaluation; other
keys pass through as-is. `shellCompletions.enable = false` skips the zsh
completion. Do not combine `settings` with `environment.WEBSCOOP_HOME`: webscoop
then reads `$WEBSCOOP_HOME/config.json`, and the module refuses the combination.
The overlay `overlays.default` adds `pkgs.webscoop`.

Try it without installing: `nix run . -- doctor`. After changing
dependencies, update the `npmDeps` hash in `nix/package.nix`: set `hash` to
`lib.fakeHash`, run `nix build .#default`, then copy the `got:` hash from the
`hash mismatch` error into `nix/package.nix`. `nix flake check` evaluates the
home-manager module.

### Shell completion

The Nix package installs a zsh completion function into
`share/zsh/site-functions`, so commands, flags, recipe names, and profile names
complete once the package is on your profile. Without Nix, add the
`completions` directory (`packages/cli/completions` in a checkout, or the one
in the installed npm package) to `fpath` before `compinit` in `~/.zshrc`:

```zsh
fpath=(/path/to/webscoop/packages/cli/completions $fpath)
autoload -Uz compinit && compinit
```

Recipe and profile names are read from the data directory (`WEBSCOOP_HOME`,
else `$XDG_DATA_HOME/webscoop`, else `~/.local/share/webscoop`) without
starting Node.

### Agent skill

`skills/webscoop-use-recipe/SKILL.md` teaches AI harnesses (Claude Code,
Codex, and similar) to list your recipes with `webscoop recipes --json`, pick
the one that fits a request, run it, and explain its exit code. The Nix
package installs it at `share/webscoop/skills/webscoop-use-recipe/`. With
home-manager, where `pkg` is the webscoop package:

```nix
home.file.".claude/skills/webscoop-use-recipe".source = "${pkg}/share/webscoop/skills/webscoop-use-recipe";
```

Without Nix, copy or symlink the directory into your harness's skills
directory.

## Usage

```sh
webscoop record <url-template> [--name recipe] [--var name=value]... [--profile name] [--timeout ms] [--force]
webscoop record --edit <recipe> [--repick field]
webscoop edit <recipe> [--repick field] [--var name=value]... [--profile name] [--timeout ms] [--force]
webscoop run <recipe> [--var name=value]... [--var-file name=path]... [--var-command name=cmd]...
                      [--jsonl] [--out path]
                      [--profile name] [--timeout ms] [--queue-timeout ms] [--report] [-q|--quiet]
                      [--no-heal] [--no-save] [--no-llm] [--interactive]
                      [--pages 1|N|all] [--max-pages n] [--delay ms]
                      [--guard-timeout ms] [--no-guards] [--[no-]notify] [--skip-flows]
webscoop test <recipe> [--var name=value]... [--var-file name=path]... [--var-command name=cmd]... [--profile name] [--timeout ms] [--queue-timeout ms] [--json] [--no-llm]
                       [--pages 1|N|all] [--max-pages n] [--delay ms]
                       [--guard-timeout ms] [--no-guards] [--[no-]notify] [--skip-flows]
webscoop bench <recipe> [--tiers 0-4] [--seed n] [--json] [--no-llm]
webscoop export <recipe> [--format ts|py] [--out path] [--headless]
webscoop recipes [--json]
webscoop browser show|hide [--profile name]
webscoop daemon status [--json]
webscoop daemon stop [--force]
webscoop attention continue|abort [run-id]
webscoop doctor
```

After `npm run build` the CLI is a single file: `node packages/cli/dist/webscoop.js`.

- `<recipe>` is a name in the recipes directory or a path to a recipe file.
- Extracted rows go to stdout only; logs, progress, and errors go to stderr.
  The default output is one JSON array. `--jsonl` prints one JSON object per
  line as rows become available. `--out` writes the same content to a file.
- Every row has one key per recipe field plus `_page` (1-based) and `_index`
  (0-based within the page).
- `--profile` picks the browser profile. Without it, the profile is resolved
  (see [Profiles](#profiles)); with no profile config it is the recipe name.
  Runs on one profile share its browser; see [Daemon](#daemon).
- `--timeout` bounds navigation and network settling (default 30000 ms).
- `--report` prints the full run report (candidate used, healing outcome, and
  status per field, and where the recipe was written back) to stderr.
- `-q`/`--quiet` on `run` prints only errors and prompts to act on stderr.
  Errors are a failed or given-up run, CLI and config errors, and an
  interrupted run. Prompts are the guard waiting line, the guard banner hint,
  re-pick requests, and the notification text when `notify-send` is missing,
  so a paused run never looks hung. Informational lines and every warning
  (dropped rows, partial or fallback fields, encoded `--var` values, profile
  warnings, guard cleared or timed out, re-pick outcomes) are muted. A clean
  quiet run leaves stderr empty; `--report` still prints.
- `--queue-timeout` gives up (exit 1) on a run that has not started within
  that many milliseconds, naming the profile and the jobs ahead; without it a
  run waits until it starts.
- `--no-heal`, `--no-save`, `--no-llm`, and `--interactive` control healing;
  see below.
- `--pages`, `--max-pages`, and `--delay` control pagination; see below.
- `--guard-timeout`, `--no-guards`, and `--notify` / `--no-notify` control guards; see below.
- `--skip-flows` runs none of the recipe's flows; see below.

```sh
webscoop run shop --var category="running shoes" | jq length
webscoop run shop --jsonl > rows.jsonl
webscoop run shop --pages all --jsonl > every-page.jsonl
```

`<url-template>` is URL with `{name}` placeholders. Each placeholder needs
matching `--var name=value` at record and run time.

```sh
webscoop record "https://shop.test/c/{category}" --name shop
webscoop run shop --var category="running-shoes"
```

### Variables

A recipe's variables fill `{name}` in the URL template and in `fill` step
values. `run`, `test`, `record`, and `edit` take each value from the first
source that has one:

1. The command line: `--var name=value`, `--var-file name=PATH` (the file's
   content, one trailing newline removed), or `--var-command name=CMD` (the
   trimmed stdout of `CMD` run with `/bin/sh -c`). Two of them for one
   variable is an error.
2. The config file's `vars` block, per recipe and variable: exactly one of
   `value`, `file` (relative to the config file's directory, `~/` is home), or
   `command` (`/bin/sh -c` in the config file's directory, trimmed stdout).
3. The recipe's `default`.

```json
{
  "vars": {
    "sunat-menu": {
      "pass": { "command": "pass show sunat/sol" },
      "ruc": { "file": "~/.config/sunat/ruc" },
      "user": { "value": "ADA" }
    }
  }
}
```

Sources are read before the browser opens, only for variables the recipe
declares, in the command you typed (the daemon never runs them). A command
that fails, cannot start, or runs longer than 30 seconds, or a file that
cannot be read, exits 1 naming the variable and the source, without its
output. A variable left without a value exits 1, as before.

Variable kinds:

- `secret: true` marks a variable whose value comes only from the command line
  or the config. It cannot have a default or appear in the URL template. Its
  value is replaced by `***` in stderr, the report, and error messages, left
  out of the hook payload's `vars`, never sent to the language model, and
  never written to the recipe, also by the recorder. Rows are page data and are
  printed as the page shows them.
- `type: "path"` holds one or more file paths separated by `:`, for file
  inputs. Relative paths resolve against the directory you ran the command
  in. Before a `fill` step uses it, every path must name a readable file, else
  the run exits 1 naming the variable and the path. Its default is saved.

```sh
webscoop run sunat-menu --var-command pass='pass show sunat/sol'
webscoop run upload --var clips=intro.mp4:outro.mp4
```

### Daemon

`run` and `test` execute in a background daemon, one per user, which the first
of them starts. It keeps one headed browser per profile and runs each job in a
new tab of it, so a second run on a warm profile starts at once instead of
launching Chrome again. The command stays in the foreground: it prints the
job's rows and stderr lines as they come and exits with the job's exit code,
exactly as a run without the daemon would. Each job uses the environment,
working directory, config, and recipe of the command that submitted it (so
`--out rows.json` lands in your current directory and `WEBSCOOP_LLM_KEY`
comes from your shell). Ctrl+C cancels only that job and closes its tab.

- `daemon.concurrency.total` (config, default 1) is how many jobs one browser
  runs at once. `daemon.concurrency.perRecipe` (unset: no cap) is how many
  jobs of one recipe it runs at once, and `daemon.concurrency.recipes` gives
  single recipes their own cap, e.g. `{ "bing": 2 }`. Waiting jobs start
  oldest first, but a job whose recipe is at its cap does not hold back later
  jobs of other recipes; jobs of one recipe always start in submission order.
  Each waiting command prints one `queued on profile "shop": 2 jobs ahead`
  line (not with `--quiet`). `{ "total": 3, "perRecipe": 1 }` lets google,
  bing, and duckduckgo searches run side by side while each host sees one run
  at a time; the default keeps anti-bot guards calm.
- `daemon.idleMs` (config, default 60000) keeps a browser open this long after
  its last job; 0 closes it right away. The daemon exits once it has no
  browser and no job.
- A job whose launch settings (driver, channel, binary, proxy, timezone,
  locale, `browser.args`) differ from its profile's open browser waits until
  that browser has no job; the browser is then relaunched with the new
  settings.
- The socket is `$WEBSCOOP_HOME/run/daemon.sock` when `WEBSCOOP_HOME` is set,
  else `$XDG_RUNTIME_DIR/webscoop/daemon.sock`, else
  `/tmp/webscoop-<uid>/daemon.sock`, readable only by you. The log is
  `daemon.log` in `$WEBSCOOP_HOME`, else `$XDG_STATE_HOME/webscoop/` (default
  `~/.local/state/webscoop/`); hook output from runs goes there too.
- After an upgrade, the first command finds a daemon of another version: that
  daemon finishes its jobs and exits, and a new one serves the command.

```sh
webscoop daemon status          # pid, version, per browser: profile, pid, running and queued runs, attention
webscoop daemon status --json
webscoop daemon stop            # refuse new jobs, wait for the others, close every browser
webscoop daemon stop --force    # cancel the jobs instead of waiting (their commands exit 1)
```

`record`, `edit`, and `bench` do not use the daemon; they open their own
browser and take the profile lock. When the daemon has a browser open on their
profile, they print its running and queued jobs and ask `Stop it? [y/N]`; `y`
cancels those jobs (their commands exit 1 saying which command stopped them),
closes that browser, and goes on. `--force` stops it without asking. Without a
terminal and without `--force` they exit 1 naming the profile. Jobs submitted
for that profile meanwhile wait in the queue until the exclusive command ends.

### Pagination

The sequence's `paginate` block says how to reach the next page. The runner
runs the block's `do` blocks for a page (flows and extractions), emits the
page's rows, then advances:

- `url`: the page number is a URL template variable (`param`: its name,
  `start`, and `step`). The runner fills it in itself, or sets it as a query
  parameter when the URL template has no such variable; `--var n=3` starts at
  page 3 instead of `start`.
- `next`: the runner clicks the next link or button (`target`) and waits for
  the new page.
- `more`: the runner clicks a load-more button and extracts only the items
  that appeared.
- `scroll`: the runner scrolls to the bottom and extracts the items that
  loaded; it stops when nothing loads within `--timeout`.

A recipe without a paginate block extracts one page. The block's `table`
names its driving table, which supplies the item counts for `more` and
`scroll` and the page summary the stop rules see; without it, the first table
with an item block extracted in `do` drives.

`limit` is `1`, a number of pages, or `all`. `--pages 1|N|all` replaces it for
one run, and `all` stops at `--max-pages` (default 500) with a warning. The
run also stops when the next or load-more target is gone or disabled
(`disabled`, `aria-disabled="true"`, or a link without `href`), when the
driving table has no items on a page, and when a page repeats the previous
page's URL and first item (a loop). Stop rules add `no-new-items` (a page adds
nothing new) and `first-item-repeats` (a page starts with the previous page's
first item; that page is dropped). `delayMs`, or `--delay`, waits between
pages.

Rows are deduplicated across pages by the field marked `key`, or by all field
values when no field is the key; the first page is never deduplicated.
`_page` counts pages in the order they were extracted, and `_index` restarts
at 0 on each page after dedup. With `--jsonl`, each page's rows are printed
before the next page loads, so a run that fails on page 7 has already printed
pages 1 to 6. The field selectors and the pagination target are resolved (and
healed) the first time, then reused on later pages; a required field
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
- `--interactive` shows the re-pick panel in the run's tab, whose
  Content-Security-Policy is bypassed (for that tab only) so the panel can
  load.

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
is reported.

Only one run per browser asks for you at a time: it holds the browser's
attention. A run that raises a guard while another run holds attention prints
`waiting for run <id> to finish with the browser's attention` and waits. Once it
gets attention it reloads its page and checks again, so one captcha you solve
or one login frees every run behind it without asking you again (a guard on
another site still asks). The run holding attention brings its tab to the
front, sends one desktop notification (`notify-send`, critical urgency, naming
the recipe, the guard, and the page; without `notify-send` the same text goes
to stderr), shows a banner across the top of its page with the guard, a
countdown, **Continue** (check again now), and **Abort** (stop the run, exit
1), and checks the page again every second. `guards.banner: false` in the
config turns the banner off, and then nothing is injected into the page;
outside a guard nothing is injected either (CSP is bypassed for the run's tab
only, so the banner loads). Once the guard is gone the run goes back to the
page it meant to load if you ended up elsewhere (for example the home page
after logging in), checks once more, and continues on the same page number;
rows already emitted stay emitted.

Besides the banner, you can answer:

- at the `Solved? [Y/n/a]` prompt the command prints on its terminal (on
  `/dev/tty`, never on stdout, even with `--quiet` or a pipe): Enter or `y`
  checks again now and says so when the guard is still there, `n` keeps
  waiting without asking again, `a` aborts. The prompt is taken back when the
  guard clears any other way.
- with `webscoop attention continue` or `webscoop attention abort`, for example
  from a notification action or a key binding; it acts on the only run holding
  attention, or on `[run-id]` (`WEBSCOOP_RUN_ID` in hooks, or `webscoop daemon
  status`), and exits 1 listing the run ids when none or several hold
  attention.

All guards of a run share one wait budget, `--guard-timeout` (default 600000
ms for `run`, 0 for `test`, so `test` exits 2 at once on a wall), counted only
while the run holds attention. When it runs
out the run stops with exit 2, stderr names the guard, the page, and the URL,
the recipe is not written back, and stdout keeps the rows of completed pages
(in JSON array mode the array holds just those). `--no-guards` turns every
guard off for the run; a recipe turns single guards off in its `guards` list.
`notify: false` in the config turns the notification off for every run and
test; `--notify` and `--no-notify` override the config for one command, also
for a run served by the daemon. Hooks fire either way. Guards are logged on stderr
(`guard login on page 1: ...`), listed in the `--report` output (`guards`:
kind, page, URL, wait, cleared), and counted in the summary line.

```sh
webscoop run shop --guard-timeout 300000 >> rows.json   # cron: give up after five minutes, exit 2
```

### Hooks

webscoop does not move the browser window itself. It fires lifecycle events,
and the config maps each event to shell commands, so your own scripts decide
what the window manager does (hide the browser, bring it back when a guard
needs you, send a notification).

| Event | When |
| --- | --- |
| `run.queued` | a `run` or `test` job waits for a free slot; the payload has `ahead`, the jobs before it |
| `browser.starting` | before a browser launches; the launch waits for these hooks |
| `browser.started` | the browser opened and its main process id is known (or 5 seconds passed) |
| `browser.closed` | the browser closed |
| `run.start` | `run` or `test` starts navigating |
| `run.done` | a run or test ended successfully |
| `run.failed` | a run or test ended unsuccessfully, including a guard timeout and an abort |
| `attention.needed` | the run needs you in the browser: reason `guard` or `repick` |
| `attention.resolved` | that need ended; exactly one follows every `attention.needed` |
| `browser.show`, `browser.hide` | fired only by `webscoop browser show|hide` |

`record`, `edit`, and `bench` fire the browser events for the browser they
launch. For `run` and `test` the daemon fires `browser.starting` and
`browser.started` when it launches a profile's browser and `browser.closed`
when it closes it, once per browser, not per job: a run served by a warm
browser fires only its run and attention events. Hooks of `run` and `test` run
in the daemon, one at a time, with the environment of the command that
submitted the job (browser events: of the job that launched the browser, or
the last one it served for `browser.closed`); their output goes to the daemon
log.

```json
{
  "hooks": {
    "attention.needed": "notify-send webscoop \"$WEBSCOOP_RECIPE needs you\"",
    "run.done": ["~/bin/log-run.sh", "~/bin/sync-rows.sh"]
  },
  "hookTimeoutMs": 5000
}
```

A value is one command line or a list run in order. An unknown event name is
a config error. Each command runs with `/bin/sh -c` and the environment of
webscoop plus:

- `WEBSCOOP_EVENT`: the event name
- `WEBSCOOP_COMMAND`: `run`, `test`, `record`, `edit`, `bench`, or `browser`
- `WEBSCOOP_PROFILE`, `WEBSCOOP_PROFILE_DIR`: the profile name and directory
- `WEBSCOOP_BROWSER_PID`: the browser main process id, when known
- `WEBSCOOP_RECIPE`: the recipe name, when there is one
- `WEBSCOOP_RUN_ID`: unique to the webscoop invocation
- `WEBSCOOP_URL`: the page URL, when there is one
- `WEBSCOOP_REASON`: the attention reason, or the failure reason for `run.failed`

Stdin gets one JSON object with `event`, `at` (ISO timestamp), the same values
(`command`, `profile`, `profileDir`, `browserPid`, `recipe`, `runId`, `url`,
`reason`), the recipe's variable values as `vars` (only here, never in the
environment; secret variables left out), and the event's details: `kind`
(guard kind), `table` and `target` (re-pick target), and `page` for `attention.needed`; `outcome` for
`attention.resolved`; `rows`, `pages`, and `message` for `run.done` and
`run.failed`. Values are never substituted into the command line.

```sh
webscoop run bing --var query=cat   # a run.start hook running `jq -r .vars.query` prints cat
```

Hooks of one webscoop process run one at a time, in the order their events
fired. Only `browser.starting` holds up the command (the browser launches once
its hooks exit); webscoop waits for pending hooks before it exits. A command
that runs longer than `hookTimeoutMs` (default 5000) is killed. A command that
fails to start, exits non-zero, or times out is reported once on stderr and
never changes the exit code. Hook output goes to stderr, never to stdout.

`webscoop browser show [--profile name]` and `webscoop browser hide` find the
browser running on the profile (`--profile`, else `profiles.default`, else
`default`) and fire `browser.show` or `browser.hide` with its pid, for example
from a key binding to bring back a hidden browser. They exit 1 when no browser
runs on the profile, and warn when no hook is configured for the event.

`browser.args` adds Chromium arguments to every launch. `--class=webscoop`
sets the Wayland app id, so a window manager rule can place the window before
it ever shows.

#### Hyprland example

Hide the browser on a special workspace as it maps, bring it to your
workspace when a run needs you, and send it back once the need ends. Record
and edit sessions are shown right away.

`~/bin/webscoop-window` (Hyprland 0.56 with a Lua config; the classic
dispatchers are in the comments):

```sh
#!/bin/sh
pid=$WEBSCOOP_BROWSER_PID
[ -n "$pid" ] || exit 0
case "$1" in
  show)
    ws=$(hyprctl activeworkspace -j | jq -r .id)
    # classic: hyprctl dispatch movetoworkspace "$ws,pid:$pid"; hyprctl dispatch focuswindow "pid:$pid"
    hyprctl dispatch "hl.dsp.window.move({ workspace = \"$ws\", follow = false, window = \"pid:$pid\" })"
    hyprctl dispatch "hl.dsp.focus({ window = \"pid:$pid\" })"
    ;;
  hide)
    # classic: hyprctl dispatch movetoworkspacesilent "special:webscoop,pid:$pid"
    hyprctl dispatch "hl.dsp.window.move({ workspace = \"special:webscoop\", follow = false, window = \"pid:$pid\" })"
    ;;
esac
```

The window rule, in `hyprland.lua`:

```lua
hl.window_rule({ match = { class = "^(webscoop)$" }, workspace = "special:webscoop silent" })
```

or in a classic `hyprland.conf`:

```
windowrulev2 = workspace special:webscoop silent, class:^(webscoop)$
```

The config:

```json
{
  "browser": { "args": ["--class=webscoop"] },
  "hooks": {
    "browser.started": "case $WEBSCOOP_COMMAND in record|edit) ~/bin/webscoop-window show ;; esac",
    "attention.needed": "~/bin/webscoop-window show",
    "attention.resolved": "~/bin/webscoop-window hide",
    "browser.show": "~/bin/webscoop-window show",
    "browser.hide": "~/bin/webscoop-window hide"
  }
}
```

Runs on one profile share one browser window, each in its own tab; the run
that needs you brings its tab to the front, so `attention.needed` shows the
right page. A Hyprland key binding for `webscoop browser show` brings a hidden
run's browser back at any time, and one for `webscoop attention continue`
answers the waiting run without leaving the keyboard. `webscoop doctor` lists the configured hooks.

### Flows and the sequence

Some pages need a few actions before the data shows: accept a cookie banner,
fill a search term, open a tab, log in. A recipe records them as named
`flows`, each an ordered list of steps, and its `sequence` says what runs
when.

- Steps: `click` a button, link, or tab; `fill` an element by what it is
  (the value may use `{variable}` placeholders, filled from the variables'
  sources): a file input gets the files of a path list, and any other element
  filled from one path variable alone is clicked and the file chooser it opens
  within 5 seconds gets them; a checkbox, switch, or radio takes `true` or
  `false` and is clicked only when its state differs; a `select` chooses the
  option by value or visible label (one per line for a multiple select); a
  combobox is typed into and the visible option with that name is clicked;
  one-character OTP boxes get one key per character; anything else (text,
  date, textarea, editable element) is cleared and typed into with the events
  script frameworks listen to; `press` a key (`Enter`, `Escape`, `Tab`, or one
  character) on an element or on whatever has focus; `wait` a number of
  milliseconds or until an element shows up; `await-user` waits for you (see
  below).
- The sequence is the run program: `{ "flow": name }` runs a called flow,
  `{ "extract": table }` extracts a table on the main window's current page and
  emits its rows, and one `{ "paginate": { ..., "do": [...] } }` block repeats
  its `do` blocks on every page. So a recipe can extract a summary, click a tab
  of a single-page app whose URL never changes, and extract another table, or
  open a tab on every page before extracting it. A recipe whose sequence has no
  extract block only runs flows and succeeds with no rows.
- A reactive flow has a `trigger` (`{ "appears": target }`) instead of a place
  in the sequence. It fires whenever its target shows up, in any window of the
  run: after a page settles, before each step, before each extraction, and
  every second while the run waits for you. It does not fire again while its
  own steps run, at most `maxRetries` times (default 2) between two
  successful extractions (more fails the run with `flow-loop`, exit 1), and
  with `recover: true` the runner restores the page state afterwards. Use it
  for a cookie banner that comes and goes, or a login wall when a session
  expires mid-run.
- `await-user` pauses the run until its target appears or disappears (`until`),
  like a guard: it waits for the browser's attention, brings the window to the
  front, fires `attention.needed` with reason `await-user`, notifies, and
  shows the banner with the step's `label`. Continue checks at once, Abort
  ends the run. It draws on the guard timeout (or its own `timeoutMs`); when
  the time runs out the run fails with `paused` and exit 2, keeping the rows
  already emitted.
- `window: popup` makes a step act in the newest popup an earlier step of the
  same flow opened (a login window from `window.open`), waiting for it up to
  the navigation timeout. Extraction always reads the main window.
- Recovery restores the state the sequence built: after a guard clears or a
  reactive flow with `recover`, the runner reloads the URL where the current
  batch began (the start of the sequence, or the current page of `url`
  pagination) and replays the called flows that ran before the current point.
  On page 2 or later of `next` or `more` pagination that state cannot be
  rebuilt: the run fails with `pagination-lost` (exit 1), keeping the rows
  already emitted.
- Step targets go through the same healing ladder as fields (stored selectors,
  fingerprint, model) and are written back to their flow when they heal. A
  step reuses what worked on its first run until it stops matching.
- When a step's element is gone, an `optional` step is skipped and reported; a
  required one fails the run with exit 3 naming the flow and the step. A step
  that navigates the main window (a search submitted with Enter) is followed:
  guards are checked on the new page, and the next block runs there.

Stderr prints one line per flow run (`flow setup (called) on page 1`) and per
replayed or skipped step (`setup step 0 (click) on page 1: ok, candidate 0:
role=button|Accept all`); the summary line counts skipped steps and reactive
firings, and `--report` lists every flow run with its steps and outcomes
(`ok`, `healed`, `skipped`, `failed`). `test` runs flows like a run, so its
result matches what a run will do. `--skip-flows` runs no flow, called or
reactive, to see what the page looks like without them.

In the recorder, press `b` (or **Browse**) to use the page normally while the
panel records what you do into the active flow: a click becomes a `click`
step, typing into an input becomes one `fill` step with the final value, a
`select` change becomes a `fill` step, and Enter in an input becomes a `press`
step. The first recorded step creates a flow. Clicks in the panel are never
recorded; `b` or `Esc` stops. A picked element can also be added with **Add to
flow**, which does not perform the action, or **Add as await-user**. The Flows
section lists called and reactive flows; `Alt`+`F` opens the switcher to
choose the flow recording goes into. A flow's `…` menu replays, renames,
makes it reactive (pick the trigger element) or called, duplicates, deletes,
and for a reactive flow sets max retries and recover. Open a step with its
pencil to edit its value (insert a `{variable}` chip, or **make variable**),
window, and `optional`, or an await-user step's label, `until`, and timeout.
The Sequence section shows the blocks numbered, the paginate block with its
settings, and errors on the offending blocks (Save and Test run stay disabled
until they are fixed); it follows the draft until you move a block (drag, or
`Alt`+`Up` / `Alt`+`Down`), and **Reset to default** goes back. The panel's
**Test run** does not replay flows: you already performed them on the live
page.

The recorder runs in every window of the session: a popup the page opens
takes the panel, its steps get `window: popup`, and closing it hands the panel
back to its opener. A real click or key press in another window moves the
panel there. The window without it shows a rail (main window) or a strip
(popup); in a window narrower than 640 pixels the panel is a bar at the top
whose sheet holds the flows and Pick and Browse.

### Checking a recipe

```sh
webscoop test shop            # table on stdout, exit 0 or 3
webscoop test shop --json     # the same as a JSON array
```

`test` runs the recipe's first page with healing on and write-back off, runs
its flows (unless `--skip-flows`), prints
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

### Editing a recipe

```sh
webscoop edit shop                  # reopen the recipe with its fields loaded
webscoop edit shop --repick price   # pick one field again, save, and exit
```

`edit` opens the recipe, by name or path, in a recording session on its URL
with every table, field, and step loaded. Change what you need and press
**Ctrl+S** to save; close the window or press Ctrl+C to end. `--repick <field>`
skips the full session and re-picks one field (see below). `edit` takes the
same `--var`, `--profile`, `--timeout`, `--lock-timeout`, and `--force`
options as `record` and behaves exactly like `webscoop record --edit <recipe>`, which
keeps working.

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
the recipe unchanged. In a recipe with several tables, name the field as
`table.field` (`--repick questions.title`); a bare name works when only one
table has it. An unknown table or field, or a bare name several tables share,
exits 1 naming them. `run --interactive` shows
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
   **Pagination target** to record pagination: the sequence gets a paginate
   block around the active table's extract, and its settings (kind, limit,
   stop rules, driving table) are edited in the Sequence section.
5. **Test run** extracts the current page with the draft and shows a results
   drawer (table and JSON) with per-field status, one tab per table.
6. `Ctrl+S` saves to the recipes directory. Saving keeps the session open.

A picked form element also offers **Add to flow as fill**, prefilled with what
the element holds now (text, the chosen option, `true` or `false`, the
combobox text, or the OTP digits); the value is stored as literal text unless
you choose **make variable**. Browse mode records typing, option choices,
checkbox, switch, and radio toggles, combobox choices (one fill with the
option's label), OTP boxes (one fill on the first box), and chosen files the
same way. A password input becomes a secret variable named from its label,
`name`, or `id`: its value stays in the recorder for the session and is never
saved. A file input, or a button that opened a file chooser, becomes an empty
path variable; type the path in the variables list, which says whether each
file exists. The variables list shows each variable as `text`, `secret`,
`path`, or `external` (bound in the config or on the command line, read-only,
saved without a value); a text variable can be marked secret or switched to a
path.

The table strip above the field list holds one tab per table with its row
count. Picks, item detection, and new fields go to the active table; the
others stay collapsed until clicked. **+ Table** adds a table (named `page`
when every table has an item container), and the active table can be renamed
or removed. A pick outside the active table's items defaults to a table
without an item container, and the field form's **Table** select can send it
to any table or to a new one. To record a second list, add a table and pick
one of its items. A draft with one table named `items` saves in the shorthand
form; any other draft saves with `tables`. `--edit` loads every table of a
recipe.

Close the browser window or press `Ctrl+C` to end the session. The exit code
is 0 when the session ends, with a warning on stderr naming the recipe when
the draft has unsaved changes, and 1 on errors (invalid template, invalid
recipe under `--edit`, no display, browser failure).

| Key | In the panel |
| --- | ------------ |
| `p` | start picking |
| `b` | record steps into the active flow while you use the page (browse mode), or stop |
| `Alt`+`F` | choose the flow recording goes into; `1` to `9` pick one |
| `Esc` | cancel picking, close a menu, stop browse mode |
| `Alt`+click | pick through overlays while picking |
| `Enter` | confirm the proposed item container |
| `Left` / `Right` | walk the selection up and back down its ancestors |
| `Alt`+`Up` / `Alt`+`Down` | move the focused field, step, or sequence block |
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
navigates, replays the flows, extracts rows with the same value conversion,
walks the pagination with the same limit, stop rules, and dedup, and prints
rows like `webscoop run` does on a healthy site. Recipes with several tables
export too: the script extracts every table on each page, in sequence order,
dedups each item table on its own, and drives pagination from the driving
table.

The script runs any valid sequence the way the runner does: called flows,
extracts, and the paginate block in recipe order. Reactive flows fire at the
same checkpoints (after a page settles, before each step and each extraction,
and every second while waiting), with `maxRetries`, the `flow-loop` failure,
and `recover`, which reloads the batch URL and replays its called flows; on
page 2 or later of `next` or `more` pagination that fails with
`pagination-lost`. `window: popup` steps act in the newest popup the flow
opened, `frame` targets on tables, steps, and the pagination target resolve
inside their iframe, and `fill` sets each element by its kind with the
runner's own classifier (files, file choosers, checkboxes and switches,
radios, selects, comboboxes, one-character boxes, text). An `await-user` step
prints its label and condition on stderr, checks the condition every second in
every open window (Enter on a terminal checks at once), and exits 2 when
`--await-timeout` runs out.

Run the TypeScript script with `npx tsx shop.ts` in a directory where the
`playwright` package is installed (`npm install playwright`, then
`npx playwright install chromium`). The Python script needs Python 3.9 or
later with Playwright for Python (`pip install playwright`, then
`playwright install chromium`) and runs with `python3 shop.py`. Both take:

| Flag | Meaning |
| ---- | ------- |
| `--var name=value` | a recipe variable (repeatable); `WEBSCOOP_VAR_<NAME>` (uppercased) works too, the command line wins, recipe defaults fill the rest |
| `--var-file name=PATH` | a variable from a file's content, one trailing newline removed |
| `--var-command name=CMD` | a variable from the trimmed output of `/bin/sh -c CMD` |
| `--jsonl` | one JSON object per line instead of a JSON array (rows carry `_table` when several tables share the output) |
| `--out <path>` | rows to a file instead of stdout; a directory (existing, or ending with `/`) gets one `<table>.json` (or `.jsonl`) per table |
| `--table <name>` | only this table of a multi-table recipe, as a plain array (or plain JSONL rows) |
| `--pages <1\|N\|all>` | pages to walk, replacing the recipe limit (`all` stops at 500) |
| `--await-timeout <ms>` | how long an `await-user` step waits for you (default 600000) |
| `--headless` / `--headed` | run without or with a browser window (default: headed, or headless when exported with `--headless`) |
| `--profile <dir>` | keep the browser profile in this directory; without it each run uses a temporary profile removed at exit |

Use `--profile` for sites that need a login: run once headed, log in by hand
in the window, and later runs reuse the cookies. Exit codes are 0, 1, 2, and
3 with the meanings below; logs go to stderr. Secret variables are never
printed: their values are masked in every message. A `fill` whose value is a
path variable alone splits it on `:` and checks each file is readable before
the step acts.

The script tries each target's stored selector candidates in order and nothing
more. It does not include fingerprint healing, model healing, guards,
notifications, hooks, or recipe write-back; its header says so. When a
site changes, re-record (or `webscoop run` to heal) the recipe and export it
again rather than editing selectors in the script: the recipe stays the source
of truth.

### Stealth and network identity

webscoop always runs headed with a real, persistent profile, and hides the
usual automation flags. Sites with strong bot management can still spot stock
Playwright, so two opt-in settings go further:

- `browser.driver`: `playwright` (default) or `patchright`. Patchright is a
  build of the Playwright driver patched against the usual detection signals
  (the `Runtime.enable` side effects, the binding globals, the automation
  flags). It is installed with webscoop.
- `browser.channel`: `chromium` or `chrome`. The default is `chromium` with
  Playwright and `chrome` with Patchright. `chrome` launches the system Google
  Chrome: the first of `google-chrome-stable` and `google-chrome` on the
  `PATH`, else `/opt/google/chrome/chrome`. `browser.executablePath` and
  `WEBSCOOP_CHROMIUM` still override the binary.

The network identity matters as much as the driver. A proxy routes the
browser's traffic, and the timezone and locale should match the proxy's
location, or the mismatch gives the proxy away:

```json
{
  "browser": {
    "driver": "patchright",
    "proxy": { "server": "http://user:pass@proxy.example:8080", "bypass": "localhost,*.lan" },
    "timezone": "Europe/Madrid",
    "locale": "es-ES"
  }
}
```

- The proxy is taken from `--proxy <url>`, else the recipe's `browser.proxy`,
  else the config's `browser.proxy` (a URL string or an object with `server`
  and `bypass`). `--no-proxy` connects directly. Schemes: `http`, `https`,
  `socks5`. `run`, `test`, `record`, `edit`, and `bench` take both flags.
- Credentials go in the URL of the config or `--proxy`, or in
  `WEBSCOOP_PROXY_USERNAME` and `WEBSCOOP_PROXY_PASSWORD`. A recipe may name a
  proxy server but never credentials: recipes are meant to be shared. Every log
  and doctor line masks them (`http://***@proxy.example:8080`).
- `browser.timezone` (IANA, e.g. `America/New_York`) and `browser.locale`
  (BCP 47, e.g. `en-US`) set what the page sees in `Intl` and
  `navigator.language`, and the `Accept-Language` header. A recipe's values
  win over the config's. An invalid value exits 1 before a browser starts.

A recipe carries its own settings in an optional block:

```json
"browser": { "proxy": { "server": "http://proxy.example:8080", "bypass": ["localhost"] }, "timezone": "America/New_York", "locale": "en-US", "profile": "personal" }
```

`browser.profile` pins the recipe to a profile, above the config rules; see
[Profiles](#profiles).

#### Humanized input

Playwright acts faster and more evenly than any person: actions follow each
other within milliseconds, clicks jump the pointer to the element's centre,
text lands in one go, and scrolling jumps to the bottom. Behavioural bot
detection measures exactly that. Humanized input, off by default, makes runs
act more like a person:

- a long-tailed think time (median about half a second) before each click,
  typing, key press, option choice, or scroll
- clicks that move the pointer along a curved path with rising and falling
  speed to a random point inside the target, then press and release it
- typing one character at a time with uneven delays
- scrolling in uneven wheel steps with pauses
- a short dwell on every loaded page, with small pointer moves or a scroll,
  before anything is extracted

Turn it on per recipe with the "Humanize input" toggle in the recorder's
Recipe section, which saves `"browser": { "humanize": true }`. The config's
`browser.humanize` sets a default for every recipe, and `--humanize` or
`--no-humanize` on `run`, `test`, and `bench` wins over both. The start line
says `humanized input` when it is on.

Runs get noticeably slower: roughly 0.5 to 3 s per action, plus about a tenth
of a second per typed character, plus 1 to 2 s per page. Use it on sites with
serious bot protection, not everywhere. It complements the Patchright driver
and a proxy with a matching timezone and locale; it does not replace them, and
no input model beats every behavioural check.

Browsers never share a profile, because Chrome and Chromium of different
versions damage each other's profiles. Playwright's Chromium keeps
`profiles/<name>`, as before; Chrome uses `profiles/<name>@chrome`, and
Patchright's Chromium `profiles/<name>@patchright`. The first time a command
opens a suffixed profile beside an existing unsuffixed one, it warns that the
new profile has none of the old cookies or logins, so a login wall may pause
the run once. Each profile keeps a `.webscoop-browser.json` marker naming the
driver, channel, binary, and version that last opened it; a different binary
or a newer version in the marker than the one launching gets a warning. The
command carries on in both cases. `webscoop doctor` lists the driver, channel,
binary and version, the masked proxy, timezone and locale, and every profile
with the browser that last used it.

What this does not do: no fingerprint spoofing (canvas, WebGL, user agent),
which the headed real browser does not need and which tends to be detected
itself, and no humanized input timing, which is a separate option.

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
| Browser profiles | `$XDG_DATA_HOME/webscoop/profiles/<name>/` (`<name>@chrome/` and `<name>@patchright/` for other browsers) |
| Config | `$XDG_CONFIG_HOME/webscoop/config.json` (default `~/.config/webscoop/config.json`) |
| Daemon socket | `$XDG_RUNTIME_DIR/webscoop/daemon.sock` (else `/tmp/webscoop-<uid>/daemon.sock`) |
| Daemon log | `$XDG_STATE_HOME/webscoop/daemon.log` (default `~/.local/state/webscoop/daemon.log`) |

`WEBSCOOP_HOME=/some/dir` replaces both roots: recipes in `/some/dir/recipes/`,
profiles in `/some/dir/profiles/`, config at `/some/dir/config.json`, the
daemon socket at `/some/dir/run/daemon.sock`, its log at `/some/dir/daemon.log`.

Config file, all keys optional:

```json
{
  "browser": {
    "executablePath": "/path/to/chrome",
    "driver": "playwright",
    "channel": "chromium",
    "proxy": "http://user:pass@proxy.example:8080",
    "timezone": "Europe/Madrid",
    "locale": "es-ES",
    "args": ["--class=webscoop"]
  },
  "daemon": { "concurrency": { "total": 3, "perRecipe": 1, "recipes": { "bing": 2 } }, "idleMs": 60000 },
  "notify": true,
  "guards": { "banner": true },
  "hooks": { "attention.needed": "~/bin/webscoop-window show" },
  "hookTimeoutMs": 5000,
  "profiles": {
    "default": "main",
    "rules": [
      { "name": "^acme-admin-", "profile": "acme-admin" },
      { "host": "(^|\\.)acme\\.com$", "profile": "acme" }
    ]
  },
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

### Profiles

A profile holds the browser's cookies and logins. `run`, `test`, `record`,
`edit`, and `bench` pick it in this order, first match wins:

1. `--profile <name>`
2. the recipe's `browser.profile`
3. the first rule in the config's `profiles.rules` that matches the recipe
4. `profiles.default`
5. the recipe name

A rule has a `profile` and at least one of `host` and `name`, both JavaScript
regular expressions, unanchored (use `^` and `$` to anchor). `host` is tested
against the host name of the recipe URL filled with the command's variables;
`name` against the recipe name. When a rule has both, both must match. Put a
`name` rule above a `host` rule to give some recipes on a host their own
profile. An invalid pattern, a rule with neither key, or an invalid profile name
is a config error naming its JSON path. Profile names are names, never paths:
letters, digits, `.`, `_`, and `-`, starting with a letter or digit.

The start line of each command names the profile and where it came from, e.g.
`on profile "acme" (config rule 2)`. `webscoop doctor` lists the default, the
rules, and the profile each saved recipe resolves to.

When `record` or `edit` saves, it compares the profile the session used with the
profile the saved recipe would resolve to without a pin. When they differ (the
recipe was renamed during recording, or `--profile` was given), it writes the
used profile to `browser.profile`, so the next `run` opens the profile you
logged in with. When they are equal, it removes any pin, and the recipe keeps
following the config.

One shared profile (for example `profiles.default`) means runs of different
recipes share one browser, and with `daemon.concurrency.total` 1 they queue.
Raise `total` and set `perRecipe` 1 to run different recipes side by side,
one run per recipe, or use per-host rules to give them browsers of their own.

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

A recipe is one JSON document with `schemaVersion: 2`. The reference example,
used by the end-to-end tests, is
[`packages/cli/fixtures/playground-catalog.json`](packages/cli/fixtures/playground-catalog.json).
A file with another version fails to load with a message naming the file.

- `name`: kebab-case, unique among your recipes.
- `url`: template with `{variable}` placeholders; every placeholder must be
  declared in `vars` (`{ "name", "type": "string" | "path", "secret"?,
  "default"?, "description"? }`; see [Variables](#variables)). Values are
  URL-encoded when substituted.
- `item`: optional repeating container, `selectors` plus optional `exclude`.
  Without it, every field has scope `page` and the recipe yields one row.
- `fields`: `name`, `type` (`text`, `number`, `url`, `image`, `date`, `html`),
  `scope` (`item` or `page`), ranked `selectors`, optional `attr`, `optional`
  (default false), `fallback` (default false), `hover` (default false), `key`
  (at most one field), and `fingerprint`. `hover: true` moves the real mouse
  over the field's element before it is read, on every row (page fields once),
  for sites that write the real value on mouseover, such as result links whose
  `href` is swapped in by a `mouseover` handler. The pointer aims at the
  element's center, then just inside its top-left corner when the center is
  covered; a hover that fails reads the value as it is. With `--humanize` the
  pointer travels a humanized path and dwells 80 to 250 ms. False flags are
  left out when a recipe is saved. The recorder has a `hover` toggle on saved
  fields; its preview does not hover and badges those values "on hover".
- Selector candidates: `{ "strategy", "value", "stability" }` with strategy
  `role` (`"heading|Wireless Mouse"`: role, then optional exact accessible
  name), `testid`, `id`, `text` (exact), `css`, or `xpath`. The first candidate
  that matches wins.
- `fingerprint` (on the item and on fields): what the element looked like when
  it was recorded; fuzzy healing matches against it. Recipes without
  fingerprints skip that rung.
- `healing`: `fuzzyThreshold` (0 to 1, default 0.7) and `llm` (default true;
  false keeps the model rung off for this recipe).
- `guards`: `[{ "kind": "login" | "captcha" | "zero-fields", "enabled" }]`,
  all enabled by default; `enabled: false` turns one guard off for this
  recipe (see Guards).
- `tables`: several outputs, each with a kebab-case `name`, optional
  `description`, `frame`, and `item`, and its `fields`; the top level `item` and
  `fields` are the shorthand for one table named `items`. A recipe may have no
  tables at all when it only runs flows.
- `flows`: named flows (see Flows and the sequence), default `[]`. Each has a
  kebab-case `name`, an optional `description`, `steps`, and for a reactive
  flow a `trigger` (`{ "appears": target }`) with optional `maxRetries`
  (default 2) and `recover` (default false). Each step has `kind` (`click`,
  `fill`, `press`, `wait`, `await-user`), `target` (`selectors`, optional
  `fingerprint` and `frame`; required for `click`, `fill`, and `await-user`),
  `value` (required for `fill` and `press`; for `wait` a number of
  milliseconds when there is no target; `{variable}` placeholders in a `fill`
  value must be declared in `vars`), `until` (`appears` or `disappears`,
  required for `await-user`), `timeoutMs` (await-user only), `window` (`same`
  or `popup`, default `same`), `optional` (default false), and an optional
  `label` used in logs and the banner.
- `sequence`: the ordered blocks that run, required: `{ "flow": name }` (a
  called flow), `{ "extract": table }`, and at most one `{ "paginate": ... }`
  with `kind` (`url`, `next`, `more`, `scroll`), `target` (required for `next`
  and `more`), `param` (the page variable for `url`), `limit` (`1`, N, or
  `all`, default 1), `stopRules` (`no-new-items`, `first-item-repeats`,
  `target-missing`), `delayMs`, an optional driving `table`, and `do` (flow and
  extract blocks). Every table is extracted exactly once and every called flow
  is used; a reactive flow is never placed in the sequence.
- `frame`: for content inside a same-origin `<iframe>`, the iframe as a target
  (`selectors` and optional `fingerprint`), resolved in the top document. On a
  table (or the top level of a shorthand recipe) the item block, list parent,
  exclusions, and every field resolve inside that iframe's document; on a step
  `target` or the pagination `target`, that target does. The runner waits for
  the iframe's document to load, within the navigation timeout. A frame that
  does not resolve counts as its targets not resolving. Healing works inside
  the iframe, and a healed frame is written back like any target. One level
  only: a `frame` cannot hold another `frame`. The recorder sets a table's
  frame from its first field or item container picked inside an iframe, and
  shows it in the selection details and as a badge on fields and steps.
  [`packages/cli/fixtures/playground-framed.json`](packages/cli/fixtures/playground-framed.json)
  reads the playground's `/framed` page.

```json
"flows": [
  { "name": "search", "steps": [
    { "kind": "click", "target": { "selectors": [{ "strategy": "role", "value": "button|Accept all", "stability": "stable" }] }, "optional": true },
    { "kind": "fill", "target": { "selectors": [{ "strategy": "css", "value": "input[name=\"q\"]", "stability": "medium" }] }, "value": "{q}" },
    { "kind": "press", "value": "Enter" }
  ] },
  { "name": "login-wall", "trigger": { "appears": { "selectors": [{ "strategy": "role", "value": "button|Log in", "stability": "stable" }] } }, "recover": true, "steps": [
    { "kind": "click", "target": { "selectors": [{ "strategy": "role", "value": "button|Log in", "stability": "stable" }] } },
    { "kind": "await-user", "window": "popup", "until": "disappears", "label": "Log in to the portal", "target": { "selectors": [{ "strategy": "role", "value": "button|Log in", "stability": "stable" }] } }
  ] }
],
"sequence": [
  { "flow": "search" },
  { "paginate": { "kind": "next", "target": { "selectors": [{ "strategy": "role", "value": "link|Next", "stability": "stable" }] }, "limit": "all", "do": [{ "extract": "items" }] } }
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

Gates for flows keep the products out of the DOM until an action, so a recipe
without the flow finds nothing (exit 3). `gate=cookie` shows a consent modal
with a backdrop and an `Accept all` button (`#consent-accept`); the list waits
in a `template` until the click, which stores `ws_consent` in `localStorage`,
so later loads show no modal. `gate=search` shows a `GET` search form with an
input named `q` above an empty list; `q=<text>` lists the products whose title
contains the text, case-insensitive, in dataset order, and keeps the input
filled. `gate=tabs` shows two `role="tab"` buttons, `About` (active) and
`Products`; the list is inserted into the Products panel when that tab is
clicked, and nothing persists, so every page load needs the click. Gates
compose with tiers (their classes and ids churn too), `paginate`, and walls.

`hover=1` renders every product link with an obfuscated `href="/r/<token>"`
(tokens drawn from `seed`); the real `/p/<id>` URL is nowhere in the DOM. A
trusted `mouseover` on the link or its descendants swaps in the real URL
synchronously; script-dispatched events do not. It combines with every tier
and seed.
[`packages/cli/fixtures/playground-hover.json`](packages/cli/fixtures/playground-hover.json)
reads the links with a `hover` field.

`/framed` is a menu page whose content lives in same-origin iframes:
`iframe#frame-catalog` loads `/framed/inner?view=catalog` (the first 8
products as catalog cards) and `iframe#frame-about` loads
`/framed/inner?view=about` (text only). The menu buttons show one iframe and
hide the other without changing the URL; the catalog is shown unless
`show=about`. Inside the catalog iframe a `Details` button (`#details-toggle`)
fills a details panel with the first product's description, so reading it
needs a step inside the iframe.
[`packages/cli/fixtures/playground-framed.json`](packages/cli/fixtures/playground-framed.json)
reads both.

`/forms` is one form with a labeled instance of every input kind a `fill`
step sets: text, email, password, textarea, a select and a multiple select, a
checkbox, a radio group, a `role="switch"` element, a date input, a controlled
input whose value lives in script state (setting the element's value without
events is lost), a `role="combobox"` input with a filtered option list, six
one-character OTP boxes, a contenteditable element, an input in an open shadow
root, a visible file input, a hidden file input behind a `Select file` button,
and a dropzone that opens a hidden file input on click. Submit posts every
value to `/forms/submit`, which shows them as JSON in `#echo`, files as their
names and sizes.

`/spa` is a single-page app whose URL never changes after load. Logged out it
shows a `Log in` button (`#spa-login`) that opens `/spa/login` with
`window.open`, a 500 by 600 popup with user and password inputs and a
`Sign in` button; any non-empty pair sets the `ws_spa` cookie and closes the
popup, and `/spa` notices within a second (it polls `/spa/session`) and shows
its menu: `Catalog` (the dataset's cards, 8 per page, with a client-side
`Next` button disabled on the last page) and `Report` (a heading and a total).
`/spa?ttl=N` ends the session N seconds after login, and the page shows the
`Log in` button again without changing the URL. A reload while logged in
shows the menu with no section open.

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
  cli         webscoop command, paths, config, profile lock, output, browser daemon
  llm         OpenAI-compatible chat client, endpoint probe, scripted mock
  inject      recorder UI injected into the page (React in a closed shadow root, esbuild IIFE)
  playground  fixture site, dataset, tier renderers
e2e/          Playwright tests that run the built CLI against the playground
```

`packages/core` must not import Playwright, Node APIs, or other workspace
packages; `npm run lint` enforces it.

## License

[MIT](LICENSE)
