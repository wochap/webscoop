# browser-launch Specification

## Purpose

Defines how webscoop opens its browser: which automation driver and browser binary run a session, the network identity the browser presents (proxy, timezone, locale), and how browser profiles are kept apart per browser so that switching browsers never corrupts a profile.

## Requirements

### Requirement: Driver choice
The config key `browser.driver` SHALL accept `playwright` (default) and `patchright`. Every command that opens a browser (`run`, `test`, `record`, `bench`) SHALL launch it through the configured driver. Both drivers SHALL launch headed with the persistent profile, the same flags that hide automation, and the same recorder, runner, and window behavior. With `patchright`, the recorder SHALL work as with `playwright`: injection, the page-to-host binding, and messages to the page. When `patchright` is configured but not installed, the command SHALL exit 1 with a message naming the missing package, without starting a browser.

#### Scenario: Default driver
- **WHEN** the config has no `browser.driver` and `webscoop run shop` is executed
- **THEN** the run uses Playwright and Playwright's Chromium exactly as before this change

#### Scenario: Patchright run
- **WHEN** `browser.driver` is `patchright` and `webscoop run shop` is executed
- **THEN** the run launches through Patchright and emits the same rows as a Playwright run of the same page

#### Scenario: Recorder under Patchright
- **WHEN** `browser.driver` is `patchright` and `webscoop record --edit shop` is executed
- **THEN** the recorder panel appears, picks reach the host, and saving writes the recipe

### Requirement: Browser choice
The config key `browser.channel` SHALL accept `chromium` and `chrome`. It SHALL default to `chromium` with the `playwright` driver and to `chrome` with the `patchright` driver.
- `chromium` SHALL use the Chromium build the driver expects.
- `chrome` SHALL use the system Google Chrome. The binary SHALL be the first of `google-chrome-stable` or `google-chrome` found on `PATH`, else `/opt/google/chrome/chrome`.
- `browser.executablePath` or `WEBSCOOP_CHROMIUM`, when set, SHALL override the binary for either channel.

When the chosen binary does not exist, the command SHALL exit 1 naming the channel and the paths it tried.

#### Scenario: Chrome from PATH
- **WHEN** `browser.channel` is `chrome` and `google-chrome-stable` is on the `PATH` at `/run/current-system/sw/bin/google-chrome-stable`
- **THEN** the browser is launched from that path

#### Scenario: Chrome missing
- **WHEN** `browser.channel` is `chrome` and no Chrome binary is found
- **THEN** stderr names the channel and the paths tried, and the exit code is 1

### Requirement: Proxy
The browser SHALL be launched with a proxy when one is resolved. The proxy SHALL come from the first of these that is set:
1. `--proxy <url>`
2. the recipe's `browser.proxy`
3. the config's `browser.proxy`

`--no-proxy` SHALL disable any proxy. A proxy URL SHALL use `http`, `https`, or `socks5`, and MAY carry a bypass list of hosts. Credentials SHALL be taken from the URL's user info when the proxy comes from `--proxy` or the config, else from `WEBSCOOP_PROXY_USERNAME` and `WEBSCOOP_PROXY_PASSWORD`. Credentials SHALL never be printed: every log line and doctor line that shows a proxy SHALL mask them. An invalid proxy URL SHALL exit 1 before a browser starts.

#### Scenario: Recipe proxy overrides config
- **WHEN** the config sets `browser.proxy` to `http://proxy-a:8080` and the recipe sets `browser.proxy` to `http://proxy-b:8080`
- **THEN** the run's browser traffic goes through `proxy-b`

#### Scenario: Flag overrides recipe
- **WHEN** `webscoop run shop --proxy socks5://127.0.0.1:1080` is executed for that recipe
- **THEN** the browser traffic goes through `127.0.0.1:1080`

#### Scenario: No proxy
- **WHEN** `webscoop run shop --no-proxy` is executed while the config and the recipe declare proxies
- **THEN** the browser connects directly

#### Scenario: Credentials masked
- **WHEN** the config proxy is `http://user:secret@proxy-a:8080` and `webscoop run shop` logs its start
- **THEN** no stderr line contains `secret`

### Requirement: Timezone and locale
The browser context SHALL use the timezone and the locale resolved from the recipe's `browser.timezone` and `browser.locale`, else the config's, else the system defaults. The timezone SHALL be an IANA identifier, and the locale SHALL be a BCP 47 tag. An invalid value SHALL exit 1 naming it, before a browser starts. The page SHALL observe the resolved values through `Intl.DateTimeFormat().resolvedOptions().timeZone` and `navigator.language`.

#### Scenario: Timezone matches the proxy
- **WHEN** the recipe sets `browser.timezone` to `America/New_York` and `browser.locale` to `en-US`
- **THEN** the page reports the timezone `America/New_York` and the language `en-US`

#### Scenario: Invalid timezone
- **WHEN** the config sets `browser.timezone` to `Mars/Base`
- **THEN** stderr names `Mars/Base` and the exit code is 1

### Requirement: Profile per browser
The profile directory for a profile name SHALL depend on the browser:

| Browser | Profile directory |
|---|---|
| `playwright` driver with the `chromium` channel, with or without a binary override | `profiles/<name>` |
| `patchright` driver with the `chromium` channel | `profiles/<name>@patchright` |
| `chrome` channel, with either driver | `profiles/<name>@chrome` |

The `playwright` + `chromium` row is today's path.

Each launch SHALL write a marker file `.webscoop-browser.json` in the profile directory with the driver, channel, binary path, and browser version. When a profile is opened whose marker names a different binary path or a newer major version than the launching browser, stderr SHALL warn naming both, and the command SHALL continue.

