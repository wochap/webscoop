# recorder Specification

## Purpose

Defines the interactive recording session in which a user opens a page, picks elements, confirms inferred items, edits fields and pagination, test runs, and saves a recipe. The recorder produces recipes; it never runs unattended.

## Requirements

### Requirement: Recording session opens the page with recorder UI
Starting a recording session SHALL open the target URL in a headed persistent browser profile, wait for the page to load, and inject the recorder UI: a picker overlay and a sidebar panel of fixed width 400 CSS pixels docked on the right. The page content SHALL be pushed left by the panel width, not covered. The UI SHALL be injected again after every navigation within the session, restoring the draft recipe state.

#### Scenario: Panel visible after load
- **WHEN** a recording session opens the playground catalog
- **THEN** the sidebar panel is visible on the right and the catalog remains fully visible to its left

#### Scenario: Navigation keeps the draft
- **WHEN** the user has two fields in the draft and follows a link within the page
- **THEN** the panel reappears on the new page with the same two fields

### Requirement: URL template and variables
The session SHALL accept a URL template with `{name}` variables. Before opening, it SHALL prompt for a value for each variable that has no default, then open the substituted URL. The panel SHALL show the template with each variable rendered as a chip, its current value, and allow editing values and reopening.

#### Scenario: Template with one variable
- **WHEN** the session starts with `http://host/catalog?cat={category}` and no default
- **THEN** the user is asked for `category` before the page opens, and the panel shows `{category}` as a chip with that value

### Requirement: Picking mode
The panel SHALL offer a picking mode. While picking, hovering an element SHALL draw a highlight box around it with a tag showing its tag name, role when present, and a short text excerpt. Clicking SHALL select the element and leave picking mode. Esc SHALL leave picking mode without selecting. Alt+click SHALL select the element under the cursor even when a host overlay or modal backdrop covers it. Host page click handlers SHALL NOT fire during picking.

#### Scenario: Hover and select
- **WHEN** picking is active and the user hovers then clicks a product title
- **THEN** the title is highlighted on hover, becomes selected on click, and the page does not navigate to the product

#### Scenario: Pick through a modal backdrop
- **WHEN** a host cookie modal covers the catalog and the user Alt+clicks a product title behind it
- **THEN** the title is selected

### Requirement: Selected element inspector
After selection the panel SHALL show: tag name, role and accessible name when present, a text excerpt, and the element's `id`, `data-testid`, `class`, and `aria-*` attributes, each attribute flagged stable or hashed. It SHALL show an ancestor breadcrumb from the document body to the element with role or tag labels. The user SHALL be able to move the selection up or down the breadcrumb with Left and Right arrow keys or by clicking a crumb; the highlight and inspector follow.

#### Scenario: Walk up to the container
- **WHEN** a product title is selected and the user presses Left twice
- **THEN** the selection moves to the grandparent and the highlight box surrounds it

### Requirement: Selector candidates shown and chosen
For the selected element the panel SHALL list every generated selector candidate with its strategy, value, stability badge, and the number of elements it matches on the current page, ranked as defined by the selector-generation capability. The top candidate SHALL be preselected. The user MAY change which candidate is primary; the saved field SHALL list the chosen candidate first and keep the others in ranked order.

#### Scenario: Candidate list for a testid element
- **WHEN** the selected element has `data-testid="product-title"` shared by 24 elements
- **THEN** the list shows a `testid` candidate with match count 24 and a `stable` badge

### Requirement: Item inference from one pick
When a selection is made and no item container is set, the recorder SHALL look for a repeating structure: the nearest ancestor that has at least two siblings with the same tag and a similar child structure. When found, the panel SHALL propose that ancestor as the item container, state the number of matches, highlight every match on the page, show the first three matched items' text as samples, and offer to confirm, pick a broader or narrower container level with its match count, or cancel. Confirming SHALL set the item container and make the original selection an item scoped field.

#### Scenario: Catalog title infers 24 items
- **WHEN** the user picks one product title on the tier 0 catalog
- **THEN** the panel proposes the product card as container with 24 matches and all 24 cards are highlighted

#### Scenario: Broader level
- **WHEN** the proposal is the inner link element with 24 matches and the user chooses the broader level
- **THEN** the container becomes the card element with 24 matches and the highlights update

#### Scenario: No repetition
- **WHEN** the user picks the page heading
- **THEN** no container is proposed and the field is offered with scope `page`

### Requirement: Exclusions
While the item container is proposed or set, the user SHALL be able to add an exclusion selector. Containers matching it SHALL be removed from the highlighted set and from the match count, and the exclusion SHALL be saved in the recipe's `item.exclude` list.

#### Scenario: Exclude sponsored cards
- **WHEN** 24 cards match and the user adds the exclusion `.sponsored` matching 2 of them
- **THEN** the count shows 22 and those 2 cards lose their highlight

### Requirement: Add as field
The user SHALL be able to turn the selection into a field with a name (defaulting to a slug of the accessible name or text, unique within the draft), a type among `text`, `number`, `url`, `image`, `date`, `html` (defaulting to `url` for links, `image` for images, `number` when the text is numeric, else `text`), an attribute to read (defaulting to `href` for links and `src` for images), scope (`item` when the element is inside the container, else `page`), optional flag, and dedup key flag. Fields SHALL be listed in the panel with name, type, scope, sample value, and match count, and SHALL be reorderable by drag or Alt+Up and Alt+Down.

