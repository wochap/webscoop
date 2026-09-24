# playground Specification

## Purpose

Defines the local fixture site used by end-to-end tests and manual QA: a fake product catalog rendered from a fixed dataset, whose markup can be mutated on demand so the scraper's resilience can be tested against known ground truth.

## Requirements

### Requirement: Dataset is the ground truth
The playground SHALL render from a single JSON dataset of 24 products, each with `id`, `title`, `price`, `url`, `image`, `rating`, and `category`. The dataset file SHALL be importable by tests so assertions compare extracted rows against it directly.

#### Scenario: Extracted rows match dataset
- **WHEN** a recipe recorded against tier 0 is run against the catalog page
- **THEN** the emitted rows equal the dataset on every recipe field, in dataset order

### Requirement: Server lifecycle
The playground SHALL start as a local HTTP server on a caller-chosen port (0 for random), expose the chosen port, and stop cleanly when asked. Tests SHALL be able to start several instances in parallel.

#### Scenario: Random port
- **WHEN** the playground is started with port 0
- **THEN** it reports the actual port and serves the catalog there

### Requirement: Catalog page
`GET /catalog` SHALL render all 24 products as repeating items, each exposing title, price, link, image, and rating, with a page-level category heading. Rendering SHALL be server-side so the page is complete on load.

#### Scenario: Catalog renders all items
- **WHEN** `/catalog` is requested
- **THEN** the response contains 24 product items in dataset order

### Requirement: Mutation tiers
The catalog SHALL accept a `tier` query parameter from 0 to 4. This change SHALL implement tier 0 (stable markup with ids, `data-testid` attributes, semantic roles, and readable class names) and reserve tiers 1 to 4 for later changes. Requesting an unimplemented tier SHALL return HTTP 501 with a body naming the tier.

#### Scenario: Tier 0 markup
- **WHEN** `/catalog?tier=0` is requested
- **THEN** each product has a `data-testid="product-card"` container, a heading with the title, and a `data-testid="price"` element

#### Scenario: Unimplemented tier
- **WHEN** `/catalog?tier=3` is requested before tier 3 exists
- **THEN** the response is HTTP 501 and the body contains `tier 3`

### Requirement: Deterministic seed
The catalog SHALL accept a `seed` query parameter. Any randomized mutation in any tier SHALL derive from the seed so the same seed produces identical markup on every request.

#### Scenario: Same seed, same markup
- **WHEN** `/catalog?tier=0&seed=7` is requested twice
- **THEN** both responses are byte-identical

### Requirement: Control endpoint
`POST /__control` with a JSON body SHALL set server-wide defaults for `tier`, `seed`, and `delayMs`. Query parameters on a request SHALL override control defaults. `GET /__control` SHALL return the current defaults. `POST /__control/reset` SHALL restore the initial defaults.

#### Scenario: Control sets default tier
- **WHEN** `POST /__control` sets `tier` to 0 and `/catalog` is requested without a `tier` parameter
- **THEN** tier 0 markup is served

### Requirement: Response delay
When `delayMs` is set by query or control, the catalog SHALL wait that many milliseconds before responding, so navigation timeouts can be tested.

#### Scenario: Delayed response
- **WHEN** `/catalog?delayMs=1500` is requested
- **THEN** the response arrives no sooner than 1.5 seconds after the request

### Requirement: Reserved routes
The routes `/login` and `/challenge` and the query parameter `wall` SHALL be reserved for the guards change. Requesting a reserved route or parameter SHALL return HTTP 501.

#### Scenario: Reserved route
- **WHEN** `/login` is requested before the guards change exists
- **THEN** the response is HTTP 501

### Requirement: Hostile page chrome
`/catalog` SHALL accept a `chrome` query parameter. With `chrome=hostile` the catalog SHALL be wrapped in adversarial page chrome: a fixed header at `z-index: 99` spanning the full viewport width, a promo bar stacked under it, a cookie consent modal with a backdrop at `z-index: 2147483000` that intercepts clicks until dismissed, a light theme with a serif font and global `!important` rules on headings, links, and buttons, and a global click handler on the document that records clicks to `window.__hostClicks`. Without the parameter, the catalog SHALL render as before.

#### Scenario: Hostile chrome present
- **WHEN** `/catalog?tier=0&chrome=hostile` is requested
- **THEN** the response contains the fixed header, the promo bar, the cookie modal, and the global click handler

#### Scenario: Default unchanged
- **WHEN** `/catalog?tier=0` is requested
- **THEN** the response contains none of the hostile chrome elements

### Requirement: Sponsored cards
`/catalog` SHALL accept a `sponsored` query parameter with a non-negative integer. The first N product cards SHALL gain the class `sponsored` and a `data-sponsored="true"` attribute while keeping their dataset content and order. The default is 0.

