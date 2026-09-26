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
When a selection is made and no item container is set, the recorder SHALL look for a repeating structure as defined by the selector-generation capability. When found, the panel SHALL show a proposal block with two prefilled fields: the list parent and the item container, each with its top selector candidate. It SHALL state the number of matches and the number of siblings skipped as dissimilar, highlight every match on the page, outline the list parent, show the first three matched items' text as samples, and offer to confirm, pick a broader or narrower container level with its match count, or cancel. Confirming SHALL set the item container with `within` from the list parent field and make the original selection an item scoped field.

The item container candidates of every level (proposed, broader, narrower) SHALL be relative to the list parent when one is set, and their match counts SHALL be counted inside the list parent. The stated number of matches SHALL agree with the item set the samples come from.

#### Scenario: Catalog title infers 24 items
- **WHEN** the user picks one product title on the tier 0 catalog
- **THEN** the panel proposes the product list as list parent and the product card as container with 24 matches and all 24 cards are highlighted

#### Scenario: Broader level
- **WHEN** the proposal is the inner link element with 24 matches and the user chooses the broader level
- **THEN** the container becomes the card element with 24 matches and the highlights update

#### Scenario: No repetition
- **WHEN** the user picks the page heading
- **THEN** no container is proposed and the field is offered with scope `page`

#### Scenario: Skipped siblings shown
- **WHEN** the picked title sits in a result list with 8 results and one dissimilar block
- **THEN** the proposal shows 8 matches and 1 skipped

#### Scenario: Search results under an id anchored list parent
- **WHEN** the user picks a result title on a page where the results sit under `div#rso` inside anchored wrappers, with hashed classes on each result
- **THEN** the proposal's list parent is `id` `rso`, the item container's top candidate matches every result inside it, and the count is greater than 0 and equal to the number of samples' item set

### Requirement: Exclusions
While the item container is proposed or set, the user SHALL be able to add an exclusion selector. Containers matching it SHALL be removed from the highlighted set and from the match count, and the exclusion SHALL be saved in the recipe's `item.exclude` list.

#### Scenario: Exclude sponsored cards
- **WHEN** 24 cards match and the user adds the exclusion `.sponsored` matching 2 of them
- **THEN** the count shows 22 and those 2 cards lose their highlight

### Requirement: Add as field
The user SHALL be able to turn the selection into a field with a name (defaulting to a slug of the accessible name or text, unique within the draft), a type among `text`, `number`, `url`, `image`, `date`, `html` (defaulting to `url` for links, `image` for images, `number` when the text is numeric, else `text`), an attribute to read (defaulting to `href` for links and `src` for images), scope (`item` when the element is inside the container, else `page`), optional flag, and dedup key flag. The selection panel SHALL show these options as a form prefilled with the defaults before the field is added, and adding SHALL use the form's values. After a field is added, the panel SHALL return to the empty state described in "Clear the selection". Fields SHALL be listed in the panel with name, type, scope, sample value, and match count, and SHALL be reorderable by drag or Alt+Up and Alt+Down.

#### Scenario: Link becomes url field
- **WHEN** the user adds a product link as a field
- **THEN** the field defaults to type `url`, attribute `href`, and scope `item`

#### Scenario: Duplicate name is rejected inline
- **WHEN** the user names a second field `price`
- **THEN** the panel shows an error on the name and does not save until it is unique

#### Scenario: Options chosen before adding
- **WHEN** the user selects a price, sets the name to `amount`, the type to `number`, and turns on optional, then adds the field
- **THEN** the field list shows `amount` as a `number` field marked optional

#### Scenario: Adding returns to the empty state
- **WHEN** the user adds the selection as a field
- **THEN** the inspector, the candidate list, and the selected element highlight are gone, and the pick strip offers a new pick

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
The panel SHALL support: `p` to start picking, Esc to cancel picking, close a menu, cancel a field edit, or clear the selection when not picking, Enter to confirm the current proposal, Left and Right to walk the breadcrumb, Alt+Up and Alt+Down to reorder fields, Ctrl+S to save. Esc SHALL act on the first of these that applies, in this order: close a menu, cancel picking, leave browse mode, abort a re-pick, cancel a field edit, clear the selection. Shortcuts SHALL NOT fire while typing in a panel input.

#### Scenario: Enter confirms items
- **WHEN** the item proposal is shown and the user presses Enter
- **THEN** the container is confirmed

#### Scenario: Esc clears the selection
- **WHEN** an element is selected, picking is off, and the user presses Esc
- **THEN** the panel returns to the empty state

#### Scenario: Esc while picking keeps the selection
- **WHEN** an element is selected, the user starts picking, and presses Esc
- **THEN** picking stops and the previous selection is still shown

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

