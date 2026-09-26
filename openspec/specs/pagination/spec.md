# pagination Specification

## Purpose

Defines how a run advances from one page of results to the next for each pagination kind, when it stops, how rows from different pages are deduplicated, and what the run reports about pages.

## Requirements

### Requirement: Pagination kinds
The runner SHALL advance pages according to `pagination.kind`:
- `none`: exactly one page.
- `url`: the page number is the template variable named by `pagination.param.name`, starting at `param.start` and incremented by `param.step` for each page; the runner fills the variable itself and navigates to the resulting URL; when the URL template has no such variable, the runner SHALL set it as a query parameter instead. A user-supplied value for that variable SHALL be used as the start instead.
- `next`: after extracting a page, the runner resolves `pagination.target`, clicks it, waits for the page to settle, and extracts again.
- `more`: after extracting, the runner resolves `pagination.target`, clicks it, waits for the item count to grow or the target to disappear, and extracts only the items beyond the previous count as the next page.
- `scroll`: after extracting, the runner scrolls to the bottom of the document, waits for the item count to grow, and extracts items beyond the previous count as the next page; when the count does not grow within the wait, the run stops.

#### Scenario: url kind fills the page variable
- **WHEN** the recipe url is `/catalog?paginate=url&page={n}` with param `n` start 1 step 1 and limit 3
- **THEN** the runner navigates to pages 1, 2, and 3 in order

#### Scenario: next kind clicks through
- **WHEN** the pagination kind is `next` and the target resolves on pages 1 and 2 but not on page 3
- **THEN** three pages are extracted and the run stops after page 3

#### Scenario: more kind extracts growth only
- **WHEN** the first page shows 8 items and clicking the target adds 8 more
- **THEN** page 2 contains exactly the 8 new items with `_page` 2 and `_index` 0 to 7

#### Scenario: scroll kind stops when nothing loads
- **WHEN** scrolling to the bottom does not increase the item count within the wait
- **THEN** the run stops with the pages extracted so far

### Requirement: Limits
`pagination.limit` SHALL bound the number of pages: `1` means one page, an integer N means at most N pages, `all` means until a stop rule fires. A command line override SHALL replace the recipe limit for that run. `all` SHALL be additionally capped by a maximum page count (default 500) that the user may change; hitting the cap SHALL stop the run with a warning, not an error.

#### Scenario: Limit reached
- **WHEN** limit is 2 and the site has 3 pages
- **THEN** exactly 2 pages are extracted and the run succeeds

#### Scenario: Cap on all
- **WHEN** limit is `all`, the cap is 2, and the site has 3 pages
- **THEN** 2 pages are extracted and stderr warns that the cap was hit

### Requirement: Stop rules
The runner SHALL always stop when the limit is reached and, for `next` and `more`, when the target cannot be resolved or is disabled (`disabled` attribute, `aria-disabled="true"`, or an anchor without `href`). Additionally, each enabled rule in `pagination.stopRules` SHALL stop the run, evaluated on the primary table: `no-new-items` when a page yields zero primary table rows after dropping rows with missing required fields and after dedup; `first-item-repeats` when the first extracted row of the primary table on a page, before dropping, equals the first row of the previous page on the key field; `target-missing` is implied for `next` and `more` and SHALL be a no-op for other kinds. A page on which the primary table resolves zero item containers SHALL always stop the run. A page whose primary containers were all dropped for missing required fields SHALL NOT count as such an empty page. A page whose URL and primary first row both equal the previous page's SHALL always stop the run, as a loop guard. A recipe with no item table SHALL stop only on the limit, the cap, or a missing target.

#### Scenario: Last page repeats
- **WHEN** the site serves page 3 again for every page beyond 3 and `first-item-repeats` is enabled
- **THEN** the run stops after page 3 and reports the stop reason

#### Scenario: Loop guard without rules
- **WHEN** no stop rules are enabled, limit is `all`, and page 4 has the same URL and first row as page 3
- **THEN** the run stops after page 4 with reason `loop`

#### Scenario: Page with only dropped rows
- **WHEN** no stop rule is set and page 2 has 8 containers whose rows were all dropped for a missing required field
- **THEN** the run advances to page 3

#### Scenario: Secondary table empty does not stop
- **WHEN** `no-new-items` is set, page 2 yields 8 new `products` rows and 0 `questions` rows
- **THEN** the run continues to page 3

### Requirement: Dedup across pages
Rows of each item table SHALL be deduplicated across pages by that table's field marked `key`; when no key is set, by a hash of all of the table's field values. Tables without an `item` block SHALL NOT be deduplicated. A row whose key was already emitted for its table SHALL be dropped and counted per table. Dedup SHALL NOT drop rows within the first page.

#### Scenario: Overlapping pages
- **WHEN** page 2 repeats 2 items from page 1 and `url` is the key
- **THEN** those 2 rows are dropped and the report counts 2 duplicates

#### Scenario: Same heading on every page
- **WHEN** the table `page` has a `heading` field with the same text on pages 1 and 2
- **THEN** both `page` rows are emitted

#### Scenario: Keys are per table
- **WHEN** `products` and `questions` both have a `title` field and a `questions` title equals a `products` title
- **THEN** neither row is dropped

### Requirement: Page numbering and streaming
Rows SHALL carry `_page` as the 1-based page number in extraction order and `_index` as the 0-based position within that page after dropping rows with missing required fields and after dedup. Rows of a page SHALL be emitted as soon as that page is extracted, before the runner advances, so streaming output survives a later failure.

#### Scenario: Failure on a later page
- **WHEN** page 3 times out during a JSONL run
- **THEN** stdout already contains every row from pages 1 and 2 and the exit code is 1

#### Scenario: Index after a drop
- **WHEN** page 1 has 4 containers and container 1 is dropped for a missing required field
- **THEN** the emitted rows carry `_index` 0, 1, and 2

### Requirement: Delay between pages
The runner SHALL wait `pagination.delayMs` between finishing a page and advancing, overridable per run. The delay SHALL NOT apply before the first page.

#### Scenario: Delay applied
- **WHEN** `delayMs` is 500 and 3 pages are extracted
- **THEN** the run takes at least 1 second longer than the same run with delay 0

### Requirement: Pagination target healing
The pagination target SHALL be resolved through the healing ladder like a field, with promotion and write-back on success. A healed target SHALL be reported in the run report and counted as healed.

#### Scenario: Next link healed
- **WHEN** the stored next-link candidates fail and the fuzzy rung finds the link by fingerprint
- **THEN** the run advances and the recipe's `pagination.target` is promoted on write-back

### Requirement: Pagination reporting
The run report SHALL include `pageCount`, `duplicateCount`, `stopReason` among `limit`, `cap`, `target-missing`, `no-new-items`, `first-item-repeats`, `loop`, `no-growth`, `none`, and per page the URL and row count. A `page.advanced` event SHALL be emitted before each navigation with the page number and kind, and a `pagination.stopped` event with the reason.

#### Scenario: Report after three pages
- **WHEN** a `url` run extracts 3 pages and stops on the limit
- **THEN** the report shows `pageCount` 3, `stopReason` `limit`, and three page entries
