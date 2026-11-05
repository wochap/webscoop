---
name: webscoop-control-tab
description: Interactively drive browser tabs with webscoop commands. Use when no recorded recipe matches your need, or when you need to inspect live page structure, navigate, click, fill forms, extract dynamic data, download files, or coordinate multi-tab browser automation.
---

# Control interactive browser tabs

Webscoop provides interactive tab control commands (`webscoop tab` subcommands and `webscoop tabs`) to drive browser pages in a shared, persistent browser session. Use these commands to inspect page structure, interact with elements, extract data, download files, and coordinate multi-tab scraping workflows.

## 1. Tab discovery

List active tabs across profiles to see what is already open:

```sh
webscoop tabs --json
```

Output is a JSON array of tab descriptors with `tabId`, `url`, `title`, and `isPopup`.

## 2. Open tabs and parallelize workflows

Open a new tab at a URL:

```sh
webscoop tab open https://example.com --json
```

It returns a JSON object containing `tabId`, `url`, and `title`.

### Multi-tab concurrency

When scraping multiple categories, search terms, or pagination branches, open separate tabs in parallel using their respective tab IDs:

```sh
webscoop tab open https://example.com/category-a --json
webscoop tab open https://example.com/category-b --json
```

All tabs run in the same browser profile and can be driven concurrently without interfering with one another. Keep track of each `tabId` to route actions to the appropriate tab.

## 3. Inspect page structure

### Accessible DOM outline

Retrieve a compact, accessible view of interactive elements on the page:

```sh
webscoop tab outline <tabId>
```

Each interactive element is labeled with a bracketed element ref such as `[e1]`, `[e2]`, along with its role and text. Use these element refs (for example `e1` or `[e1]`) directly in interaction commands.

To constrain the token size of large page outlines, use `--budget`:

```sh
webscoop tab outline <tabId> --budget 1000
```

### Search outline

Filter outline items matching specific text:

```sh
webscoop tab find <tabId> "Submit"
```

### Element HTML inspection

View the outer HTML of an element ref or CSS selector:

```sh
webscoop tab html <tabId> e1
```

## 4. Interaction primitives

Interact with elements using their element reference (e.g. `e1`), CSS selector, or XPath.

### Click

```sh
webscoop tab click <tabId> e1
```

### Fill

Fill form controls or inputs:

```sh
webscoop tab fill <tabId> e2 "search keyword"
```

### Press keys

Send keystrokes (e.g. `Enter`, `Escape`, `Tab`):

```sh
webscoop tab press <tabId> Enter
```

Optionally target a specific element:

```sh
webscoop tab press <tabId> Enter e2
```

### Scroll

Scroll the viewport `down`, `up`, or to `bottom`:

```sh
webscoop tab scroll <tabId> down
webscoop tab scroll <tabId> bottom
```

## 5. Fast data extraction with JavaScript evaluation

Evaluate JavaScript in the page's main world context to extract structured tables, lists, and metadata:

```sh
webscoop tab eval <tabId> "Array.from(document.querySelectorAll('table tr')).map(r => Array.from(r.children).map(c => c.textContent.trim()))" --json
```

This is the fastest method to extract table rows, metadata, or JSON from the DOM without walking elements sequentially.

## 6. Direct file downloads

Trigger and save a file download directly to a specified destination path with `--out`:

```sh
webscoop tab download <tabId> e3 --out ./data/report.pdf
```

Or trigger a direct URL download within the tab session:

```sh
webscoop tab download <tabId> --url https://example.com/export.csv --out ./data/export.csv
```

## 7. Handle login walls and CAPTCHAs

When a page presents a bot check, CAPTCHA, or authentication challenge that requires user intervention, request attention:

```sh
webscoop tab attend <tabId> --reason "Please solve the CAPTCHA to continue"
```

This brings the tab window to the user's attention in their desktop environment.

## 8. Cleanup

When finished with a tab, close it to free resources:

```sh
webscoop tab close <tabId>
```

Or close all active tabs across the session:

```sh
webscoop tab close --all
```

## Rules and best practices

- Prefer `webscoop tab outline` over dumping full HTML for element discovery.
- Use element refs (`e1`, `e2`) from the outline for fast, reliable interaction.
- Extract tabular or repetitive data using `webscoop tab eval` instead of clicking through items one-by-one whenever possible.
- Always close tabs with `webscoop tab close <tabId>` when tasks complete.