### Requirement: Guard banner
During an interactive run, when a guard is raised the recorder bundle SHALL render a banner across the top of the page, above host content and outside the sidebar, showing the guard kind, a one-line reason, a countdown to the guard timeout, and Continue and Abort buttons. The countdown SHALL switch to the warning tone with under 90 seconds remaining. The banner SHALL be removed when the guard clears or the run ends.

#### Scenario: Banner shows and clears
- **WHEN** a login guard is raised in an interactive run and the user logs in
- **THEN** the banner appears with the countdown and disappears once the guard clears

### Requirement: Browse mode records steps
The panel SHALL offer a browse mode, toggled with `b`, in which host page interaction works normally and the recorder captures actions as steps: a click on an element becomes a `click` step targeting that element; typing into an input or textarea becomes one `type` step with the final value, replacing a previous `type` step for the same target in the same browse session; changing a `select` becomes a `select` step; pressing Enter in an input becomes a `press` step. Clicks and keys inside the panel SHALL NOT be recorded. Leaving browse mode with `b` or Esc SHALL stop capturing. Steps recorded while browsing SHALL survive navigations caused by them.

#### Scenario: Accept cookie banner
- **WHEN** browse mode is on and the user clicks the consent button
- **THEN** a `click` step targeting that button appears in the steps list and the banner closes as it would without the recorder

#### Scenario: Search then Enter
- **WHEN** the user types `mouse` in the search box and presses Enter
- **THEN** the steps list shows a `type` step with value `mouse` and a `press` step with `Enter`, and the panel is still present on the results page

### Requirement: Record a pick as a step
From a selected element, the panel SHALL offer "record as step", creating a `click` step for the element, or a `type` step with an empty value when the element is an input, without performing the action.

#### Scenario: Pick a tab as a step
- **WHEN** the user picks the Products tab and chooses record as step
- **THEN** a `click` step is added and the tab is not activated

### Requirement: Steps list editing
The panel SHALL list steps in order with kind, target summary, value, `when`, and `optional`. The user SHALL be able to edit the value (including inserting a `{var}` chip), toggle `when` and `optional`, reorder with drag or Alt+Up and Alt+Down, delete, and replay a single step on the live page. A step whose target no longer resolves on the current page SHALL show the zero-match warning with re-pick.

#### Scenario: Mark the consent click optional
- **WHEN** the user toggles `optional` on the consent step and saves
- **THEN** the recipe's step has `optional: true`

#### Scenario: Replay one step
- **WHEN** the user replays the search `type` step
- **THEN** the search box on the live page contains the step's value

### Requirement: Editing the proposal fields
While the proposal is shown, the user SHALL be able to change the list parent or the item container by picking on the page or by editing the selector text. Picking for the list parent SHALL only accept ancestors of the current item container; picking for the item container SHALL only accept descendants of the current list parent that contain the original selection. After either edit the recorder SHALL recompute the item set inside the list parent, recount, refresh the highlights and samples, and offer candidates for the edited level ranked as defined by the selector-generation capability. Item container candidates offered after an edit SHALL be relative to the list parent in effect. Typed item container selector text SHALL be resolved inside the list parent. A typed selector that resolves nothing SHALL show an inline error and leave the previous value in effect.

#### Scenario: Pick a wider list parent
- **WHEN** the proposal names `div.row` as list parent with 4 items and the user picks `div.grid` for the list parent
- **THEN** the item count becomes 24, all 24 cards are highlighted, and the item container candidates no longer mention `div.row`

#### Scenario: Type a role selector for the item
- **WHEN** the user replaces the item selector with `role=listitem`
- **THEN** the count reflects `listitem` elements inside the list parent and the highlights update

#### Scenario: Picking outside the allowed range
- **WHEN** the user is picking a list parent and clicks an element that is not an ancestor of the item
- **THEN** the click is ignored and the overlay tag says the element is outside the list

#### Scenario: Clearing the list parent
- **WHEN** the user clears the list parent field
- **THEN** the item container candidates become document relative and are counted on the whole page

### Requirement: Include all siblings
The proposal block SHALL offer an "include all siblings" toggle. When on, every element under the list parent on the item's level with the item's tag SHALL count as an item regardless of similarity, and the skipped count SHALL read 0. Toggling off SHALL restore the similarity filter. The toggle SHALL not be saved in the recipe; its effect is the item selector chosen on confirm.

#### Scenario: Include dissimilar block
- **WHEN** the proposal shows 8 matches and 1 skipped and the user turns the toggle on
- **THEN** the proposal shows 9 matches and 0 skipped

