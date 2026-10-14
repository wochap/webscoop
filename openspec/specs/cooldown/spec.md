# cooldown Specification

## Purpose

Keeps a recipe off its site for a while after a run fails on a login or captcha wall, so repeated runs do not hit the wall again and get the profile or IP banned. The user can still clear the wall in the tab that is left open.

## Requirements

### Requirement: Recipe goes cold
A recipe SHALL become cold when one of its `run` or `test` jobs ends while paused on a `login` or `captcha` guard, either because the guard timeout elapsed (failure reason `paused`) or because the user sent abort (banner Abort, `a` at the terminal prompt, or `webscoop attention abort`). A wait on an `await-user` step, a `zero-fields` guard, SIGINT, or a lost connection SHALL NOT make a recipe cold. Cold state SHALL be keyed by recipe name, apply to every profile, and be kept in `cooldowns.json` in the webscoop state directory so it survives the daemon exiting. Each entry SHALL record the guard kind, page number, URL, when the recipe went cold, when it warms up, and its streak. The cold period SHALL start when the job ends and last `guards.cooldownMs` multiplied by 2 to the power of (streak - 1), capped at `guards.cooldownMaxMs`. The streak SHALL be 1 for the first cold period and increase by 1 each time the recipe goes cold again before a run of it ends without making it cold. When `guards.cooldownMs` is 0, no recipe SHALL become cold and existing cold state SHALL be ignored.

#### Scenario: Timeout makes the recipe cold
- **WHEN** `webscoop run shop` times out on a `captcha` guard on page 2 and `guards.cooldownMs` is not set
- **THEN** `shop` is cold for 60 seconds with kind `captcha`, page 2, and streak 1

#### Scenario: Abort makes the recipe cold
- **WHEN** a run of `shop` is paused on a `login` guard and the user clicks Abort in the banner
- **THEN** the run exits 1 with failure reason `aborted` and `shop` is cold

#### Scenario: Await-user timeout does not
- **WHEN** an `await-user` step of `shop` times out
- **THEN** the run exits 2 and `shop` is not cold

#### Scenario: Test with a zero guard timeout
- **WHEN** `webscoop test shop` hits a `captcha` wall and exits 2 at once
- **THEN** `shop` is cold

#### Scenario: Repeated walls double the period
- **WHEN** `guards.cooldownMs` is 60000, `guards.cooldownMaxMs` is 180000, and `shop` goes cold three times in a row with no run in between ending without making it cold
- **THEN** the cold periods last 60, 120, and 180 seconds

#### Scenario: Survives the daemon
- **WHEN** `shop` goes cold, the daemon exits, and `webscoop run shop` is executed 20 seconds later
- **THEN** the run is refused as cold

#### Scenario: Cooldowns off
- **WHEN** `guards.cooldownMs` is 0 and a run of `shop` times out on a guard
- **THEN** `shop` is not cold and the walled tab closes when the run ends

### Requirement: Runs of a cold recipe are refused
When a `run` or `test` job is submitted for a cold recipe without `--ignore-cooldown`, it SHALL open no tab, start no browser, and make no request. It SHALL end with failure reason `cold` and exit 2, and fire the `run.failed` hook with that reason. Stderr SHALL name the recipe, the guard kind, the page, the URL, the local time the recipe warms up, and say that `--ignore-cooldown` runs it anyway; `--quiet` SHALL NOT suppress this line. The first refused job of a cold period SHALL send one desktop notification when notifications are on, naming the recipe, the guard kind, and the warm-up time, and SHALL bring the recipe's cold tab to the front when it has one. Later refused jobs of the same period SHALL send no notification and bring nothing to the front.

#### Scenario: Cron run during the cooldown
- **WHEN** `shop` went cold on a `captcha` guard on page 2 at 12:03:00 and cron runs `webscoop run shop` at 12:03:30
- **THEN** no tab is opened, stderr names `captcha`, page 2, and 12:04:00, and the exit code is 2

#### Scenario: One notification per cold period
- **WHEN** `shop` is cold and three runs of it are refused
- **THEN** exactly one desktop notification is sent

#### Scenario: Other recipes are not affected
- **WHEN** `shop` is cold and `webscoop run news` is executed
- **THEN** `news` runs normally

### Requirement: Jobs of a recipe that goes cold
When a recipe becomes cold, its jobs still waiting in the daemon queue and its jobs waiting for attention SHALL end with failure reason `cold` and exit 2 without reloading, navigating, or opening a tab. Rows already emitted by a job waiting for attention SHALL remain emitted. A running job of that recipe that later raises a guard SHALL end with failure reason `cold` instead of waiting for attention. A running job that raises no guard SHALL continue.

#### Scenario: Queued job ends
- **WHEN** jobs A and B of `shop` are submitted, B is queued behind A, and A times out on a guard
- **THEN** B ends with exit 2 and failure reason `cold` without opening a tab

