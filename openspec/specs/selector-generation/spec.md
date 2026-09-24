# selector-generation Specification

## Purpose

Defines how selector candidates, their stability ratings, and fingerprints are derived from a picked element and generalized across repeating items. The recorder uses it to write recipes; healing later uses the same rules to judge and repair them.

## Requirements

### Requirement: Candidate strategies generated per element
For a picked element the generator SHALL produce at most one candidate per strategy, in this order of consideration: `role` (accessible role plus accessible name, when both exist), `testid` (`data-testid`), `id`, `text` (exact trimmed text, at most 80 characters, only for elements whose text is a single text node), `css` (shortest path of tag and stable class tokens from the nearest stable ancestor), `xpath` (positional path from the nearest ancestor with an `id` or `data-testid`, else from the document root). A strategy that does not apply SHALL be omitted, not emitted empty.

#### Scenario: Element with testid and heading role
- **WHEN** the element is `<h3 data-testid="product-title">Wireless Mouse</h3>`
- **THEN** candidates include `role` `heading|Wireless Mouse`, `testid` `product-title`, `text` `Wireless Mouse`, a `css` candidate, and an `xpath` candidate, and no `id` candidate

### Requirement: Hashed class detection
Class tokens SHALL be classified as hashed when they match generated patterns: tokens containing a run of 5 or more mixed letters and digits, tokens with a `css-`, `sc-`, `jsx-`, or `emotion-` prefix, or tokens ending in a hyphen followed by 4 or more hex or base64 characters. Hashed tokens SHALL NOT appear in `css` candidates. Attributes whose value looks hashed by the same rules SHALL be flagged hashed in the inspector.

#### Scenario: CSS-in-JS class ignored
- **WHEN** the element has classes `card sc-bdfBwQ kXeqYt`
- **THEN** the `css` candidate uses `card` only

### Requirement: Stability rating
Each candidate SHALL carry a stability: `role` and `testid` are `stable`; `id` is `stable` unless the value looks hashed or numeric, then `fragile`; `css` is `medium` when built only from tags and stable classes, `fragile` when it needs `:nth-child`; `text` is `fragile`; `xpath` is `fragile`.

#### Scenario: Numeric id is fragile
- **WHEN** the element has `id="item-48213"`
- **THEN** the `id` candidate is rated `fragile`

### Requirement: Ranking
Candidates SHALL be ranked by stability (`stable`, then `medium`, then `fragile`), then by the strategy order above. When a candidate is intended to match one element per item, candidates whose match count on the current page equals the item count SHALL rank above those that do not. Uniqueness on the page SHALL break remaining ties.

#### Scenario: Testid outranks css
- **WHEN** an element has a `testid` candidate matching 24 and a `css` candidate matching 24
- **THEN** the `testid` candidate ranks first

### Requirement: Generalizing item scoped selectors
When a field is inside an item container, its candidates SHALL be expressed relative to the container, with positional segments (`:nth-child`, xpath indices) that differ between siblings removed. A generalized candidate SHALL match exactly one element in every container where the field exists.

#### Scenario: Title inside card
- **WHEN** the picked title is `article:nth-child(2) > a > h3` and the container is `article`
- **THEN** the relative `css` candidate is `a > h3` and it matches one element in each of the 24 cards

### Requirement: Sibling inference
Given a picked element, inference SHALL walk up its ancestors and, for each, compare it against its element siblings by tag and by the multiset of child tags to depth 2. The first ancestor with at least two siblings scoring above a similarity threshold SHALL be the proposed container, its siblings the item set. Inference SHALL also report the next broader and next narrower candidate levels with their match counts. The document body SHALL never be proposed.

#### Scenario: Grid of cards
- **WHEN** the picked element is a title inside one of 24 `article` cards in a `div.grid`
- **THEN** the proposed container is the `article`, the broader level is none or a wrapper with 24 matches, and the narrower level is the `a` inside each card

#### Scenario: Single hero element
- **WHEN** the picked element is the only `h1` on the page with no similar siblings at any level
- **THEN** inference reports no container

### Requirement: Fingerprint capture
For every saved selector the generator SHALL capture a fingerprint with `tag`, `role` and accessible `name` when present, `textSample` (first 80 characters of trimmed text), `attrs` (only stable attributes among `id`, `data-testid`, `name`, `type`, `href` pattern with digits replaced by `#`, `alt`, `title`, and `aria-*`), `ancestors` (nearest 6 ancestor tokens, each `role` when present else `tag`), and `bbox` from the element's bounding rectangle in CSS pixels at capture time.

#### Scenario: Fingerprint for a price
- **WHEN** the element is `<span data-testid="price" class="pc__price">$999.00</span>` inside `a` inside `article`
- **THEN** the fingerprint has tag `span`, textSample `$999.00`, attrs `{ "data-testid": "price" }`, and ancestors starting `a`, `article`

### Requirement: Pure and deterministic
Generation and inference SHALL operate on a serialized DOM plus per-element geometry and accessibility data, without a live browser, so the same input always yields the same candidates. The live match counts SHALL be computed by the caller.

#### Scenario: Same snapshot, same output
- **WHEN** generation runs twice on the same serialized snapshot and element path
- **THEN** both outputs are deep-equal
