# recipe-format Specification

## Purpose

Defines the recipe document that describes how to scrape one site: where to go, what to extract, and how to recover when the page changes. Recipes are the source of truth that the recorder writes and the runner reads.

## Requirements

### Requirement: Recipe is a versioned JSON document
A recipe SHALL be a single JSON file with a top-level `schemaVersion` integer. The current version is 2. Loading a recipe with an unknown or missing `schemaVersion` SHALL fail with an error that names the file and the version found. Loading a version 1 recipe SHALL fail with an error that names the file and says how to rewrite it:
- move `steps` into called flows, placed in `sequence` before the extract or paginate block for first-page steps and inside the paginate block's `do` for every-page steps
- turn `type` and `select` steps into `fill`
- move `pagination` into a `paginate` block of `sequence`

A version 2 recipe that declares `steps` or `pagination` at the top level SHALL fail validation naming the key.

#### Scenario: Valid version loads
- **WHEN** a recipe file with `schemaVersion: 2` and otherwise valid content is loaded
- **THEN** loading succeeds and the recipe is available to the caller

#### Scenario: Unknown version is rejected
- **WHEN** a recipe file with `schemaVersion: 7` is loaded
- **THEN** loading fails with an error that includes the file path and the value 7

#### Scenario: Version 1 is rejected with guidance
- **WHEN** a recipe file with `schemaVersion: 1` and a `steps` list is loaded
- **THEN** loading fails with an error naming the file and explaining how steps and pagination map to flows and sequence

