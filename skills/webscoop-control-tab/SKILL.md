---
name: webscoop-control-tab
description: Interactively drive browser tabs with webscoop commands. Use when no recorded recipe matches your need, or when you need to inspect live page structure, navigate, click, fill forms, extract dynamic data, download files, or coordinate multi-tab browser automation.
---

# Control interactive browser tabs

Webscoop provides interactive tab control commands (`webscoop tab` subcommands and `webscoop tabs`) to drive browser pages in a shared, persistent browser session. Use these commands to inspect page structure, interact with elements, extract data, download files, and coordinate multi-tab scraping workflows. Tabs can be addressed interchangeably by their unique `tabId` (e.g. `tab_1`) or a user-assigned `--label`.

## 1. Tab discovery

List active tabs across profiles to see what is already open:

```sh
webscoop tabs --json
```

Output is a JSON array of tab descriptors with `tabId`, `label`, `url`, `title`, and `isPopup`.

## 2. Open tabs and parallelize workflows

Open a new tab at a URL, optionally assigning a memorable label:

```sh
webscoop tab open https://example.com --label main --json
```

It returns a JSON object containing `tabId`, `label`, `url`, and `title`.

### Multi-tab concurrency

When scraping multiple categories, search terms, or pagination branches, open separate tabs in parallel using memorable labels or tab IDs:

```sh
webscoop tab open https://example.com/category-a --label cat_a --json
webscoop tab open https://example.com/category-b --label cat_b --json
```

All tabs run in the same browser profile and can be driven concurrently without interfering with one another. Address tabs by either label (`cat_a`, `cat_b`) or ID (`tab_1`, `tab_2`).

## 3. Inspect page structure

### Accessible DOM outline

Retrieve an indented, accessible hierarchical outline of elements on the page:

```sh
webscoop tab outline <tab>
```

Each element is labeled with a bracketed element ref such as `[e1]`, `[e2]`, along with its role, text, and states (`aria-expanded`, `disabled`, `placeholder`). Use these element refs (for example `e1` or `[e1]`) directly in interaction commands.

To filter the outline for efficiency:
- Filter to actionable elements only with `-i` / `--interactive`:
  ```sh
  webscoop tab outline <tab> -i
  ```
- Scope the outline to a CSS selector subtree with `-s` / `--scope`:
  ```sh
  webscoop tab outline <tab> -s "#results"
  ```
- Limit tree nesting depth with `-d` / `--depth`:
  ```sh
  webscoop tab outline <tab> -d 3
  ```
- Constrain total token budget with `--budget`:
  ```sh
  webscoop tab outline <tab> --budget 1000
  ```

### Search outline

Filter outline items matching specific text:

```sh
webscoop tab find <tab> "Submit"
```

### Element HTML inspection

View the outer HTML of an element ref or CSS selector:

```sh
webscoop tab html <tab> e1
```

## 4. Interaction primitives

Interact with elements using their element reference (e.g. `e1`), CSS selector, or XPath. If an element is covered by an overlay modal, click actions fail fast with a descriptive occlusion error.

### Click

```sh
webscoop tab click <tab> e1
```

### Fill

Fill form controls or inputs:

```sh
webscoop tab fill <tab> e2 "search keyword"
```

### Press keys

Send keystrokes (e.g. `Enter`, `Escape`, `Tab`):

```sh
webscoop tab press <tab> Enter
```

Optionally target a specific element:

```sh
webscoop tab press <tab> Enter e2
```

### Scroll

Scroll the viewport `down`, `up`, or to `bottom`:

```sh
webscoop tab scroll <tab> down
webscoop tab scroll <tab> bottom
```

## 5. Granular property extraction (`get`)

Extract element text, attribute values, or input values directly without writing custom JavaScript:

```sh
webscoop tab get text <tab> e1
webscoop tab get attr <tab> e1 href
webscoop tab get value <tab> e2
```

## 6. Command batching

Execute multiple sequential actions under a single tab lock within the daemon in one round trip:

```sh
webscoop tab batch <tab> "click #genre-toggle" "click button:has-text('Pop')"
```

## 7. Explicit semantic waits

Await page milestones explicitly for dynamic SPAs:

```sh
webscoop tab wait <tab> 500
webscoop tab wait <tab> --text "10 Results Found"
webscoop tab wait <tab> --url "*/dashboard*"
```

## 8. Network route aborting

Block heavy ads, trackers, fonts, or media to speed up page loading and scraping:

```sh
webscoop tab route <tab> "*.doubleclick.net*" --abort
webscoop tab unroute <tab> "*.doubleclick.net*"
```

## 9. Fast data extraction with JavaScript evaluation

Evaluate JavaScript in the page's main world context to extract structured tables, lists, and metadata:

```sh
webscoop tab eval <tab> "Array.from(document.querySelectorAll('table tr')).map(r => Array.from(r.children).map(c => c.textContent.trim()))" --json
```

## 10. Direct file downloads

Trigger and save a file download directly to a specified destination path with `--out`:

```sh
webscoop tab download <tab> e3 --out ./data/report.pdf
```

Or trigger a direct URL download within the tab session:

```sh
webscoop tab download <tab> --url https://example.com/export.csv --out ./data/export.csv
```

## 11. Handle login walls and CAPTCHAs

When a page presents a bot check, CAPTCHA, or authentication challenge that requires user intervention, request attention:

```sh
webscoop tab attend <tab> --reason "Please solve the CAPTCHA to continue"
```

This brings the tab window to the user's attention in their desktop environment.

## 12. Cleanup

When finished with a tab, close it to free resources:

```sh
webscoop tab close <tab>
```

Or close all active tabs across the session:

```sh
webscoop tab close --all
```

## Rules and best practices

- Address tabs by memorable labels (`--label <name>`) or `tabId`.
- Prefer `webscoop tab outline -i` or `-s <selector>` over full outline for cleaner views.
- Use `webscoop tab get` to quickly inspect element text, attributes, and input values.
- Group multi-step interactions into `webscoop tab batch` to minimize round trips.
- Use `webscoop tab wait` to synchronize on dynamic page transitions.
- Block heavy tracker traffic with `webscoop tab route <tab> "<pattern>" --abort`.
- Always close tabs with `webscoop tab close <tab>` when tasks complete.
