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
The routes `/login`, `/challenge`, and the query parameters `wall`, `paginate`, `nextRel`, `lastPageRepeats`, and `moreDisappears` SHALL be reserved for later changes. Requesting a reserved route SHALL return HTTP 501.

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