### Requirement: Saved list parent
Confirming a proposal SHALL save the list parent's ranked candidates as `item.within` when a list parent is set, and omit `within` when the user cleared the list parent field. The saved `item.selectors` SHALL be relative to the list parent when `within` is saved, and document relative otherwise. Setting an item container manually from a selection SHALL leave `within` absent unless the user then sets a list parent from the item block. The item block in the panel SHALL show the list parent with its match count and allow re-picking or clearing it after confirmation. Setting, re-picking, or typing a list parent for a confirmed item container SHALL rewrite `item.selectors` relative to the new list parent, keeping the chosen primary candidate first when it has a relative form; clearing the list parent SHALL rewrite them document relative. The item count SHALL be recounted after each rewrite.

#### Scenario: Within saved on confirm
- **WHEN** the user confirms a proposal whose list parent is the product list
- **THEN** the draft's `item.within` lists the list's candidates, `item.selectors` resolve the cards inside that list, and the saved recipe carries both

#### Scenario: Cleared list parent
- **WHEN** the user clears the list parent field and confirms
- **THEN** the saved recipe's `item` has no `within`

#### Scenario: List parent set after confirming
- **WHEN** the user sets the item container from a selection with a document relative selector and then picks the product list as list parent
- **THEN** `item.selectors` are rewritten relative to the product list and the item count stays 24

#### Scenario: Highlights follow the list parent
- **WHEN** a confirmed item has `within` and relative `item.selectors` that would also match elements outside the list parent
- **THEN** only the containers inside the list parent are highlighted, and a pick inside one of them is item scoped

#### Scenario: Recorded recipe runs
- **WHEN** a recipe recorded on the id anchored results page is run on the same page
- **THEN** the run resolves the list parent, finds every result inside it, and returns one row per result

### Requirement: Accessibility candidates for levels
The list parent and item fields SHALL list their candidates like a field does, including role-only candidates, and the user MAY choose which is primary before confirming.

#### Scenario: Role primary for the item
- **WHEN** the item level has `role` `listitem` and `css` `li.product-item` candidates and the user picks the role one as primary
- **THEN** the saved `item.selectors` lists `role` `listitem` first

### Requirement: Selector chain display
Where the panel shows an item container or an item scoped field, it SHALL also show the composed selector chain from the primary selectors: list parent, then item container, then field, separated by `»`, omitting the levels that are not set. The chain SHALL be display only; the recipe SHALL keep one scoped selector list per level.

#### Scenario: Chain for an item field
- **WHEN** the list parent is `id=rso`, the item container is `css=:scope > div > div`, and the selected element is an item scoped `h3`
- **THEN** the panel shows `id=rso » css=:scope > div > div » css=h3`

#### Scenario: Chain without a list parent
- **WHEN** the confirmed item container has no list parent
- **THEN** the chain starts at the item container

### Requirement: Clear the selection
The selection panel SHALL offer a clear control. Clearing SHALL remove the selection, any item proposal shown for it, and a pending field edit, stop highlighting the selected element, and show the empty state: the pick strip with no inspector, candidates, or actions. The draft SHALL NOT change. Confirmed item containers SHALL stay highlighted.

#### Scenario: Clear after a pick with a proposal
- **WHEN** the user picks a title, the item proposal appears, and the user clicks the clear control
- **THEN** the proposal and the inspector disappear, no item container is set, and the draft's fields are unchanged

### Requirement: Typed selector for the selection
The selection panel SHALL accept selector text in the same `strategy=value` syntax as the list parent and item container fields. With scope `item`, the text SHALL be resolved inside each item container; with scope `page`, against the document. When it matches, the typed candidate SHALL become the primary candidate, shown with its stability and match count, and the first element it matches (in the first container that holds a match for item scope) SHALL become the selected element with its inspector. For item scope the panel SHALL show the number of containers holding at least one match out of the container count. A candidate that matches in only some containers SHALL be accepted, and the panel SHALL offer to mark the field optional. Text that is invalid or matches nothing SHALL show an inline error and leave the previous selection in effect. The same input SHALL be available when nothing is selected and an item container is set.

#### Scenario: Typed item selector
- **WHEN** 24 product cards are confirmed and the user types `css=h3` with no element selected
- **THEN** the first card's `h3` becomes the selection, the primary candidate is `css=h3` with 24 matches, the scope is `item`, and the panel shows `24 / 24 items`

#### Scenario: Partial match
- **WHEN** 10 result containers are confirmed and the user types a selector that matches in 7 of them
- **THEN** the panel shows `7 / 10 items` and offers to mark the field optional, and the field can be added

#### Scenario: Matches nothing
- **WHEN** the user types `css=.no-such-class`
- **THEN** an inline error says the selector matches nothing and the previous selection stays