#### Scenario: Job waiting for attention ends without a reload
- **WHEN** job C of `shop` waits for attention for a guard held by job A of `shop`, and A times out
- **THEN** C ends with exit 2 and its page is not reloaded

### Requirement: Cold tab
When a job makes its recipe cold, its tab SHALL stay open as the recipe's cold tab until the recipe warms up, and any popup opened from it SHALL close. A recipe SHALL have at most one cold tab; a newer one SHALL replace the older one. The daemon SHALL re-evaluate the guard that made the recipe cold in the cold tab at least every second, without reloading or navigating. When the detection rule no longer matches and the page has settled, the recipe SHALL warm up. While the cold tab is open and `guards.banner` is not false, it SHALL show a banner naming the guard kind, saying the recipe is cold until the warm-up time, with a Continue action that re-checks at once. When the user closes the cold tab, the recipe SHALL stay cold until its period ends.

#### Scenario: User solves the wall later
- **WHEN** `shop` is cold on a `captcha` guard and the user solves the captcha in the cold tab 30 seconds in
- **THEN** `shop` warms up within about one second, the cold tab closes, and the next `webscoop run shop` runs

#### Scenario: No reloads while cold
- **WHEN** `shop` stays cold for its whole 60 second period and nobody touches the cold tab
- **THEN** the cold tab makes no navigation or reload

#### Scenario: Banner off
- **WHEN** `guards.banner` is false and `shop` goes cold
- **THEN** the cold tab shows no banner and still re-checks the guard

### Requirement: Recipe warms up
A cold recipe SHALL warm up when its cold period ends, when its guard clears in its cold tab, or when `webscoop cooldown clear` names it. Warming up SHALL end its cold period and close its cold tab. A run of the recipe that ends without making it cold, including a run with `--ignore-cooldown`, SHALL warm it up and reset its streak, so its next cold period starts at streak 1. Warming up in any other way SHALL keep the streak.

#### Scenario: Period ends
- **WHEN** `shop` went cold 60 seconds ago with a 60 second period
- **THEN** its cold tab closes and `webscoop run shop` runs

#### Scenario: Override run succeeds
- **WHEN** `shop` is cold with streak 2 and `webscoop run shop --ignore-cooldown` succeeds
- **THEN** `shop` is warm, its cold tab is closed, and its next cold period lasts `guards.cooldownMs`

#### Scenario: Override run hits the wall again
- **WHEN** `shop` is cold with streak 1 and `webscoop run shop --ignore-cooldown` times out on a guard
- **THEN** `shop` is cold with streak 2 and the new run's tab replaces the old cold tab

### Requirement: Cooldown commands
`webscoop cooldown list` SHALL print one line per cold recipe with its name, guard kind, page, URL, warm-up time, and streak, and print nothing to stdout when no recipe is cold. `--json` SHALL print an array of objects with `recipe`, `kind`, `page`, `url`, `since`, `until`, and `streak`, times as ISO 8601. `webscoop cooldown clear <recipe>` SHALL warm that recipe up and print that it is warm; when it is not cold it SHALL say so and exit 0. `webscoop cooldown clear --all` SHALL warm every cold recipe. `clear` with neither a recipe nor `--all`, or with both, SHALL exit 1. Neither command SHALL start the daemon; `clear` SHALL tell a running daemon to close the cold tabs it warms.

#### Scenario: List cold recipes
- **WHEN** `shop` is cold and `news` is not, and the user runs `webscoop cooldown list --json`
- **THEN** stdout holds an array with one object whose `recipe` is `shop`

#### Scenario: Clear closes the cold tab
- **WHEN** `shop` is cold with its cold tab open and the user runs `webscoop cooldown clear shop`
- **THEN** the cold tab closes, the exit code is 0, and `webscoop run shop` runs

#### Scenario: Clear a warm recipe
- **WHEN** `news` is not cold and the user runs `webscoop cooldown clear news`
- **THEN** stderr says `news` is not cold and the exit code is 0

### Requirement: Cooldown config
The config file MAY declare `guards.cooldownMs`, a non-negative integer (default 60000), and `guards.cooldownMaxMs`, a positive integer (default 1800000). A `cooldownMaxMs` lower than `cooldownMs` SHALL fail config validation. A job SHALL use the values of the config read by the command that submitted it.

#### Scenario: Longer base period
- **WHEN** the config sets `guards.cooldownMs` to 300000 and a run of `shop` times out on a guard
- **THEN** `shop` stays cold for 5 minutes

#### Scenario: Invalid cap
- **WHEN** the config sets `guards.cooldownMs` to 600000 and `guards.cooldownMaxMs` to 60000
- **THEN** config validation fails naming `guards.cooldownMaxMs`