When a suffixed profile directory does not exist yet and the unsuffixed profile of the same name does, stderr SHALL warn that the new profile does not carry the other profile's cookies or logins and that a login wall may pause the run. The command SHALL continue.

The profile lock SHALL apply per profile directory.

#### Scenario: Existing profile kept
- **WHEN** a user upgrades with the default config and runs `webscoop run shop`
- **THEN** the run uses `profiles/shop` as before, with its cookies

#### Scenario: Chrome gets its own profile
- **WHEN** `shop` was recorded with Playwright's Chromium in `profiles/shop`, then `browser.channel` is set to `chrome` and `webscoop run shop` is executed
- **THEN** the run uses `profiles/shop@chrome`, stderr warns that this profile has no cookies from `profiles/shop`, and the run continues

#### Scenario: Browser changed under a profile
- **WHEN** `WEBSCOOP_CHROMIUM` points at a different Chromium binary than the one recorded in the marker of the profile in use
- **THEN** stderr warns naming the old and the new binary, and the command continues

#### Scenario: Marker written
- **WHEN** any command opens a profile
- **THEN** the profile directory contains `.webscoop-browser.json` naming the driver, channel, binary, and version used

### Requirement: Humanized input
A browser session SHALL support a humanized input mode. Whether it is on SHALL be decided by the first setting present:
1. the `--humanize` or `--no-humanize` flag
2. the recipe's `browser.humanize`
3. the config's `browser.humanize`
4. otherwise off

With the mode off, the session's clicks, typing, key presses, option choices, and scrolling SHALL behave as without this capability.

With the mode on:
- **Think time.** Before each click, typing, key press, option choice, or scroll, the session SHALL wait a think time drawn from a long-tailed distribution. The median SHALL be between 300 and 900 ms, and every wait SHALL be at most 5 s. Waits SHALL NOT be drawn from a uniform distribution.
- **Clicks.**
  - A click SHALL scroll the target into view, then move the pointer from its current position along a curved path of several intermediate points with speed that rises and falls.
  - The path SHALL end at a random point inside the target's box, away from its edges, not at its exact centre every time.
  - The click SHALL press and release the button with a hold of 40 to 200 ms.
- **Typing.** Typing SHALL focus the target by a humanized click, clear it, and type the value one character at a time. Inter-key delays SHALL come from a long-tailed distribution with a median between 60 and 180 ms. For values longer than 200 characters, delays MAY be shortened so that typing one value takes at most 20 s.
- **Scrolling.** Scrolling to the bottom SHALL use several wheel steps of varying size with pauses between them.
- **Dwell.** After each page load and each navigation caused by an action, the session SHALL dwell before extraction for a long-tailed time with a median between 800 and 2500 ms. During that time it SHALL make at least one small pointer move or scroll.

Timeouts SHALL apply to the underlying element waits only, not to the added human delays. A humanized action SHALL succeed or fail on the same targets as a plain action.

#### Scenario: Off by default
- **WHEN** neither a flag, the recipe, nor the config sets humanize and `webscoop run shop` is executed
- **THEN** clicks, typing, and scrolling behave exactly as before this change

#### Scenario: Recipe turns it on
- **WHEN** the recipe sets `browser.humanize` to `true` and `webscoop run shop` replays a `type` step with the value `shoes`
- **THEN** the input receives five separate key events with pauses between them, and the typed value is `shoes`

#### Scenario: Flag overrides recipe
- **WHEN** the recipe sets `browser.humanize` to `true` and `webscoop run shop --no-humanize` is executed
- **THEN** actions run without humanized input

#### Scenario: Curved pointer path
- **WHEN** humanized input is on and a step clicks a button
- **THEN** the page receives several `mousemove` events on a path that is not a straight line before the `mousedown` inside the button, and the button is clicked

#### Scenario: Page dwell
- **WHEN** humanized input is on and a page finishes loading
- **THEN** at least one pointer move or scroll event reaches the page before fields are extracted

### Requirement: Element queries behave the same under both drivers
Resolving a selector candidate and reading from a matched element SHALL give the same results under `playwright` and `patchright`. Element queries SHALL NOT match elements inside closed shadow roots, including the recorder panel, under either driver.

Each read SHALL cost one evaluation in the page, whatever the driver. Reads are:
- counting a candidate's matches
- reading text, html, or an attribute
- comparing two elements
- snapshotting inside an element
- measuring an element's box

A read SHALL NOT serialize the whole document. A read of an element that no longer matches SHALL fail at once with an error that names the element, without waiting for the action timeout. Clicking, filling, pressing, selecting, and scrolling SHALL keep waiting for the element to be actionable, as they do today.

#### Scenario: Closed shadow root ignored
- **WHEN** a page has 200 elements matching `.price` and one more `.price` inside a closed shadow root, and a session resolves the css candidate `.price` under either driver
- **THEN** it returns 200 elements

#### Scenario: Patchright reads stay fast on a large list
- **WHEN** a Patchright session on a page with a 200-item list resolves the items and reads two fields in each of the first 10 items
- **THEN** it finishes in under 500 ms on a machine where the same work under Playwright takes under 100 ms

#### Scenario: Chained scopes under Patchright
- **WHEN** a Patchright session resolves item containers and then resolves a role, a text, and a css candidate inside the fifth container
- **THEN** each result matches the Playwright session's result for the same page

#### Scenario: Stale element read fails fast
- **WHEN** an element is removed from the page after it was resolved and the session reads its text
- **THEN** the read fails well before the action timeout, with an error naming the element