### Requirement: Edit a saved field
The panel SHALL offer an edit action on each field in the list, by clicking the field's summary or an Edit button. Editing SHALL open the field in the selection panel, prefilled with its name, type, attribute, scope, optional flag, dedup key flag, its saved selector candidates with current match counts, and its primary candidate. The element the field's primary selector resolves to (inside the first container that holds a match for item scope) SHALL be selected and inspected, and every match SHALL be highlighted. When the field resolves nothing on the current page, the panel SHALL show the saved values with a zero-match notice and no selected element. While editing, a new pick or a typed selector SHALL replace the selection for the edited field, and the field options SHALL keep their edited values. "Update field" SHALL replace the field at its position with the edited values and selectors, the chosen candidate first, and refresh its fingerprint from the selected element. "Cancel" SHALL leave the field unchanged. Both SHALL return the panel to the empty state. The field being edited SHALL be marked in the field list, and other panel actions that act on the selection (use as item container, pagination target, record as step) SHALL be unavailable while editing.

#### Scenario: Open a field for editing
- **WHEN** the draft has an item scoped `price` field of type `number`, marked optional, with a `testid` primary, and the user clicks its Edit button
- **THEN** the selection panel shows `price`, `number`, optional on, the `testid` candidate as primary with its count, and the first card's price element is selected and highlighted

#### Scenario: Change the primary candidate and update
- **WHEN** the user edits `price`, chooses its `css` candidate as primary, and clicks Update field
- **THEN** the field stays at the same position in the list and its first saved selector is the `css` candidate

#### Scenario: Re-pick while editing
- **WHEN** the user edits `title`, picks the subtitle element instead, and clicks Update field
- **THEN** the `title` field's selectors resolve the subtitle, its name and options are unchanged, and no new field is added

#### Scenario: Cancel an edit
- **WHEN** the user edits `title`, changes its type to `html`, and clicks Cancel
- **THEN** the `title` field keeps type `text` and its selectors

#### Scenario: Field not on the page
- **WHEN** the user edits a field whose selectors match nothing on the current page
- **THEN** the panel shows the field's saved values and candidates with 0 matches, a zero-match notice, and no selected element

### Requirement: Edit the item container
The confirmed item card SHALL offer an Edit action. Editing SHALL reopen the item proposal block seeded from the confirmed item: the saved list parent and item container as the prefilled fields with their candidates and current match counts, the saved exclusions, the number of siblings skipped as dissimilar, the first three matched items' text as samples, and the broader and narrower levels around the confirmed container when they exist. While editing, the same edits SHALL be available as during the first inference: pick or type the list parent and the item container, choose a primary candidate, choose a broader or narrower level, include all siblings, and add or remove exclusions. Every match SHALL be highlighted and the list parent outlined.

"Update items" SHALL replace the draft's item container, list parent, and exclusions with the edited values, refresh the item fingerprint, and keep every field with its name, scope, and options. Field match counts SHALL be refreshed against the new containers, and a field that no longer matches SHALL show the zero-match warning. Updating SHALL NOT add a field. "Cancel" SHALL leave the item unchanged. Both SHALL close the proposal block and return the panel to the empty state.

When the confirmed item container matches nothing on the current page, the card SHALL say so and SHALL NOT offer Edit; Remove and the list parent re-pick SHALL stay available.

Selection actions that would change the item (use as item container) and field editing SHALL be unavailable while the item is being edited.

#### Scenario: Open the confirmed item for editing
- **WHEN** 24 product cards are confirmed with the product list as list parent and the user clicks Edit on the item card
- **THEN** the proposal block shows the list parent and the card container prefilled with 24 matches, all 24 cards highlighted, and Update items and Cancel actions

#### Scenario: Move to the broader level and update
- **WHEN** the user edits the items, chooses the broader level with 12 matches, and clicks Update items
- **THEN** the draft's item container is the broader element with 12 matches, the field list is unchanged in names and count, and each field shows its refreshed match count

#### Scenario: Include all siblings after confirming
- **WHEN** 8 results were confirmed with 1 sibling skipped as dissimilar, the user edits the items and turns on include all siblings, then updates
- **THEN** the item container matches 9 elements and no sibling is reported as skipped

#### Scenario: Re-pick the item container while editing
- **WHEN** the user edits the items and picks a different element that holds the first item
- **THEN** the proposal shows that element as the item container with its match count, and the draft is unchanged until Update items

#### Scenario: Update breaks a field
- **WHEN** the user updates the items to a level under which the `price` field's selector matches nothing
- **THEN** `price` stays in the field list with the zero-match warning offering re-pick or mark optional

#### Scenario: Cancel keeps the item
- **WHEN** the user edits the items, changes the item selector, and clicks Cancel
- **THEN** the item container, list parent, exclusions, and fields are as they were before Edit

#### Scenario: Item not on this page
- **WHEN** the confirmed item container matches nothing after a navigation
- **THEN** the item card shows a zero-match notice, Edit is absent, and Remove is available
