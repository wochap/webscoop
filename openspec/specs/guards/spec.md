# guards Specification

## Purpose

Defines how a run recognizes that a page is asking for a human (login, bot challenge, or an interstitial), how it pauses and hands the browser to the user, how it resumes, and what it reports. Guards protect recipes from being blamed for walls that are not their fault.

## Requirements

### Requirement: Guard kinds and detection rules
The runner SHALL evaluate enabled guards on every page. Detection SHALL be:
- `login`: the final URL path after navigation matches a login pattern (`/login`, `/signin`, `/sign-in`, `/account/login`, `/auth`, `/sso`, case-insensitive) while the intended URL did not, or a visible `input[type=password]` exists and the item container resolves nothing.
- `captcha`: a frame or element whose `src`, `id`, or class contains `turnstile`, `recaptcha`, `hcaptcha`, `challenge`, `cf-chl`, or `arkose`, or the page was served with HTTP 403 or 429 and its visible text contains `verify`, `robot`, `human`, or `challenge`.
- `zero-fields`: the item container and every required field resolve nothing after the healing ladder, and either the HTTP status is 400 or higher or the page's visible text is under 500 characters.
`login` and `captcha` SHALL be evaluated after the page settles and before extraction; `zero-fields` after extraction. When several guards match, the first in the order `captcha`, `login`, `zero-fields` SHALL be reported.

#### Scenario: Redirect to login
- **WHEN** navigating to `/catalog` lands on `/login?next=/catalog`
- **THEN** a `login` guard is raised for that page

#### Scenario: Challenge page
- **WHEN** the page is served with 403 and contains an iframe whose `src` contains `turnstile`
- **THEN** a `captcha` guard is raised

#### Scenario: Redesign is not a guard
- **WHEN** the page is served with 200, has over 500 characters of visible text, and no field resolves
- **THEN** no guard is raised and the missing-field policy applies

### Requirement: Enablement
Guards SHALL be evaluated only when enabled in the recipe's `guards` list (all enabled by default) and not disabled for the run. When guards are disabled, the run SHALL behave as if no guard existed.

#### Scenario: Recipe disables captcha
- **WHEN** the recipe sets `captcha` to disabled and a challenge page is served
- **THEN** no guard is raised and the page is extracted as is

### Requirement: Pause, notify, and focus
When a guard is raised, the runner SHALL enter a paused state. Once the run holds attention for its browser, as defined by the browser-daemon capability, and the guard is still present, the runner SHALL bring its tab to the front and, when notifications are on as defined by the cli capability, send one desktop notification with the recipe name, the guard kind, and the page number. It SHALL NOT send more than one notification per guard occurrence, and SHALL send none when the guard cleared while the run waited for attention. While paused, no rows SHALL be emitted and no navigation SHALL be initiated by the runner, except the reload that re-checks the guard after waiting for attention.

#### Scenario: Notification sent once
- **WHEN** a `login` guard is raised on page 2 of recipe `shop`
- **THEN** exactly one notification naming `shop`, `login`, and page 2 is sent

#### Scenario: No notification after another run's solve
- **WHEN** a run waits for attention on a captcha and the captcha is gone when it reloads
- **THEN** no notification is sent for it

#### Scenario: Notifications off
- **WHEN** notifications are off and a `login` guard is raised
- **THEN** the tab is brought to the front, the run pauses, and no notification is sent

### Requirement: Clearing and resuming
While paused, the runner SHALL re-evaluate the guard at least every second. The guard clears when the detection rule no longer matches and the page has settled. After clearing, the runner SHALL restore the page state as defined by the flows capability's "Recovery" requirement and continue at the same point of the sequence and the same page number. Rows already emitted SHALL be preserved.

#### Scenario: User logs in and is redirected back
- **WHEN** the recipe has no flow before its extraction, and the user submits the login form and the site redirects to the recipe URL
- **THEN** the guard clears and extraction proceeds on that page as page 1

#### Scenario: User lands on the home page after login
- **WHEN** the user logs in and the site redirects to `/`
- **THEN** the runner navigates to the recipe URL and extracts it

#### Scenario: Guard on page 3 of a paginated run
- **WHEN** pages 1 and 2 were emitted and page 3 of `url` pagination raises a `captcha` guard which the user clears
- **THEN** page 3 is extracted and the run continues with page 4