#### Scenario: Link becomes url field
- **WHEN** the user adds a product link as a field
- **THEN** the field defaults to type `url`, attribute `href`, and scope `item`

#### Scenario: Duplicate name is rejected inline
- **WHEN** the user names a second field `price`
- **THEN** the panel shows an error on the name and does not save until it is unique

### Requirement: Zero match fields
A field whose primary selector matches nothing on the current page SHALL be marked with a warning in the field list and offer to re-pick or mark optional.

#### Scenario: Field breaks after navigation
- **WHEN** a field matched 24 elements on page one and matches 0 after navigating to another page
- **THEN** the field row shows the warning with the two actions

### Requirement: Pagination target
The user SHALL be able to mark a selection as the pagination target. The recorder SHALL detect the likely kind: `url` when the target is a link whose `href` differs from the current URL only by a numeric query parameter or path segment, `next` for any other link, `more` for a button. The user MAY override the kind, and MAY choose `scroll` without a target. The panel SHALL let the user choose the limit (first page only, first N pages, all pages) and toggle stop rules. The result SHALL be saved in the recipe's `pagination` block. Pagination SHALL NOT be executed by the recorder in this change.

#### Scenario: Numeric page link detected as url kind
- **WHEN** the current URL is `/catalog?page=1` and the user marks a link to `/catalog?page=2`
- **THEN** the panel proposes kind `url` with parameter `page`, start 1, step 1

### Requirement: Test run from the panel
The panel SHALL offer a test run that executes the draft recipe on the current page using the same extraction behavior as `webscoop run`, without pagination, and shows a results drawer with the first rows as a table, a JSON view, per-field status (`ok`, `partial`, `missing`), row count, and duration. The drawer SHALL NOT overlap the panel.

#### Scenario: Test run on the catalog
- **WHEN** the draft has title and price fields and the user runs a test
- **THEN** the drawer shows 24 rows, both fields `ok`, and the JSON view matches the table

### Requirement: Save
Saving SHALL validate the draft with the recipe schema, write it to the recipes directory under the chosen name, and confirm in the panel. Validation errors SHALL be shown in the panel next to the offending field. Saving SHALL NOT close the session; the user MAY keep editing and save again.

#### Scenario: Save writes the file
- **WHEN** the user saves a draft named `shop-catalog`
- **THEN** `shop-catalog.json` exists in the recipes directory and loads with the recipe schema

### Requirement: Edit an existing recipe
Starting a session with an existing recipe SHALL open its URL (prompting for variables), load its fields, container, and pagination into the panel, and show each field's match count on the current page.

#### Scenario: Reopen and see counts
- **WHEN** a session is started for a saved recipe with three fields
- **THEN** the panel lists the three fields with their current match counts

### Requirement: Isolation from the host page
The recorder UI SHALL render inside a shadow root with all inherited styles reset, use its own embedded fonts, force its own color scheme, and sit above every host element. Host page styles, fonts, `z-index`, and fixed headers SHALL NOT change the panel's appearance. The overlay highlight SHALL remain legible on dark, light, and saturated host backgrounds.

#### Scenario: Hostile host chrome
- **WHEN** the session opens the playground with hostile chrome enabled
- **THEN** the panel renders with its own font and colors, above the fixed header and the cookie modal

### Requirement: Keyboard
The panel SHALL support: `p` to start picking, Esc to cancel picking or close a menu, Enter to confirm the current proposal, Left and Right to walk the breadcrumb, Alt+Up and Alt+Down to reorder fields, Ctrl+S to save. Shortcuts SHALL NOT fire while typing in a panel input.

#### Scenario: Enter confirms items
- **WHEN** the item proposal is shown and the user presses Enter
- **THEN** the container is confirmed

### Requirement: Session end
Closing the browser window or pressing Ctrl+C SHALL end the session. If the draft has unsaved changes, the CLI SHALL print a warning naming the recipe on stderr. The process SHALL exit 0 after a save and 1 when the session ended with an error.

#### Scenario: Unsaved close
- **WHEN** the user closes the window with unsaved fields
- **THEN** stderr warns that the draft was not saved and the exit code is 0

### Requirement: Re-pick mode
The recorder SHALL support a focused re-pick mode for one field. The panel SHALL replace its body with the field's name, its old primary selector, its last known sample value, and its stored fingerprint summary, and prompt the user to click the new location. While hovering, the overlay tag SHALL show the fingerprint similarity score of the hovered element, and the panel SHALL mark scores at or above the recipe threshold as likely. Confirming SHALL replace the field's selectors with freshly generated candidates for the picked element, the picked element's selector first, and refresh the fingerprint. The mode SHALL offer skip and abort. In a run, confirming resumes the run; from `record --repick`, confirming saves the recipe.

#### Scenario: Score shown on hover
- **WHEN** re-pick is active for `price` and the user hovers the new price element
- **THEN** the overlay tag shows a score at or above the threshold and the panel marks it likely

#### Scenario: Confirm replaces selectors
- **WHEN** the user clicks the new element and confirms
- **THEN** the field's first candidate resolves that element and the fingerprint reflects it

#### Scenario: Skip in a run
- **WHEN** the user skips during an interactive run
- **THEN** the run continues and treats the field as missing
