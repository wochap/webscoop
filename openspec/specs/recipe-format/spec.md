# recipe-format Specification

## Purpose

Defines the recipe document that describes how to scrape one site: where to go, what to extract, and how to recover when the page changes. Recipes are the source of truth that the recorder writes and the runner reads.

## Requirements

### Requirement: Recipe is a versioned JSON document
A recipe SHALL be a single JSON file with a top-level `schemaVersion` integer. The current version is 1. Loading a recipe with an unknown or missing `schemaVersion` SHALL fail with an error that names the file and the version found.

#### Scenario: Valid version loads
- **WHEN** a recipe file with `schemaVersion: 1` and otherwise valid content is loaded
- **THEN** loading succeeds and the recipe is available to the caller

#### Scenario: Unknown version is rejected
- **WHEN** a recipe file with `schemaVersion: 7` is loaded
- **THEN** loading fails with an error that includes the file path and the value 7

### Requirement: Recipe identity and URL template
A recipe SHALL have a `name` (kebab-case, unique among the user's recipes) and a `url` template. The template SHALL support variables written as `{name}`. Every variable used in the template SHALL be declared under `vars` with a `name`, a `type` of `string`, and an optional `default`. A template variable without a declaration SHALL be a validation error.

#### Scenario: Declared variables validate
- **WHEN** the url is `https://example.com/c/{category}?page={n}` and `vars` declares `category` and `n`
- **THEN** validation succeeds

#### Scenario: Undeclared variable is rejected
- **WHEN** the url is `https://example.com/c/{category}` and `vars` declares nothing
- **THEN** validation fails and the error names `category`

### Requirement: Item container
A recipe MAY declare an `item` block with `selectors` (a ranked list of selector candidates) and an optional `exclude` list of selectors. When `item` is present, fields with scope `item` SHALL be resolved relative to each matched container, after removing any container that also matches an `exclude` selector. When `item` is absent, every field SHALL have scope `page` and the recipe yields exactly one row.

#### Scenario: Item scoped recipe
- **WHEN** `item.selectors` matches 24 elements and no `exclude` is set
- **THEN** the recipe yields 24 rows

#### Scenario: Excluded containers are dropped
- **WHEN** `item.selectors` matches 24 elements and `exclude` matches 2 of them
- **THEN** the recipe yields 22 rows

#### Scenario: Item field without container is rejected
- **WHEN** a field has scope `item` and the recipe has no `item` block
- **THEN** validation fails and the error names the field

### Requirement: Fields
A recipe SHALL declare at least one field under `fields`. Each field SHALL have a `name` (unique within the recipe), a `type` among `text`, `number`, `url`, `image`, `date`, `html`, a `scope` of `item` or `page`, a ranked non-empty `selectors` list, an optional `attr` naming the attribute to read instead of text content, an `optional` boolean defaulting to false, and an optional `fingerprint` object. At most one field MAY set `key: true` to mark it as the dedup key.

#### Scenario: Duplicate field names are rejected
- **WHEN** two fields share the name `price`
- **THEN** validation fails and the error names `price`

#### Scenario: Two dedup keys are rejected
- **WHEN** two fields both set `key: true`
- **THEN** validation fails

### Requirement: Selector candidates
Each selector candidate SHALL have a `strategy` among `role`, `testid`, `id`, `text`, `css`, `xpath`, a `value` string, and a `stability` among `stable`, `medium`, `fragile`. The order of the list is the order of preference. Candidates SHALL be self-describing so that a runner can try them without any other context.

#### Scenario: Role candidate shape
- **WHEN** a candidate is `{ "strategy": "role", "value": "heading|Wireless Mouse", "stability": "stable" }`
- **THEN** validation succeeds and the runner can resolve it as an accessible role `heading` with accessible name `Wireless Mouse`

#### Scenario: Unknown strategy is rejected
- **WHEN** a candidate has strategy `magic`
- **THEN** validation fails and the error names `magic`

### Requirement: Reserved blocks for later capabilities
A recipe MAY contain `pagination`, `guards`, and `healing` blocks. Their shapes SHALL be fixed by the schema now so that recipes written today remain valid later:
- `pagination`: `kind` among `none`, `url`, `next`, `more`, `scroll`; optional `target` (selector candidates plus fingerprint); optional `param` with `name`, `start`, `step`; `limit` as `1`, a positive integer, or `"all"`; `stopRules` list drawn from `no-new-items`, `first-item-repeats`, `target-missing`; `delayMs`.
- `guards`: list of entries with `kind` among `login`, `captcha`, `zero-fields`, and `enabled` boolean.
- `healing`: `fuzzyThreshold` number between 0 and 1, default 0.7; `llm` boolean, default true.

When a block is absent, defaults SHALL apply: `pagination.kind` is `none`, `guards` lists all kinds enabled, `healing` uses its defaults. A runner that does not yet implement a block SHALL ignore it without error.

#### Scenario: Recipe without optional blocks validates
- **WHEN** a recipe declares only `schemaVersion`, `name`, `url`, `vars`, and `fields`
- **THEN** validation succeeds and defaults are filled in

#### Scenario: Pagination block validates
- **WHEN** a recipe declares `pagination` with kind `url`, param `n` starting at 1 step 1, and limit 3
- **THEN** validation succeeds

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