### Requirement: Guard timeout
A run SHALL wait at most the guard timeout (default 600000 milliseconds, configurable per run) across all guards in that run, counting only time while the run holds attention; time spent waiting for attention SHALL NOT count. When the timeout elapses while paused, the runner SHALL stop with failure reason `paused`, rows already emitted SHALL remain emitted, no recipe write-back SHALL occur, and the process SHALL exit 2. A timeout of 0 SHALL fail immediately once the run holds attention and the guard is still present.

#### Scenario: Timeout in cron
- **WHEN** a guard is raised and nobody clears it within the timeout
- **THEN** the run exits 2 and stderr names the guard kind and the page

#### Scenario: Zero timeout
- **WHEN** the guard timeout is 0 and a `login` guard is raised
- **THEN** the run exits 2 immediately after the notification

#### Scenario: Waiting for attention does not count
- **WHEN** the guard timeout is 60000, a run waits 90 seconds for attention held by another run, then gets attention with its guard still present
- **THEN** it still has 60 seconds to be cleared

### Requirement: Interactive banner
While a run holds attention for a guard or an `await-user` step, the runner SHALL show a banner over the page of the window that needs the user. The banner SHALL show the guard kind or the step's label, a short reason, a countdown to the timeout, and Continue and Abort actions, in every run, interactive or not. For an `await-user` step, the hint under the label SHALL name the condition the run waits for: "Continues when <target> appears." or "Continues when <target> disappears.", where <target> is the step target's primary selector written as the panel's selector chip writes it (for example `button "Log in"` for a role selector, `"Next"` for a text selector). When the step has no target, the hint SHALL stay generic. Continue SHALL trigger an immediate re-check. Abort SHALL end the run with failure reason `aborted` and exit 1. The banner SHALL be removed when attention resolves. When the config sets `guards.banner` to false, no banner SHALL be shown and nothing SHALL be injected into the page of an unattended run. Outside attention, unattended runs SHALL NOT inject anything into the page. In a window narrower than 640 pixels the banner SHALL span the full width at the top.

#### Scenario: Continue re-checks
- **WHEN** the user logs in on another tab and clicks Continue
- **THEN** the guard is re-evaluated at once and, if cleared, the run resumes

#### Scenario: Banner in an unattended run
- **WHEN** a non-interactive run holds attention for a captcha and `guards.banner` is not set
- **THEN** the page shows the banner with Continue and Abort, and the banner is gone after the captcha clears

#### Scenario: Unattended run injects nothing
- **WHEN** `guards.banner` is false and a guard is raised in a non-interactive run
- **THEN** the page contains no recorder elements

#### Scenario: Await-user banner in a popup
- **WHEN** an `await-user` step labeled "Log in to SOL" runs in a 500 pixel wide popup
- **THEN** the popup shows the banner across its top with that label, and the main window shows none

#### Scenario: Await-user banner names its condition
- **WHEN** an `await-user` step labeled "Log in to SOL" waits until its target `role=button|Log in` disappears
- **THEN** the banner shows "Log in to SOL" with the hint `Continues when button "Log in" disappears.`

#### Scenario: Await-user banner for an appearing element
- **WHEN** an `await-user` step waits until its target `css=#dashboard` appears
- **THEN** the banner hint reads "Continues when #dashboard appears."

### Requirement: Guard reporting
The run report SHALL list every guard occurrence with kind, page number, URL where it was detected, wait time, and whether it cleared or timed out. Events `guard.raised`, `guard.cleared`, and `guard.timeout` SHALL be emitted with kind, page, and URL. The stderr summary SHALL mention the number of guards cleared when non-zero.

#### Scenario: Report after a cleared guard
- **WHEN** a `login` guard on page 1 clears after 12 seconds
- **THEN** the report lists one guard entry with kind `login`, page 1, cleared, and a wait time near 12 seconds

### Requirement: Frame-aware item checks
Where guard detection checks whether a table's item container or required fields resolve, it SHALL resolve them through the table's `frame` as the runner does. A frame that does not resolve SHALL count as the items not resolving. Other detection rules SHALL look at the top document only.

#### Scenario: Framed items count as present
- **WHEN** a recipe's only table has `frame` `id=app`, the iframe shows 8 cards, and the top page has a visible password input elsewhere
- **THEN** the `login` guard is not raised