### Requirement: Recipe identity and URL template
A recipe SHALL have a `name` (kebab-case, unique among the user's recipes) and a `url` template. The template SHALL support variables written as `{name}`. Every variable used in the template or in a step value SHALL be declared under `vars` with:
- a `name`
- a `type` of `string` or `path`
- an optional `secret` boolean (default false)
- an optional `default`

A template variable without a declaration SHALL be a validation error. A `secret` variable SHALL NOT have a `default`, and SHALL NOT be used in the template, as defined by the variables capability.

#### Scenario: Declared variables validate
- **WHEN** the url is `https://example.com/c/{category}?page={n}` and `vars` declares `category` and `n`
- **THEN** validation succeeds

#### Scenario: Undeclared variable is rejected
- **WHEN** the url is `https://example.com/c/{category}` and `vars` declares nothing
- **THEN** validation fails and the error names `category`

#### Scenario: Secret and path variables
- **WHEN** `vars` declares `pass` with `secret: true` and `video` with `type: "path"` and default `~/clips/demo.mp4`
- **THEN** validation succeeds

### Requirement: Tables
A recipe MAY declare `tables`: a non-empty list of tables, each with a `name` (kebab-case, unique within the recipe), an optional `item` block, and a non-empty `fields` list. A table with an `item` block yields one row per matched container on each page; a table without one yields exactly one row per page. A recipe SHALL declare either `tables` or the top level `item` and `fields`, not both. The top level form SHALL be the shorthand for a single table named `items` and SHALL validate and run exactly as before. A recipe MAY declare `tables` with a single entry. Within a table, a field `scope` of `item` SHALL require the table's `item` block, and at most one field per table MAY set `key: true`.

#### Scenario: Page table and list table
- **WHEN** a recipe declares a table `page` with a `heading` field and no `item`, and a table `products` with an `item` block matching 24 cards and a `title` field
- **THEN** validation succeeds, `page` yields 1 row per page, and `products` yields 24 rows

#### Scenario: Shorthand still validates
- **WHEN** a recipe declares top level `item` and `fields` and no `tables`
- **THEN** validation succeeds and the recipe behaves as one table named `items`

#### Scenario: Both forms are rejected
- **WHEN** a recipe declares `tables` and a top level `fields`
- **THEN** validation fails and the error names both

#### Scenario: Duplicate table names are rejected
- **WHEN** two tables are both named `results`
- **THEN** validation fails and the error names `results`

#### Scenario: Item field in a table without item
- **WHEN** a table without an `item` block has a field with scope `item`
- **THEN** validation fails and the error names the table and the field

### Requirement: Item container
A table MAY declare an `item` block with `selectors` (a ranked list of selector candidates), an optional `within` list of selector candidates naming the list parent, and an optional `exclude` list of selectors. When `within` is present, containers SHALL be resolved inside the first element that the first resolving `within` candidate matches; when `within` is absent, containers SHALL be resolved against the whole document. When `item` is present, fields with scope `item` SHALL be resolved relative to each matched container, after removing any container that also matches an `exclude` selector. When `item` is absent, every field of the table SHALL have scope `page` and the table yields exactly one row per page. The shorthand recipe's top level `item` is the `item` block of its single table.

#### Scenario: Item scoped recipe
- **WHEN** `item.selectors` matches 24 elements and no `exclude` is set
- **THEN** the table yields 24 rows

#### Scenario: Excluded containers are dropped
- **WHEN** `item.selectors` matches 24 elements and `exclude` matches 2 of them
- **THEN** the table yields 22 rows

#### Scenario: Containers limited to the list parent
- **WHEN** `item.within` is `role=list`, the page has a main list of 24 `listitem` elements and a sidebar list of 4, and `item.selectors` is `role=listitem`
- **THEN** the table yields 24 rows

#### Scenario: List parent absent
- **WHEN** no `within` candidate resolves on the page
- **THEN** the item container is treated as unresolved and healing applies to `within` before the container

#### Scenario: Item field without container is rejected
- **WHEN** a field has scope `item` and its table has no `item` block
- **THEN** validation fails and the error names the field

### Requirement: Fields
Every table SHALL declare at least one field under `fields`. Each field SHALL have a `name` (unique within its table), a `type` among `text`, `number`, `url`, `image`, `date`, `html`, an optional `scope` of `item` or `page` defaulting to `item` when the table has an `item` block and to `page` otherwise, a ranked non-empty `selectors` list, an optional `attr` naming the attribute to read instead of text content, an `optional` boolean defaulting to false, a `fallback` boolean defaulting to false, and an optional `fingerprint` object. At most one field per table MAY set `key: true` to mark it as the table's dedup key.

#### Scenario: Duplicate field names are rejected
- **WHEN** two fields of one table share the name `price`
- **THEN** validation fails and the error names `price`

#### Scenario: Same field name in two tables
- **WHEN** table `page` and table `products` both have a field named `title`
- **THEN** validation succeeds

#### Scenario: Two dedup keys are rejected
- **WHEN** two fields of one table both set `key: true`
- **THEN** validation fails

#### Scenario: Scope defaults from the table
- **WHEN** a field in a table with an `item` block omits `scope`
- **THEN** the field has scope `item`

#### Scenario: Fallback defaults to false
- **WHEN** a field omits `fallback`
- **THEN** the field has `fallback` false and a saved recipe omits the key

### Requirement: Selector candidates
Each selector candidate SHALL have a `strategy` among `role`, `testid`, `id`, `text`, `css`, `class`, `xpath`, a `value` string, and a `stability` among `stable`, `medium`, `fragile`. The order of the list is the order of preference. Candidates SHALL be self-describing so that a runner can try them without any other context. A `class` candidate's value SHALL be a CSS selector.

#### Scenario: Role candidate shape
- **WHEN** a candidate is `{ "strategy": "role", "value": "heading|Wireless Mouse", "stability": "stable" }`
- **THEN** validation succeeds and the runner can resolve it as an accessible role `heading` with accessible name `Wireless Mouse`

#### Scenario: Class candidate shape
- **WHEN** a candidate is `{ "strategy": "class", "value": "span.price.kXeqYt", "stability": "fragile" }`
- **THEN** validation succeeds and the runner resolves it as a CSS selector

#### Scenario: Unknown strategy is rejected
- **WHEN** a candidate has strategy `magic`
- **THEN** validation fails and the error names `magic`

### Requirement: Reserved blocks for later capabilities
A recipe MAY contain `guards` and `healing` blocks:
- `guards`: list of entries with `kind` among `login`, `captcha`, `zero-fields`, and `enabled` boolean.
- `healing`: `fuzzyThreshold` number between 0 and 1, default 0.7; `llm` boolean, default true.

When a block is absent, defaults SHALL apply: `guards` lists all kinds enabled, and `healing` uses its defaults.

#### Scenario: Recipe without optional blocks validates
- **WHEN** a recipe declares only `schemaVersion`, `name`, `url`, `vars`, `fields`, and a `sequence` extracting `items`
- **THEN** validation succeeds and defaults are filled in

#### Scenario: Pagination block validates
- **WHEN** a recipe declares a top-level `pagination` block
- **THEN** validation fails naming `pagination`, which now lives in the sequence's paginate block

### Requirement: Fingerprint shape
A `fingerprint` object, where present, SHALL carry `tag`, optional `role`, optional `name`, `textSample` (first 80 characters of text at record time), `attrs` (a map of the stable attributes observed), `ancestors` (an ordered list of ancestor tag or role tokens, nearest first, at most 6), and `bbox` with `x`, `y`, `w`, `h` in CSS pixels at record time. Fingerprints are data for later healing; this change SHALL only validate and preserve them.

#### Scenario: Fingerprint round-trips
- **WHEN** a recipe with a fingerprint is loaded and saved again
- **THEN** the fingerprint is byte-for-byte preserved apart from key ordering

### Requirement: Validation reports all errors
Validation SHALL collect every error in the document and report them together, each with a JSON path and a message, rather than stopping at the first.

#### Scenario: Multiple errors reported
- **WHEN** a recipe has an undeclared variable and a field with an unknown type
- **THEN** validation reports two errors with distinct JSON paths

### Requirement: Browser block
A recipe MAY contain a `browser` block with these optional keys:
- `proxy`: an object with `server`, a proxy URL with scheme `http`, `https`, or `socks5` and no user info, and optionally `bypass`, a list of host patterns
- `timezone`: an IANA timezone identifier
- `locale`: a BCP 47 language tag
- `humanize`: a boolean that turns humanized input on or off for runs of this recipe
- `profile`: a profile name that the recipe's browser commands use, unless `--profile` is given. A valid profile name starts with a letter or digit, followed by letters, digits, `.`, `_`, or `-`

A proxy URL with user info SHALL fail validation with a message saying that credentials belong in the config or the environment. A non-boolean `humanize` SHALL fail validation naming `browser.humanize`. A `profile` that is not a valid profile name SHALL fail validation naming `browser.profile`. An absent block or key SHALL mean no recipe-level setting for it. The block SHALL NOT change the schema version.

#### Scenario: Browser block validates
- **WHEN** a recipe declares `browser` with `proxy.server` `http://proxy-b:8080`, `timezone` `Europe/Madrid`, `locale` `es-ES`, `humanize` `true`, and `profile` `acme`
- **THEN** validation succeeds

#### Scenario: Credentials rejected
- **WHEN** a recipe declares `browser.proxy.server` as `http://user:pass@proxy-b:8080`
- **THEN** validation fails naming `browser.proxy.server` and saying credentials are not allowed in recipes

#### Scenario: Recipe without the block
- **WHEN** a recipe has no `browser` block
- **THEN** validation succeeds and the run uses the config and flag settings

#### Scenario: Invalid humanize value
- **WHEN** a recipe declares `browser.humanize` as `"yes"`
- **THEN** validation fails naming `browser.humanize`

#### Scenario: Invalid profile name
- **WHEN** a recipe declares `browser.profile` as `../other`
- **THEN** validation fails naming `browser.profile`

### Requirement: Field hover flag
A field MAY set `hover: true`. It SHALL default to false and SHALL be left out when a recipe is saved with it false, so recipes without it keep their shape. It SHALL be valid on item and page scoped fields of any type and SHALL combine with `optional`, `fallback`, and `key`.

#### Scenario: Default
- **WHEN** a field has no `hover` key
- **THEN** it loads with `hover` false and saves without a `hover` key

#### Scenario: Round trip
- **WHEN** a recipe with a field `"hover": true` is loaded and saved
- **THEN** the saved field still has `"hover": true`

#### Scenario: Wrong type
- **WHEN** a field has `"hover": "yes"`
- **THEN** validation fails naming the field's `hover`

### Requirement: Descriptions
A recipe MAY declare a `description`, each table MAY declare a `description`, and each variable under `vars` MAY declare a `description`. Each SHALL be a string of 1 to 2000 characters. Recipe and table descriptions MAY contain line breaks; a variable description SHALL NOT contain a line break. A description SHALL be plain text meant for people and for AI models: what the recipe returns, what a table holds, what a variable means. A description SHALL NOT change how a recipe runs. The top level shorthand form (`item` and `fields`) SHALL have no table description; the recipe `description` still applies to it.

#### Scenario: Described recipe validates
- **WHEN** a recipe declares `description: "Bing web search results for a query"`, a table `results` with `description: "table of search results\none row per organic result"`, and a variable `query` with `description: "search terms"`
- **THEN** validation succeeds and the run output is the same as without the descriptions

#### Scenario: Multiline variable description rejected
- **WHEN** a variable declares a `description` containing a line break
- **THEN** validation fails and the error names the variable

#### Scenario: Empty description rejected
- **WHEN** a table declares `description: ""`
- **THEN** validation fails and the error names the table

#### Scenario: Recipes without descriptions stay valid
- **WHEN** a recipe written before this change is loaded
- **THEN** validation succeeds unchanged

### Requirement: Frame targets
A recipe MAY name an `<iframe>` whose document holds elements to resolve, with a `frame` object: `selectors` (a ranked non-empty list of selector candidates) and an optional `fingerprint`, both shaped as for any target. A frame target SHALL be resolved in the top document. A `frame` object SHALL NOT itself contain `frame`.

`frame` MAY appear on:
- a table, applying to its `item` block (selectors, `within`, `exclude`) and to every field of the table
- the top-level shorthand form, applying to its single table
- a step `target`
- the pagination `target`

A recipe without any `frame` SHALL validate and run exactly as before.

#### Scenario: Table inside an iframe
- **WHEN** a table declares `frame` with an `id` candidate `iframeApplication`, an `item` block, and two fields
- **THEN** the recipe validates and the item block and fields apply inside that iframe's document

#### Scenario: Nested frame rejected
- **WHEN** a table's `frame` object contains its own `frame`
- **THEN** validation fails with an error naming the table

### Requirement: Flows block
A recipe MAY declare `flows` as defined by the flows capability, with steps as defined by the steps capability. A step SHALL have:
- `kind` among `click`, `fill`, `press`, `wait`, `await-user`
- an optional `target` with ranked `selectors`, an optional `fingerprint`, and an optional `frame`
- an optional `value` string
- an optional `until` among `appears` and `disappears`
- an optional `timeoutMs` positive integer
- `window` among `same` and `popup`, default `same`
- `optional` boolean, default false
- an optional `label`

Validation SHALL apply the per-kind rules of the steps capability and SHALL name the flow and the step index in each error. A `fill` value MAY reference template variables, which SHALL be declared under `vars`. When `flows` is absent it SHALL default to an empty list.

#### Scenario: Valid click step
- **WHEN** a flow's step is `{ "kind": "click", "target": { "selectors": [ { "strategy": "role", "value": "button|Accept", "stability": "stable" } ] }, "optional": true }`
- **THEN** validation succeeds with `window` defaulting to `same`

#### Scenario: Fill without target is rejected
- **WHEN** a `fill` step in flow `search` has a value and no target
- **THEN** validation fails and the error names `search` and the step index

#### Scenario: Undeclared variable in a fill value
- **WHEN** a `fill` step value is `{query}` and `vars` does not declare `query`
- **THEN** validation fails and the error names `query`

### Requirement: Sequence block
A recipe SHALL declare `sequence` as defined by the flows capability. A `paginate` block's settings SHALL be:
- `kind` among `url`, `next`, `more`, `scroll`
- an optional `target` (selector candidates, fingerprint, and frame)
- an optional `param` with `name`, `start`, and `step`
- `limit` as `1`, a positive integer, or `"all"`, default 1
- `stopRules`, a list drawn from `no-new-items`, `first-item-repeats`, `target-missing`, default empty
- `delayMs`, default 0
- an optional `table` naming the driving table
- `do`

`next` and `more` SHALL require `target`. `table` SHALL name a table with an `item` block that is extracted in `do`. When `table` is absent, the first such table in `do` SHALL drive.

#### Scenario: Paginate block validates
- **WHEN** a sequence holds `paginate` with kind `url`, param `n` starting at 1 step 1, limit 3, and `do: [extract items]`
- **THEN** validation succeeds

#### Scenario: Next without target
- **WHEN** a paginate block has kind `next` and no `target`
- **THEN** validation fails naming the paginate block