#### Scenario: Two sponsored cards
- **WHEN** `/catalog?tier=0&sponsored=2` is requested
- **THEN** cards for p01 and p02 carry class `sponsored` and the remaining 22 do not

### Requirement: Tier 1, cosmetic churn
`/catalog?tier=1` SHALL render the same structure as tier 0 with every class name replaced by a seeded hash-like token, every `id` and `data-testid` value replaced by a seeded token, and no other change. Roles, text, tag names, attribute names, and nesting SHALL be identical to tier 0.

#### Scenario: Tier 1 keeps roles and text
- **WHEN** `/catalog?tier=1&seed=3` is requested
- **THEN** headings, prices, and links carry the same text as tier 0 and no `data-testid` value from tier 0 is present

### Requirement: Tier 2, structural churn
`/catalog?tier=2` SHALL apply tier 1 changes and additionally: wrap each card's content in one or two extra `div` elements chosen by seed, move the price above or below the title by seed, and shuffle the order of cards by seed while keeping every card's own content intact. Roles and text SHALL be preserved.

#### Scenario: Tier 2 breaks positional selectors
- **WHEN** `/catalog?tier=2&seed=3` is requested
- **THEN** a positional xpath recorded on tier 0 for the price resolves nothing or a different element, while the price text of every product is still present

#### Scenario: Ground truth independent of order
- **WHEN** rows are extracted from tier 2
- **THEN** sorting them by `url` yields the dataset

### Requirement: Tier 3, semantic churn
`/catalog?tier=3` SHALL apply tier 2 changes and additionally, chosen by seed per page: swap each card's `article` for a `div` or `section`, render the title as a `div` with `role="heading"` or as an `h3`, render the price inside a `span` with a `Cost:` or `Now:` prefix label in a separate sibling element, rename `data-testid` attributes to `data-qa`, replace the rating `aria-label` with a `title` attribute, and change the link text from `View details` to `See product`. Product values SHALL remain extractable: the price element's own text SHALL still contain the formatted price.

#### Scenario: Tier 3 defeats fuzzy match on price
- **WHEN** the reference recipe runs on `/catalog?tier=3&seed=5` with the model rung disabled
- **THEN** at least one required field is reported `missing`

#### Scenario: Tier 3 values intact
- **WHEN** `/catalog?tier=3&seed=5` is requested
- **THEN** every product's price string and title text appear in the page

### Requirement: Tier 4, field removed
`/catalog?tier=4` SHALL apply tier 3 changes and remove the rating element from every card entirely. No other element SHALL carry the rating value.

#### Scenario: Rating absent
- **WHEN** `/catalog?tier=4&seed=5` is requested
- **THEN** no element contains a rating value and the other five fields are present

### Requirement: Paginated catalog
`/catalog` SHALL accept `paginate` among `url`, `next`, `more`, `scroll`. When set, the catalog SHALL show the 24 products in 3 pages of 8, in dataset order, and expose the page as follows:
- `url`: `?page=N` selects the page; the page shows numbered page links `1`, `2`, `3` and a `Next` link whose `href` carries `page=N+1` on pages 1 and 2. Page 3 has no `Next` link.
- `next`: the server keeps the page in the `ws_page` cookie; a `Next` link with `href="/catalog?paginate=next&go=next"` advances the cookie and redirects back; page 3 renders the link with `aria-disabled="true"` and no `href`.
- `more`: the page renders 8 products and a `Load more` button; clicking it fetches the next 8 from `/catalog/more?after=N` and appends them; after 24 the button is removed.
- `scroll`: the page renders 8 products and a script that appends the next 8 when the viewport reaches the bottom, until 24.
Without `paginate`, the catalog SHALL render all 24 products as before.

#### Scenario: url pages
- **WHEN** `/catalog?paginate=url&page=2` is requested
- **THEN** products p09 to p16 are rendered and the `Next` link points at `page=3`

#### Scenario: more appends
- **WHEN** the `Load more` button is clicked twice on `/catalog?paginate=more`
- **THEN** 24 products are present and the button is gone

### Requirement: Pagination stop-rule switches
`/catalog` SHALL accept `nextRel=0` to omit `rel="next"` from the next link (default present), `lastPageRepeats=1` to serve page 3 content for any page beyond 3 in `url` mode with a `Next` link present, and `moreDisappears=1` to remove the `Load more` button after the first click regardless of remaining items.

#### Scenario: Last page repeats
- **WHEN** `/catalog?paginate=url&page=4&lastPageRepeats=1` is requested
- **THEN** products p17 to p24 are rendered and a `Next` link to `page=5` is present

#### Scenario: More disappears
- **WHEN** `moreDisappears=1` is set and the button is clicked once
- **THEN** 16 products are present and no button remains
