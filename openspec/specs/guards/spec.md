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
When a guard is raised, the runner SHALL enter a paused state, bring the browser window to the front, and send one desktop notification with the recipe name, the guard kind, and the page number. It SHALL NOT send more than one notification per guard occurrence. While paused, no rows SHALL be emitted and no navigation SHALL be initiated by the runner.

#### Scenario: Notification sent once
- **WHEN** a `login` guard is raised on page 2 of recipe `shop`
- **THEN** exactly one notification naming `shop`, `login`, and page 2 is sent

### Requirement: Clearing and resuming
While paused, the runner SHALL re-evaluate the guard at least every second. The guard clears when the detection rule no longer matches and the page has settled. After clearing, if the current URL differs from the intended URL for that page, the runner SHALL navigate to the intended URL, wait for it to settle, and re-check guards once before extracting. Resuming SHALL continue the run at the same page number and preserve rows already emitted.

#### Scenario: User logs in and is redirected back
- **WHEN** the user submits the login form and the site redirects to `/catalog`
- **THEN** the guard clears and extraction proceeds on `/catalog` as page 1

#### Scenario: User lands on the home page after login
- **WHEN** the user logs in and the site redirects to `/`
- **THEN** the runner navigates to the intended catalog URL and extracts it

#### Scenario: Guard on page 3 of a paginated run
- **WHEN** pages 1 and 2 were emitted and page 3 raises a `captcha` guard which the user clears
- **THEN** page 3 is extracted and the run continues with page 4

### Requirement: Guard timeout
A run SHALL wait at most the guard timeout (default 600000 milliseconds, configurable per run) across all guards in that run. When the timeout elapses while paused, the runner SHALL stop with failure reason `paused`, rows already emitted SHALL remain emitted, no recipe write-back SHALL occur, and the process SHALL exit 2. A timeout of 0 SHALL fail immediately on the first guard.

#### Scenario: Timeout in cron
- **WHEN** a guard is raised and nobody clears it within the timeout
- **THEN** the run exits 2 and stderr names the guard kind and the page

#### Scenario: Zero timeout
- **WHEN** the guard timeout is 0 and a `login` guard is raised
- **THEN** the run exits 2 immediately after the notification

### Requirement: Interactive banner
When the run is interactive, the runner SHALL show a banner over the page while paused with the guard kind, a short reason, a countdown to the timeout, and Continue and Abort actions. Continue SHALL trigger an immediate re-check; Abort SHALL end the run with failure reason `aborted` and exit 1. The banner SHALL be removed when the guard clears. Unattended runs SHALL NOT inject anything into the page.

#### Scenario: Continue re-checks
- **WHEN** the user logs in on another tab and clicks Continue
- **THEN** the guard is re-evaluated at once and, if cleared, the run resumes

#### Scenario: Unattended run injects nothing
- **WHEN** a guard is raised in a non-interactive run
- **THEN** the page contains no recorder elements

### Requirement: Guard reporting
The run report SHALL list every guard occurrence with kind, page number, URL where it was detected, wait time, and whether it cleared or timed out. Events `guard.raised`, `guard.cleared`, and `guard.timeout` SHALL be emitted with kind, page, and URL. The stderr summary SHALL mention the number of guards cleared when non-zero.

#### Scenario: Report after a cleared guard
- **WHEN** a `login` guard on page 1 clears after 12 seconds
- **THEN** the report lists one guard entry with kind `login`, page 1, cleared, and a wait time near 12 seconds
