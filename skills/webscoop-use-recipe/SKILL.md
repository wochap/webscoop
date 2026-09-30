---
name: webscoop-use-recipe
description: Scrape web data with the user's saved webscoop recipes. Use when the user asks for data from a website or for search results that one of their recipes may cover, or when they mention webscoop.
---

# Use a webscoop recipe

Webscoop replays recorded scrapers ("recipes") in the user's browser and prints the rows as JSON. Use it to get data from a site instead of fetching pages yourself.

## 1. Discover recipes

Run:

```sh
webscoop recipes --json
```

It prints a JSON array (nothing when there are no recipes). Each entry has:

- `name`: the recipe name to pass to `webscoop run`.
- `description` (optional): what the recipe scrapes.
- `url`: the start URL, possibly with `{variable}` placeholders.
- `vars`: variables, each with `name`, optional `default`, and optional `description`.
- `tables`: each with `name`, optional `description`, and `fields` (`name`, `type`).

## 2. Choose a recipe

Match the user's request against each recipe's `description`, its tables' descriptions and field names, and its variables' descriptions. The URL helps when descriptions are missing.

When no recipe fits, tell the user so. Do not guess, and do not scrape the site another way unless the user asks. Suggest that the user records a recipe with `webscoop record <url>` (the user runs it; it needs them in the browser).

## 3. Fill the variables

Pass each variable as `--var name=value`. Supply every variable that has no `default`; ask the user when the request does not give a value. Variables with a default may be omitted.

## 4. Run it

```sh
webscoop run <recipe> --var name=value --jsonl --quiet
```

Add `--table <name>` when only one table of a multi-table recipe is needed.

Stdout has one JSON row per line. Each row has the table's fields plus `_page` (page number) and `_index` (position on the page). When the recipe has several tables and `--table` is not given, each row also has `_table`, the table name.

Example: the user asks "search cats" and the catalog lists `bing-search`, described "Bing web search results for a query", with variable `query` described "search terms":

```sh
webscoop run bing-search --var query=cats --jsonl --quiet
```

## 5. Read the exit code

- `0`: success. Use the rows.
- `1`: error. Report it to the user with the stderr text.
- `2`: the browser needed the user (login or captcha) and nobody answered in time. Ask the user to handle the browser window, then retry the same command.
- `3`: the page changed and a required field was not found. Tell the user the recipe needs repair with `webscoop edit <recipe>`.

## Parallel runs and pauses

You may start several runs at once. Webscoop queues or shares them, so no extra coordination is needed. A run may pause while the user answers a prompt in the browser; wait for it to finish.

## Never

- Never edit recipe files.
- Never run `webscoop record`, `webscoop edit`, or `webscoop daemon stop` yourself. These are for the user.
