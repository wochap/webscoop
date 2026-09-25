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

### Requirement: Login wall
With `wall=login`, `GET /catalog` SHALL redirect with 302 to `/login?next=<original path and query>` unless the request carries a valid `ws_sess` cookie. `GET /login` SHALL render a form with `username`, `password`, and a submit button. `POST /login` SHALL set `ws_sess` and redirect to `next`, or to `/` when `next` is absent. Any credentials SHALL be accepted. `GET /logout` SHALL clear the cookie.

#### Scenario: Wall redirects
- **WHEN** `/catalog?wall=login` is requested without the cookie
- **THEN** the response is 302 to `/login?next=%2Fcatalog%3Fwall%3Dlogin`

#### Scenario: Login returns to the catalog
- **WHEN** the form on `/login?next=%2Fcatalog%3Fwall%3Dlogin` is submitted
- **THEN** the response sets `ws_sess` and redirects to `/catalog?wall=login`, which then renders the catalog

### Requirement: Captcha wall
With `wall=captcha`, `GET /catalog` SHALL respond with 403 and the challenge page unless the request carries a `ws_human` cookie. The challenge page SHALL contain an iframe whose `src` contains `turnstile`, an element with id `challenge-form`, the visible text `Verify you are human`, and a button `I am human` that, when clicked, sets `ws_human` via `POST /challenge` and reloads the original URL. `/challenge` SHALL also be reachable directly for inspection.

#### Scenario: Challenge served
- **WHEN** `/catalog?wall=captcha` is requested without the cookie
- **THEN** the response is 403 and contains the turnstile iframe and the button

#### Scenario: Button clears the wall
- **WHEN** the button is clicked
- **THEN** `ws_human` is set and the next request to `/catalog?wall=captcha` renders the catalog

### Requirement: Wall after a page
`wallAfterPage=N` SHALL restrict the wall to requests whose `page` parameter is greater than N; pages up to N SHALL render normally. It SHALL apply to both wall kinds and to the `next` pagination cookie page.

#### Scenario: Wall on page 3 only
- **WHEN** `wall=captcha&wallAfterPage=2&paginate=url` is set
- **THEN** pages 1 and 2 render the catalog and page 3 returns the challenge

### Requirement: Short interstitial
`wall=interstitial` SHALL serve `/catalog` with HTTP 503 and a page whose visible text is under 200 characters and contains no product, until the `ws_human` cookie is present.

#### Scenario: Interstitial served
- **WHEN** `/catalog?wall=interstitial` is requested without the cookie
- **THEN** the response is 503 with fewer than 200 visible characters

### Requirement: Cookie gate
With `gate=cookie`, `/catalog` SHALL render a consent modal with a backdrop that intercepts clicks and an `Accept all` button, and SHALL keep the product list out of the DOM until the button is clicked. Clicking SHALL set `ws_consent` in `localStorage`, remove the modal, and insert the list; on later loads with consent stored the modal SHALL NOT appear.

#### Scenario: Gate blocks extraction
- **WHEN** the reference recipe runs on `/catalog?gate=cookie` without steps
- **THEN** no product resolves and the run exits 3

#### Scenario: Accept reveals products
- **WHEN** `Accept all` is clicked
- **THEN** 24 products are visible and the modal is gone

### Requirement: Search gate
With `gate=search`, `/catalog` SHALL render a search form with an input named `q` and no products until a query is submitted; `/catalog?gate=search&q=<text>` SHALL render the products whose title contains the text, case-insensitive, and keep the form filled. Submitting with Enter SHALL navigate with the query.

#### Scenario: Query filters
- **WHEN** `q=mouse` is submitted
- **THEN** only products whose title contains `mouse` are rendered, in dataset order

### Requirement: Tabs gate
With `gate=tabs`, `/catalog` SHALL render two tabs, `About` (active by default, with text only) and `Products`, implemented with `role="tab"` buttons and `role="tabpanel"` panels; the product list SHALL be absent from the DOM until that tab is activated with a click, which inserts it into the Products panel. Activation SHALL be client-side and SHALL NOT persist across loads, so every page load needs the click.

#### Scenario: Products tab needed on every page
- **WHEN** `gate=tabs&paginate=url&page=2` is loaded
- **THEN** no product element exists until the Products tab is clicked
### Requirement: Mixed result blocks
`/catalog` SHALL accept `mixed=1`. When set, the product list SHALL keep every product card in dataset order and additionally: insert a `questions` block after every fourth card, rendered with the card tag and a `mixed-questions` class but children that are a heading and three `button` elements and no product content; render a thumbnail `img` with class `product-thumb` only on cards whose dataset index is odd; and mark the first card as an ad with class `mixed-ad`, keeping its product content. The parameter SHALL combine with `paginate`, in which case blocks are inserted per page after every fourth card of that page.

#### Scenario: Blocks interleaved
- **WHEN** `/catalog?mixed=1` is requested
- **THEN** 24 product cards and 6 `mixed-questions` blocks share the list, and cards for p02, p04, ... carry a `product-thumb` image while p01, p03, ... do not

#### Scenario: Mixed with url pagination
- **WHEN** `/catalog?paginate=url&page=1&mixed=1` is requested
- **THEN** 8 product cards and 2 `mixed-questions` blocks are rendered

### Requirement: Row-grouped catalog
`/catalog` SHALL accept `rows=N` with N from 1 to 24. When set, product cards SHALL be grouped N per `div.product-row` wrapper inside the product list, in dataset order, each card still wrapped in its `product-item` element. The parameter SHALL combine with `paginate` and `mixed`.

#### Scenario: Six rows of four
- **WHEN** `/catalog?rows=4` is requested
- **THEN** the list holds 6 `product-row` elements each holding 4 product cards, 24 in total
