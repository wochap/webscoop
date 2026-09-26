# selector-generation Specification

## Purpose

Defines how selector candidates, their stability ratings, and fingerprints are derived from a picked element and generalized across repeating items. The recorder uses it to write recipes; healing later uses the same rules to judge and repair them.

## Requirements

### Requirement: Candidate strategies generated per element
For a picked element the generator SHALL produce at most one candidate per strategy, in this order of consideration: `role` (accessible role plus accessible name when both exist; for elements generated as a container or list level, the role alone when the element has an explicit or implicit ARIA role other than `generic`, `presentation`, or `none`), `testid` (`data-testid`), `id`, `text` (exact trimmed text, at most 80 characters, only for elements whose text is a single text node), `css` (shortest path of tag and stable class tokens from the nearest stable ancestor), `class` (the element's tag plus every one of its own class tokens, hashed ones included, joined to the nearest anchored ancestor with a descendant combinator), `xpath` (positional path from the nearest ancestor with an `id` or `data-testid`, else from the document root). A strategy that does not apply SHALL be omitted, not emitted empty. The `class` strategy SHALL be emitted only when the element has at least one class token and its value differs from the `css` candidate.

On request the generator SHALL additionally produce one strict positional `css` candidate: the element's path of tag and stable class compounds from the same anchor as the `css` candidate, with `:nth-of-type(k)` appended to every segment whose element has a sibling of the same tag, rated `fragile`. It SHALL be emitted only when its value differs from the `css` candidate.

#### Scenario: Element with testid and heading role
- **WHEN** the element is `<h3 data-testid="product-title">Wireless Mouse</h3>`
- **THEN** candidates include `role` `heading|Wireless Mouse`, `testid` `product-title`, `text` `Wireless Mouse`, a `css` candidate, and an `xpath` candidate, and no `id` candidate

#### Scenario: Role-only candidate for a container level
- **WHEN** the container level element is `<li class="product-item">` with no accessible name
- **THEN** its candidates include `role` `listitem` rated `stable`

#### Scenario: Class candidate keeps hashed tokens
- **WHEN** the element is `<div class="price kXeqYt">` inside `<div class="asEBEc">` and the picked element has no stable class
- **THEN** the `css` candidate is `div.asEBEc > div.price` when `price` is stable, and a `class` candidate `div.price.kXeqYt` exists rated `fragile`

#### Scenario: Strict positional candidate for the second twin
- **WHEN** the element is the `span` inside the second of two sibling `<p class="product-note">` elements in a card, and the strict candidate is requested
- **THEN** a second `css` candidate exists whose last two segments are `p.product-note:nth-of-type(4) > span`, rated `fragile`

### Requirement: Hashed class detection
Class tokens SHALL be classified as hashed when they match generated patterns: tokens containing a run of 5 or more mixed letters and digits, tokens with a `css-`, `sc-`, `jsx-`, or `emotion-` prefix, tokens ending in a hyphen followed by 4 or more hex or base64 characters, or tokens of 5 to 8 characters made only of letters with at least two upper-case letters after the first character and no hyphen or underscore. Hashed tokens SHALL NOT appear in `css` candidates but SHALL appear in `class` candidates. Attributes whose value looks hashed by the same rules SHALL be flagged hashed in the inspector.

#### Scenario: CSS-in-JS class ignored
- **WHEN** the element has classes `card sc-bdfBwQ kXeqYt`
- **THEN** the `css` candidate uses `card` only

#### Scenario: Short obfuscated token detected
- **WHEN** the element has classes `asEBEc navBar`
- **THEN** `asEBEc` is hashed and `navBar` is stable

### Requirement: Stability rating
Each candidate SHALL carry a stability: `role` and `testid` are `stable`; `id` is `stable` unless the value looks hashed or numeric, then `fragile`; `css` is `medium` when built only from tags and stable classes, `fragile` when it needs `:nth-child`; `class` is `medium` when every class token is stable, `fragile` when any is hashed; `text` is `fragile`; `xpath` is `fragile`.

#### Scenario: Numeric id is fragile
- **WHEN** the element has `id="item-48213"`
- **THEN** the `id` candidate is rated `fragile`

#### Scenario: Class candidate with a hashed token
- **WHEN** the element has classes `price kXeqYt`
- **THEN** the `class` candidate is rated `fragile`

### Requirement: Ranking
Candidates SHALL be ranked by stability (`stable`, then `medium`, then `fragile`), then by the strategy order above. When a candidate is intended to match one element per item, candidates whose match count on the current page equals the item count SHALL rank above those that do not. Candidates verified as a miss SHALL rank below every candidate verified as a hit or not verified, and above candidates that match nothing. Uniqueness on the page SHALL break remaining ties.

#### Scenario: Testid outranks css
- **WHEN** an element has a `testid` candidate matching 24 and a `css` candidate matching 24
- **THEN** the `testid` candidate ranks first

#### Scenario: Class candidate outranks positional css
- **WHEN** a field has a `css` candidate `div > div:nth-child(2)` matching 24 and a `class` candidate `div.price.kXeqYt` matching 24, both `fragile`
- **THEN** the `css` candidate ranks first by strategy order, and the `class` candidate ranks above any candidate whose count differs from 24

#### Scenario: Miss ranks below a fragile hit
- **WHEN** a `class` candidate rated `medium` matching 48 is a miss and a strict positional `css` candidate rated `fragile` matching 24 is a hit
- **THEN** the `css` candidate ranks first and the `class` candidate ranks above candidates matching nothing

### Requirement: Verification against the picked element
When the recorder has an element chosen by hand, each of its candidates SHALL be verified: the candidate is resolved the way a run resolves it, inside the item container that holds the picked element for item scoped candidates and on the document for page scoped ones, and its first match is compared with the picked element by identity. A candidate whose first match is the picked element is a hit; one whose first match is another element, or that matches nothing there, is a miss. A candidate that was not verified is unknown. The result SHALL be exposed with the candidate to the ranking and the panel and SHALL NOT be written to the recipe. When no hit exists among candidates without positional segments, the strict positional candidate SHALL be generated, expressed relative to the container like the others, and verified too.

#### Scenario: Second twin picked
- **WHEN** the user picks the `span` in the second `p.product-note` of a card with 24 containers
- **THEN** no candidate without positional segments is a hit, the strict positional candidate ending in `p.product-note:nth-of-type(4) > span` (the fourth `p` of the card) is a hit, and it ranks first

#### Scenario: Second twin paragraph picked
- **WHEN** the user picks the second `p.product-note` of a card with 24 containers
- **THEN** the `class` candidate `p.product-note` matching 48 is a miss, and the strict positional candidate `p.product-note:nth-of-type(4)` is a hit and ranks first

#### Scenario: Unique element stays as today
- **WHEN** the user picks a product title whose `testid` candidate matches once per container
- **THEN** the `testid` candidate is a hit and the ranking equals the ranking without verification

#### Scenario: Page scoped candidate
- **WHEN** the user picks the second of two `h2` headings outside the list and a `css` candidate `h2` matches 2
- **THEN** that candidate is a miss and a candidate whose first match is the picked heading is a hit

### Requirement: Generalizing item scoped selectors
When a field is inside an item container, its candidates SHALL be expressed relative to the container element, with positional segments (`:nth-child`, xpath indices) that differ between siblings removed. The cut point SHALL be the container element itself, identified by its position in the snapshot, not by matching the container's selector text against the candidate. A generalized candidate SHALL match exactly one element in every container where the field exists.

In the same way, when an item container level has a list parent, the item container's candidates SHALL be expressed relative to the list parent element, cut at the list parent itself. Segments above the list parent (anchored ancestors, `id` anchors, the document root) SHALL NOT appear in them. A `css` candidate whose first kept segment is a direct child of the list parent SHALL start with `:scope > `, so it keeps the item's depth below the list parent. An `xpath` candidate SHALL become a relative path starting with `./`. Strategies with no relative form SHALL be kept only when they still match inside the list parent. Without a list parent, item container candidates SHALL stay relative to the document.

#### Scenario: Title inside card
- **WHEN** the picked title is `article:nth-child(2) > a > h3` and the container is `article`
- **THEN** the relative `css` candidate is `a > h3` and it matches one element in each of the 24 cards

#### Scenario: Bare div container
- **WHEN** the container is a `div` with only hashed classes and the picked price is `div.asEBEc > div > div:nth-child(2) > span.price`
- **THEN** the relative `css` candidate is `div > div:nth-child(2) > span.price` and the relative `class` candidate is `span.price`

#### Scenario: Item container below an id anchored list parent
- **WHEN** the list parent is `div#rso` inside `div.main > div`, and each item is a `div` two levels below it
- **THEN** the item container's `css` candidate starts below `div#rso` and is anchored at it with `:scope` (for example `:scope > div > div`), so it matches only elements at the item's depth; its `xpath` candidate starts with `./`, and neither contains `div.main` or `@id='rso'`

#### Scenario: No list parent
- **WHEN** the item container level has no list parent
- **THEN** its candidates are the document relative candidates generated for the element

### Requirement: Sibling inference
Given a picked element, inference SHALL find the repeating structure it belongs to. For each ancestor L of the picked element (candidate list parent, never `body`) and each ancestor-or-self I of the picked element below L (candidate item), the item set SHALL be every descendant of L reachable by the same tag path as I, ignoring sibling positions, whose tag equals I's tag and whose child-tag multiset to depth 2 is similar to the group. Similarity SHALL be judged against the group's centroid after one pass, so an unusual picked item still recovers its group. Inference SHALL propose the pair (L, I) with the most items where the item count is at least 3, preferring the nearest I on ties, and SHALL report the list parent, the item set, the siblings under L on I's level that were skipped as dissimilar, and the next broader and next narrower item levels with their match counts. The document body SHALL never be proposed as list parent or item. Single-child block wrappers below the item SHALL be descended into as today.

#### Scenario: Grid of cards
- **WHEN** the picked element is a title inside one of 24 `article` cards in a `div.grid`
- **THEN** the proposed list parent is `div.grid`, the container is the `article`, the broader level is none or a wrapper with 24 matches, and the narrower level is the `a` inside each card

#### Scenario: Cards grouped in rows
- **WHEN** 24 cards sit 4 per row under 6 `div.row` elements inside `div.grid` and the picked element is one title
- **THEN** the proposed list parent is `div.grid`, the item set holds all 24 cards, and the broader level is `div.row` with 6 matches

#### Scenario: Dissimilar sibling skipped and reported
- **WHEN** a result list has 8 result blocks and one "questions" block with a different child structure under the same parent
- **THEN** the item set holds the 8 results and one skipped sibling is reported

#### Scenario: Odd item picked
- **WHEN** the picked title is inside the one result that carries a thumbnail and 7 results do not
- **THEN** the item set holds all 8 results

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
