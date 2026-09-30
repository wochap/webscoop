# recorder Specification

## Purpose

Defines the interactive recording session in which a user opens a page, picks elements, confirms inferred items, edits fields and pagination, test runs, and saves a recipe. The recorder produces recipes; it never runs unattended.

## Requirements

### Requirement: Recording session opens the page with recorder UI
Starting a recording session SHALL open the target URL in a headed persistent browser profile, wait for the page to load, and inject the recorder UI: a picker overlay and a sidebar panel of fixed width 400 CSS pixels docked on the right. The page SHALL count as loaded when its `load` event has fired; the session MAY wait a bounded time for network activity to go idle after that, and a page that never goes idle SHALL NOT fail or end the session. The page content SHALL be pushed left by the panel width, not covered. The UI SHALL be injected again after every navigation within the session, restoring the draft recipe state.

#### Scenario: Panel visible after load
- **WHEN** a recording session opens the playground catalog
- **THEN** the sidebar panel is visible on the right and the catalog remains fully visible to its left

#### Scenario: Page that never goes idle
- **WHEN** the target page keeps a request in flight indefinitely after `load`
- **THEN** the recorder is ready, the session is still open a minute later, and fields can be added and tested

#### Scenario: Navigation keeps the draft
- **WHEN** the user has two fields in the draft and follows a link within the page
- **THEN** the panel reappears on the new page with the same two fields

### Requirement: Panel layout and sections
The panel SHALL be laid out, top to bottom, as: a fixed header with the logo, the mode pill, and the end session control; a Recipe section; a Steps section; a Pagination section; the table tab bar; the content of the active table; and a fixed footer with the test run control, the field and step counts, the save status, and the save control. The header and footer SHALL stay in place while the content between them scrolls. The Recipe, Steps, and Pagination sections SHALL apply to the whole recipe. The content of the active table SHALL hold, in order: a table header with the table's name, its mode ("List · N rows" for a list with its row count, "Page · 1 row" for a page table, "No mode yet" for a table with neither fields nor item container) and a "…" menu; a Rows section showing the item container when one is set; a Pick section; and a Fields section. Sections SHALL be separated by a divider, and each section SHALL have a header with its title, a count when it lists things, and its actions on the right. The Recipe, Steps, and Pagination sections SHALL be collapsible with a chevron in their header. A collapsed Recipe section SHALL show a one-line summary with the recipe name and the URL template with its variables as chips holding their values; a collapsed Steps section SHALL show the step count and a summary of the first steps; a collapsed Pagination section SHALL show the pagination kind and limit, or that pagination is off. The Pagination section SHALL start collapsed; the Recipe and Steps sections SHALL start expanded. Collapse state SHALL last for the session, including across navigations, and SHALL NOT be saved in the recipe.

#### Scenario: Sections in order
- **WHEN** the panel shows a draft with two steps, pagination set, and tables `results` and `page`
- **THEN** the panel shows, in order, the header, the Recipe, Steps, and Pagination sections, the tab bar with `results` and `page`, the active table's header, Rows, Pick, and Fields sections, and the footer

#### Scenario: Collapsed recipe summary
- **WHEN** the recipe is `google-com-search` with URL `https://www.google.com/search?q={query}` and `query` is `top llms`, and the user collapses the Recipe section
- **THEN** the section shows one line with `google-com-search` and the URL with a `query` chip holding `top llms`

#### Scenario: Collapse survives navigation
- **WHEN** the user collapses the Steps section and follows a link on the page
- **THEN** the panel reappears on the new page with the Steps section still collapsed

#### Scenario: Footer stays visible
- **WHEN** the active table has enough fields that the panel content scrolls
- **THEN** the header and the footer with the save control stay visible while the content scrolls

#### Scenario: Header shows the mode
- **WHEN** the active table `results` is a list with 11 containers
- **THEN** the table header reads `results` and "List · 11 rows"

### Requirement: URL template and variables
The session SHALL accept a URL template with `{name}` variables. Before opening, it SHALL prompt for a value for each variable that has no default, then open the substituted URL. Values SHALL be URL-encoded when substituted into the template, as the runner does.

The expanded Recipe section SHALL show:
- the URL template as an editable text input, with each `{name}` variable highlighted inside it;
- below the input, a read-only rendered URL: the exact URL the template opens with the current values;
- a variables table with one row per variable, holding its name, its value, and a remove control, plus a control to add a variable;
- a "Use current page URL" control and a "Reopen" control.

A variable name SHALL be a letter or underscore followed by letters, digits, or underscores. Literal braces SHALL be written as `%7B` and `%7D`; the recorder SHALL NOT offer another escape syntax.

Template edits:
- A template edit SHALL be committed on Enter or when the input loses focus.
- A committed template that has a brace outside a `{name}` variable, or that does not form an absolute `http` or `https` URL once its variables are filled, SHALL be refused with an inline error, and the previous template SHALL stay in effect. The refusal SHALL use the same rule and message as the command line.
- A committed template that uses a new variable SHALL add that variable to the table with an empty value.

The variables table:
- It SHALL list every variable used by the template or by a `type` step value, plus any variable the user added that nothing uses yet.
- Each row SHALL say where the variable is used: "used in URL", "used in step N" for each `type` step whose value references it, "not in URL" when steps use it but the template does not, or "not used".
- Editing a value SHALL change the rendered URL at once, without navigating.
- Renaming a variable SHALL rename every `{old}` reference in the template and in `type` step values to `{new}`. A name that is invalid, or taken by another variable, SHALL be refused with an inline error.
- Removing a variable that nothing uses SHALL remove it at once. Removing a variable still used by the template or by a step SHALL first ask for confirmation, naming where it is used. Confirming SHALL replace each reference with the variable's current value (URL-encoded in the template, raw in step values), then remove the variable.
- A variable that nothing uses SHALL NOT be saved in the recipe.

"Use current page URL" SHALL set the template to the URL of the page that is open now. Each variable with a non-empty value whose encoded value appears exactly once in that URL SHALL be put back as its `{name}` placeholder. The encoded value is the URL-encoded form or the form encoding with `+` for spaces. Other variables SHALL be left out of the template.

When the rendered URL differs from the URL the session last opened (at start or on the last Reopen), the panel SHALL:
- mark the template "edited";
- show an accent and a changed dot on "Reopen";
- show a line "Open page differs" with the part of the URL that differs.

Reopen SHALL navigate to the rendered URL, which then becomes the last opened URL. Navigation inside the page, such as clicks or recorded steps, SHALL NOT mark the template as edited.

A collapsed Recipe section SHALL keep showing the recipe name and the current template with each variable as a chip holding its value.

#### Scenario: Template with one variable
- **WHEN** the session starts with `http://host/catalog?cat={category}` and no default
- **THEN** the user is asked for `category` before the page opens, and the panel shows the template with `{category}` highlighted and a `category` row holding that value

#### Scenario: Edit the template and add a variable
- **WHEN** the template is `https://www.google.com/search?q={query}` and the user commits `https://www.google.com/search?q={query}&hl={lang}`
- **THEN** a `lang` row with an empty value is added, marked "used in URL", and the rendered URL ends with `&hl=`

#### Scenario: Invalid template is refused
- **WHEN** the user commits `https://shop.test/c/{category`
- **THEN** an inline error names the unmatched brace, and the previous template stays in effect

#### Scenario: Rendered URL is encoded
- **WHEN** the template is `https://www.google.com/search?q={query}` and `query` is `top llms`
- **THEN** the rendered URL is `https://www.google.com/search?q=top%20llms`

#### Scenario: Rename a variable used in a step
- **WHEN** a `type` step has value `{login_email}` and the user renames `login_email` to `email`
- **THEN** the step value becomes `{email}`, and the row is named `email` with the same value

#### Scenario: Remove a used variable
- **WHEN** the template is `https://shop.test/c/{category}` with `category` set to `shoes`, and the user removes `category` and confirms
- **THEN** the template becomes `https://shop.test/c/shoes` and the `category` row is gone

#### Scenario: Add a variable for a later step
- **WHEN** the user adds a variable `email` with value `me@acme.dev` and no step uses it yet
- **THEN** the row shows "not used", and saving the recipe does not declare `email`

#### Scenario: Use the current page URL
- **WHEN** the template is `https://shop.test/search?q={query}` with `query` set to `red shoes`, and the open page is `https://shop.test/search?q=red+shoes&page=2`
- **THEN** the template becomes `https://shop.test/search?q={query}&page=2`

#### Scenario: Changed template flags Reopen
- **WHEN** the session opened `https://www.google.com/search?q=top%20llms` and the user changes the template to add `&hl=en`
- **THEN** "Reopen" shows the changed dot, the template is marked "edited", and the panel shows that the open page differs by `&hl=en`

#### Scenario: Navigation in the page does not flag Reopen
- **WHEN** the user clicks a link on the page and nothing in the template or values changed
- **THEN** "Reopen" shows no changed dot

### Requirement: Picking mode
The panel SHALL offer a picking mode. While picking, hovering an element SHALL draw a highlight box around it with a tag showing its tag name, role when present, and a short text excerpt. When the hover target repeats among its siblings, the tag SHALL also say how many similar elements repeat at its level ("N similar siblings", N counting the target, shown when N is at least 2), using the similarity the sibling inference uses. Clicking SHALL select the hover target and leave picking mode. Esc SHALL leave picking mode without selecting. Alt+click SHALL select the element under the cursor even when a host overlay or modal backdrop covers it. Host page click handlers SHALL NOT fire during picking. Key presses aimed at the page SHALL NOT reach the page's own handlers during picking; Esc, the hover walk keys, and the panel's Ctrl+S SHALL keep working. Key presses typed into a panel input SHALL be left alone.

#### Scenario: Hover and select
- **WHEN** picking is active and the user hovers then clicks a product title
- **THEN** the title is highlighted on hover, becomes selected on click, and the page does not navigate to the product

#### Scenario: Pick through a modal backdrop
- **WHEN** a host cookie modal covers the catalog and the user Alt+clicks a product title behind it
- **THEN** the title is selected

#### Scenario: Page keys held back
- **WHEN** picking is active, the page listens for `j` to jump to the next result, and the user presses `j`
- **THEN** the page does not react and picking stays active

#### Scenario: Repeat count in the tag
- **WHEN** picking is active and the user hovers one of 11 similar result blocks under the same parent
- **THEN** the tag says "11 similar siblings"

### Requirement: Selected element inspector
After selection the panel SHALL show: tag name, role and accessible name when present, a text excerpt, and the element's `id`, `data-testid`, `class`, and `aria-*` attributes, each attribute flagged stable or hashed. Attribute names SHALL take only the width of the longest name. Each attribute SHALL be copyable by clicking it:
- The `class` name SHALL copy every class token as a compound class selector, such as `.first.second.css-1x2y`, hashed tokens included.
- One class token SHALL copy `.token`.
- `id` SHALL copy `#value`.
- Any other attribute SHALL copy `[name="value"]`.

Identifiers and values SHALL be escaped so that the copied text is a valid CSS selector. The panel SHALL confirm each copy with a short message showing the copied text, and SHALL report a failure when the clipboard is unavailable.

It SHALL show an ancestor breadcrumb from the document body to the element with role or tag labels. The breadcrumb SHALL show at most the last three crumbs up to the current selection, preceded by an expander that shows every crumb when clicked. The user SHALL be able to move the selection up or down the breadcrumb with Left and Right arrow keys or by clicking a crumb; the highlight and inspector follow, and the shown crumbs follow the selection.

#### Scenario: Walk up to the container
- **WHEN** a product title is selected and the user presses Left twice
- **THEN** the selection moves to the grandparent and the highlight box surrounds it

#### Scenario: Short breadcrumb on a deep page
- **WHEN** the selected `h3` has 22 ancestors
- **THEN** the breadcrumb shows an expander and the last three crumbs ending in the `h3`, and clicking the expander shows all 22 ancestors

#### Scenario: Copy all classes
- **WHEN** the selected element has `class="card css-1x2y featured"` and the user clicks the `class` name
- **THEN** the clipboard holds `.card.css-1x2y.featured` and the panel confirms the copy

#### Scenario: Copy one class
- **WHEN** the user clicks the `featured` token of that element
- **THEN** the clipboard holds `.featured`

#### Scenario: Copy the id
- **WHEN** the selected element has `id="my-id"` and the user clicks it
- **THEN** the clipboard holds `#my-id`

#### Scenario: Copy another attribute
- **WHEN** the selected element has `data-testid="buy button"` and the user clicks it
- **THEN** the clipboard holds `[data-testid="buy button"]`

### Requirement: Selector candidates shown and chosen
For the selected element the panel SHALL list every generated selector candidate with its strategy, value, stability badge, and the number of elements it matches on the current page, ranked as defined by the selector-generation capability. When the element was chosen by hand in this session, by a pick on the page or a click on a breadcrumb crumb, the candidates SHALL be verified against it as defined by the selector-generation capability, and a candidate verified as a miss SHALL carry a badge stating that it reads another element. Candidates shown for a typed selector or for a saved field opened for editing SHALL NOT be verified until the user picks or clicks a crumb. The top candidate SHALL be preselected. The user MAY change which candidate is primary; the saved field SHALL list the chosen candidate first and keep the others in ranked order, hits before misses.

#### Scenario: Candidate list for a testid element
- **WHEN** the selected element has `data-testid="product-title"` shared by 24 elements
- **THEN** the list shows a `testid` candidate with match count 24 and a `stable` badge

#### Scenario: Second twin picked
- **WHEN** the catalog is rendered with `twins=1`, `products` has 24 containers, and the user picks the `Sold by` span in one card
- **THEN** the preselected candidate is a hit ending in `p.product-note:nth-of-type(4) > span`, and the added field's sample reads `Sold by Acme` and its test run yields 24 rows whose values all start with `Sold by`

#### Scenario: Crumb click verifies the crumb
- **WHEN** the user picks the `Sold by` span and clicks the `p.product-note` crumb
- **THEN** the candidates belong to the second `p.product-note`, the preselected one is a hit for it, and the `p.product-note` candidate shows the miss badge below it

#### Scenario: Edit shows saved candidates unverified
- **WHEN** the user opens a saved field for editing without picking
- **THEN** the saved candidates are listed in saved order with no miss badge

### Requirement: Item inference from one pick
When a selection is made in a table that has no item container, the recorder SHALL look for a repeating structure as defined by the selector-generation capability. The recorder SHALL NOT open the list setup or change the table on its own. When the table has no fields and a repeating structure is found, the Pick section SHALL show, below the field form and above "Add field", a list suggestion card saying how many times the element repeats on the page and asking whether to make the table a list, with the text of the first three matched items and a "+ N more" line, "Set up list" (key `L`), and "No, single value". "Set up list" SHALL open the list setup seeded with the proposed list parent and item container, as defined in "List setup". "No, single value" SHALL hide the card for this selection. "Add field" SHALL stay available and SHALL say that adding makes the table a page table. When the table has no fields and no repeating structure is found, the Pick section SHALL offer a quiet "Set up list manually…" link that opens the list setup with empty list parent and item rows. When the table is a page table and a repeating structure is found, the Pick section SHALL show one quiet line saying how many times the element repeats with a "start a list table" action, which SHALL create a new table, activate it, keep the selection, and open the list setup there.

The item container candidates of every level SHALL be relative to the list parent when one is set, and their match counts SHALL be counted inside the list parent. The stated number of matches SHALL agree with the item set the samples come from. The number of siblings skipped as dissimilar SHALL be shown in the list setup.

When the active table is a list, no suggestion SHALL be shown for picks inside its containers; picks outside them are handled as defined in "Picks outside the active list".

#### Scenario: Catalog title infers 24 items
- **WHEN** the user picks one product title on the tier 0 catalog in an empty table
- **THEN** the Pick section shows the title selected and a suggestion card saying it repeats 24 times, with three product samples, and the table still has no item container

#### Scenario: Setup seeded from the suggestion
- **WHEN** the user chooses "Set up list" on that card
- **THEN** the list setup proposes the product list as list parent and the product card as item container with 24 items, and all 24 cards are highlighted

#### Scenario: Broader level
- **WHEN** the list setup proposes the inner link element with 24 matches and the user chooses the card element above it in "Adjust item level"
- **THEN** the item container becomes the card element with 24 matches and the highlights update

#### Scenario: No repetition
- **WHEN** the user picks the page heading in an empty table
- **THEN** no suggestion card is shown, the Pick section offers "Set up list manually…", and the field is offered with scope `page`

#### Scenario: Single value chosen
- **WHEN** the suggestion card is shown and the user chooses "No, single value" and then "Add field"
- **THEN** the card is gone, the field is added with scope `page`, and the table is a page table

#### Scenario: Skipped siblings shown
- **WHEN** the picked title sits in a result list with 8 results and one dissimilar block, and the user opens the list setup
- **THEN** the setup shows 8 items and 1 skipped

#### Scenario: Search results under an id anchored list parent
- **WHEN** the user picks a result title on a page where the results sit under `div#rso` inside anchored wrappers, with hashed classes on each result, and opens the list setup
- **THEN** the list parent is `id` `rso`, the item container's top candidate matches every result inside it, and the count is greater than 0 and equal to the number of samples' item set

#### Scenario: Page table with a repeating pick
- **WHEN** the page table `summary` has two fields and the user picks a result title that repeats 11 times
- **THEN** the Pick section shows one line saying it repeats 11 times with "start a list table", and choosing it creates and activates a new table with the list setup open for the title

#### Scenario: Second list in a new table
- **WHEN** `products` has 24 containers, the user adds a table `questions`, picks a heading inside one `mixed-questions` block, and sets up the list
- **THEN** the list setup proposes the questions blocks as containers of `questions`, and accepting leaves `products` unchanged

### Requirement: Exclusions
While the list setup is open, the user SHALL be able to add and remove exclusion selectors. Containers matching an exclusion SHALL be removed from the highlighted set and from the match count, and the exclusion SHALL be saved in the recipe's `item.exclude` list. After the list is set, the Rows section SHALL list the exclusions with their counts, read-only, only when there is at least one, and SHALL offer no exclusion input. Exclusions SHALL be changed through the Rows section's Edit.

#### Scenario: Exclude sponsored cards
- **WHEN** 24 cards match in the list setup and the user adds the exclusion `.sponsored` matching 2 of them
- **THEN** the count shows 22 and those 2 cards lose their highlight

#### Scenario: Exclusions shown read-only
- **WHEN** the list is set with the exclusion `.sponsored`
- **THEN** the Rows section lists `.sponsored` with its count and offers neither a remove control nor an exclusion input

#### Scenario: No exclusions
- **WHEN** the list is set without exclusions
- **THEN** the Rows section shows no exclusion area

### Requirement: Add as field
The user SHALL be able to turn the selection into a field with a name (defaulting to a slug of the accessible name or text, unique within its table), a type among `text`, `number`, `url`, `image`, `date`, `html` (defaulting to `url` for links, `image` for images, `number` when the text is numeric, else `text`), an attribute to read (defaulting to `href` for links and `src` for images), optional flag, and dedup key flag. The field's scope SHALL follow the table's mode as defined in "One mode per table", and the form SHALL offer no scope choice. The field SHALL go to the active table: the Pick section lives inside the active table's tab and offers no other target table. When the active table is a list, "Add field" SHALL be available only for a selection inside one of its containers. Activating another tab while an element is selected SHALL recompute the selection for that table. Adding the `+` tab while an element is selected SHALL create the table, activate it, and recompute the selection for it. The selection panel SHALL show these options as a form prefilled with the defaults before the field is added, and adding SHALL use the form's values. After a field is added, the panel SHALL return to the empty state described in "Clear the selection". Fields SHALL be listed under their table with name, type, sample value, and match count, and SHALL be reorderable within their table by drag or Alt+Up and Alt+Down. The Pick section SHALL also offer to mark the selection as the pagination target and to record it as a step.

#### Scenario: Link becomes url field
- **WHEN** the table is a list and the user adds a product link inside a card as a field
- **THEN** the field defaults to type `url`, attribute `href`, and scope `item`

#### Scenario: Duplicate name is rejected inline
- **WHEN** the user names a second field `price` in the same table
- **THEN** the panel shows an error on the name and does not save until it is unique

#### Scenario: Same name in another table
- **WHEN** `products` has a `title` field and the user adds a `title` field to `page`
- **THEN** the field is added without error

#### Scenario: Options chosen before adding
- **WHEN** the user selects a price, sets the name to `amount`, the type to `number`, and turns on optional, then adds the field
- **THEN** the field list shows `amount` as a `number` field marked optional

#### Scenario: No scope choice
- **WHEN** an element is selected
- **THEN** the field form offers name, type, attribute, optional, and key, and no scope choice

#### Scenario: Pick outside the list goes to the page table
- **WHEN** `products` is the active list with 24 containers, a table `page` without item exists, and the user picks the category heading
- **THEN** "Add field" is unavailable for `products`, the banner for picks outside the list is shown, and only choosing "Add to page" activates `page` with the heading selected with scope `page`

#### Scenario: Pick outside the list with no page table
- **WHEN** `products` is the only table and the user picks the category heading
- **THEN** `products` stays active, "Add field" is unavailable, and the banner offers "New page table"

#### Scenario: New tab while selected
- **WHEN** an element is selected and the user clicks the `+` tab
- **THEN** a new table is created and active, the selection is kept and computed for the new table, and adding puts the field in it

#### Scenario: No target table dropdown
- **WHEN** an element is selected
- **THEN** the field form offers no choice of table

#### Scenario: Adding returns to the empty state
- **WHEN** the user adds the selection as a field
- **THEN** the inspector, the candidate list, and the selected element highlight are gone, and the pick strip offers a new pick

### Requirement: Zero match fields
A field whose primary selector matches nothing on the current page SHALL be marked with a warning in the field list and offer to re-pick or mark optional. When the draft has recorded steps, the warning SHALL also say that the element may appear only after the steps and offer to replay them in order.

#### Scenario: Field breaks after navigation
- **WHEN** a field matched 24 elements on page one and matches 0 after navigating to another page
- **THEN** the field row shows the warning with the two actions

#### Scenario: Field behind a gate
- **WHEN** the draft has a consent click step, the page was reloaded, and a field matches 0
- **THEN** the warning offers to replay the steps, and after replaying the field's count is 24 again

### Requirement: Pagination target
The user SHALL be able to mark a selection as the pagination target. The recorder SHALL detect the likely kind: `url` when the target is a link whose `href` differs from the current URL only by a numeric query parameter or path segment, `next` for any other link, `more` for a button. The user MAY override the kind, and MAY choose `scroll` without a target. The panel SHALL let the user choose the limit (first page only, first N pages, all pages) and toggle stop rules. The result SHALL be saved in the recipe's `pagination` block. Pagination SHALL NOT be executed by the recorder in this change.

#### Scenario: Numeric page link detected as url kind
- **WHEN** the current URL is `/catalog?page=1` and the user marks a link to `/catalog?page=2`
- **THEN** the panel proposes kind `url` with parameter `page`, start 1, step 1

### Requirement: Test run from the panel
The panel SHALL offer a test run that executes the draft recipe on the current page using the same extraction behavior as `webscoop run`, without pagination, and shows a results drawer with one tab per table, opened on the active table, each showing the first rows as a table, a JSON view, per-field status (`ok`, `partial`, `missing`), row count, the number of rows dropped for missing required fields with the fields that caused them, and the run's duration. A required field whose element reads empty counts as missing on that row, as in the runner. The drawer SHALL NOT overlap the panel.

#### Scenario: Test run on the catalog
- **WHEN** the draft has title and price fields and the user runs a test
- **THEN** the drawer shows 24 rows, both fields `ok`, and the JSON view matches the table

#### Scenario: Test run with dropped rows
- **WHEN** the draft has a required `url` field that 2 of 24 containers lack
- **THEN** the drawer shows 22 rows, `url` as `partial`, and a notice that 2 rows were dropped for `url`

#### Scenario: Test run with an empty required field
- **WHEN** the draft has a required `desc` field and one container's description element holds only whitespace
- **THEN** the drawer shows 23 rows, `desc` as `partial`, and a notice that 1 row was dropped for `desc`

#### Scenario: Test run with two tables
- **WHEN** the draft has tables `page` (1 field) and `products` (24 containers) and the user runs a test
- **THEN** the drawer shows a `page` tab with 1 row and a `products` tab with 24 rows

### Requirement: Save
Saving SHALL validate the draft with the recipe schema, write it to the recipes directory under the chosen name, and confirm in the panel. A draft with one table named `items` that was not loaded from the `tables` form SHALL be written in the shorthand form; any other draft SHALL be written with `tables`. Validation errors SHALL be shown in the panel next to the offending field or table. Saving SHALL NOT close the session; the user MAY keep editing and save again.

#### Scenario: Save writes the file
- **WHEN** the user saves a draft named `shop-catalog`
- **THEN** `shop-catalog.json` exists in the recipes directory and loads with the recipe schema

#### Scenario: Save two tables
- **WHEN** the user saves a draft with tables `page` and `products`
- **THEN** the file declares `tables` with both entries in strip order and no top level `fields`

### Requirement: Edit an existing recipe
Starting a session with an existing recipe SHALL open its URL (prompting for variables), load its tables with their fields and item containers, and its pagination into the panel, activate the first table, and show each field's match count on the current page. A recipe with one table in the `tables` form SHALL load like the shorthand form, and saving SHALL keep the form it was loaded in.

#### Scenario: Reopen and see counts
- **WHEN** a session is started for a saved recipe with three fields
- **THEN** the panel lists the three fields with their current match counts

#### Scenario: Multi-table recipe refused
- **WHEN** a session is started for a recipe with tables `page` and `products`
- **THEN** the recipe is no longer refused: the browser opens, the strip shows both tables, `page` is active, and each table's fields show their match counts

### Requirement: Isolation from the host page
The recorder UI SHALL render inside a shadow root with all inherited styles reset, use its own embedded fonts, force its own color scheme, and sit above every host element. Host page styles, fonts, `z-index`, and fixed headers SHALL NOT change the panel's appearance. The overlay highlight SHALL remain legible on dark, light, and saturated host backgrounds.

#### Scenario: Hostile host chrome
- **WHEN** the session opens the playground with hostile chrome enabled
- **THEN** the panel renders with its own font and colors, above the fixed header and the cookie modal

### Requirement: Keyboard
The panel SHALL support: `p` to start picking, `L` to open the list setup from the list suggestion, Esc to cancel picking, close a menu, close the list setup, cancel a field edit, or clear the selection when not picking, Enter to accept the list setup, Left and Right to walk the breadcrumb, Up and Down (and `[` and `]`) to walk the hover target up to its parent and back down while picking, Alt+Up and Alt+Down to reorder fields, Alt+Left and Alt+Right to move the focused table tab, F2 to rename the focused table tab, Ctrl+S to save. Esc SHALL act on the first of these that applies, in this order: close a menu, cancel a tab rename, cancel picking, close the list setup, leave browse mode, abort a re-pick, cancel a field edit, clear the selection. Shortcuts SHALL NOT fire while typing in a panel input. While picking, only Esc, the hover walk keys, and Ctrl+S SHALL act.

#### Scenario: Enter confirms items
- **WHEN** the list setup is shown and the user presses Enter
- **THEN** the item container is set

#### Scenario: L opens the list setup
- **WHEN** the list suggestion card is shown and the user presses `L`
- **THEN** the list setup opens seeded from the suggestion

#### Scenario: Esc closes the list setup
- **WHEN** the list setup is open, picking is off, and the user presses Esc
- **THEN** the setup closes, the table is unchanged, and the selection with its suggestion is shown again

#### Scenario: Esc clears the selection
- **WHEN** an element is selected, picking is off, and the user presses Esc
- **THEN** the panel returns to the empty state

#### Scenario: Esc while picking keeps the selection
- **WHEN** an element is selected, the user starts picking, and presses Esc
- **THEN** picking stops and the previous selection is still shown

#### Scenario: Move a tab with the keyboard
- **WHEN** the tabs are `results`, `ads`, `page`, the `ads` tab has focus, and the user presses Alt+Left
- **THEN** the tabs read `ads`, `results`, `page` and `ads` keeps focus

#### Scenario: Rename with F2
- **WHEN** the `ads` tab has focus and the user presses F2, types `sponsored`, and presses Enter
- **THEN** the table is named `sponsored`

#### Scenario: Walk keys while focus is in the panel
- **WHEN** the user clicks "Pick element" in the panel, hovers a result title on the page, and presses Up
- **THEN** the hover target moves to the title's parent even though keyboard focus is on the panel

### Requirement: Session end
Closing the browser window or pressing Ctrl+C SHALL end the session. If the draft has unsaved changes, the CLI SHALL print a warning naming the recipe on stderr. The process SHALL exit 0 after a save and 1 when the session ended with an error.

#### Scenario: Unsaved close
- **WHEN** the user closes the window with unsaved fields
- **THEN** stderr warns that the draft was not saved and the exit code is 0

### Requirement: Re-pick mode
The recorder SHALL support a focused re-pick mode for one field of one table. The panel SHALL activate that table and replace its body with the table and field names, the field's old primary selector, its last known sample value, and its stored fingerprint summary, and prompt the user to click the new location. While hovering, the overlay tag SHALL show the fingerprint similarity score of the hovered element, and the panel SHALL mark scores at or above the recipe threshold as likely. Confirming SHALL replace the field's selectors with freshly generated candidates for the picked element, the picked element's selector first, and refresh the fingerprint. The mode SHALL offer skip and abort. In a run, confirming resumes the run; from `record --repick`, confirming saves the recipe.

#### Scenario: Score shown on hover
- **WHEN** re-pick is active for `price` and the user hovers the new price element
- **THEN** the overlay tag shows a score at or above the threshold and the panel marks it likely

#### Scenario: Confirm replaces selectors
- **WHEN** the user clicks the new element and confirms
- **THEN** the field's first candidate resolves that element and the fingerprint reflects it

#### Scenario: Skip in a run
- **WHEN** the user skips during an interactive run
- **THEN** the run continues and treats the field as missing

#### Scenario: Re-pick in the second table
- **WHEN** a run requests a re-pick of `title` in table `questions`
- **THEN** the panel activates `questions` and names `questions` and `title`, and confirming replaces only that field

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
While the list setup is shown, the user SHALL be able to change the list parent or the item container by picking on the page or by editing the selector text. Picking for the list parent SHALL only accept ancestors of the current item container; picking for the item container SHALL only accept descendants of the current list parent that contain the original selection. When the list setup has no original selection (opened manually or from Rows > Edit), picking for the item container SHALL accept any element inside the list parent, or anywhere on the page when no list parent is set, and picking for the list parent SHALL accept any element when no item container is set yet. After either edit the recorder SHALL recompute the item set inside the list parent, recount, refresh the highlights and samples, and offer candidates for the edited level ranked as defined by the selector-generation capability. Item container candidates offered after an edit SHALL be relative to the list parent in effect. Typed item container selector text SHALL be resolved inside the list parent. A typed selector that resolves nothing SHALL show an inline error and leave the previous value in effect.

#### Scenario: Pick a wider list parent
- **WHEN** the list setup names `div.row` as list parent with 4 items and the user picks `div.grid` for the list parent
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

#### Scenario: Pick the item in a manual setup
- **WHEN** the list setup was opened manually with empty rows and the user picks one product card for the item row
- **THEN** the item container is computed from that card, the items that match it on the page are counted and highlighted, and Accept becomes available

### Requirement: Include all siblings
The proposal block SHALL offer an "include all siblings" toggle. When on, every element under the list parent on the item's level with the item's tag SHALL count as an item regardless of similarity, and the skipped count SHALL read 0. Toggling off SHALL restore the similarity filter. The toggle SHALL not be saved in the recipe; its effect is the item selector chosen on confirm.

#### Scenario: Include dissimilar block
- **WHEN** the proposal shows 8 matches and 1 skipped and the user turns the toggle on
- **THEN** the proposal shows 9 matches and 0 skipped

### Requirement: Saved list parent
Accepting the list setup SHALL save the list parent's ranked candidates as `item.within` when a list parent is set, and omit `within` when the user cleared the list parent. The saved `item.selectors` SHALL be relative to the list parent when `within` is saved, and document relative otherwise. The Rows section SHALL show the list parent with its match count, and with an "inferred" mark when the list parent was inferred, as part of its selector stack. It SHALL offer no re-pick, Change, or clear control for the list parent. The list parent SHALL be changed or cleared through the Rows section's Edit, in the list setup. Setting, re-picking, typing, or clearing a list parent there and choosing "Update list" SHALL rewrite `item.selectors`: relative to the new list parent, keeping the chosen primary candidate first when it has a relative form, or document relative when the list parent was cleared. The item count SHALL be recounted after each rewrite.

#### Scenario: Within saved on confirm
- **WHEN** the user accepts a list setup whose list parent is the product list
- **THEN** the draft's `item.within` lists the list's candidates, `item.selectors` resolve the cards inside that list, and the saved recipe carries both

#### Scenario: Cleared list parent
- **WHEN** the user clears the list parent in the list setup and accepts
- **THEN** the saved recipe's `item` has no `within`

#### Scenario: List parent set after confirming
- **WHEN** the user set up a list manually, cleared the inferred list parent so the item selector is document relative, and accepted, then chooses Edit in the Rows section, picks the product list as list parent, and chooses "Update list"
- **THEN** `item.selectors` are rewritten relative to the product list and the item count stays 24

#### Scenario: Highlights follow the list parent
- **WHEN** a set item container has `within` and relative `item.selectors` that would also match elements outside the list parent
- **THEN** only the containers inside the list parent are highlighted, and a pick inside one of them is item scoped

#### Scenario: Recorded recipe runs
- **WHEN** a recipe recorded on the id anchored results page is run on the same page
- **THEN** the run resolves the list parent, finds every result inside it, and returns one row per result

#### Scenario: Change an inferred list parent
- **WHEN** the Rows section shows the list parent `#rso` marked inferred, and the user chooses Edit, clicks the list parent row, picks `#search`, and chooses "Update list"
- **THEN** the list parent becomes `#search`, the item selectors are rewritten relative to it, and the inferred mark is gone

#### Scenario: Summary has no list parent controls
- **WHEN** the list is set with a list parent
- **THEN** the Rows section shows the list parent in its stack and offers no re-pick, Change, or clear control for it

### Requirement: Accessibility candidates for levels
The list parent and item fields SHALL list their candidates like a field does, including role-only candidates, and the user MAY choose which is primary before confirming.

#### Scenario: Role primary for the item
- **WHEN** the item level has `role` `listitem` and `css` `li.product-item` candidates and the user picks the role one as primary
- **THEN** the saved `item.selectors` lists `role` `listitem` first

### Requirement: Selector chips
Wherever the panel shows a saved or candidate selector outside an input, it SHALL show it as a selector chip, not as `strategy=value` text. A chip SHALL show the strategy as a tag on its left (an icon for `role`, `testid`, and `text`; the glyphs `#` for `id`, `.` for `class`, `{}` for `css`, and `//` for `xpath`), the value, a dot for the stability (`stable`, `medium`, `fragile`, each its own color), and a colored left stripe for the level the selector belongs to (list parent, item, field in an item, page field, each its own color). The value SHALL be prettified: a `role` value `name|label` SHALL read as `name "label"`, a `text` value SHALL be quoted, a leading `#` of an `id`, a leading `.` of a `class`, and a leading `//` of an `xpath` SHALL be dropped, and a leading `:scope >` SHALL be replaced by a direct child marker. A value too long for the space SHALL be cut with an ellipsis, and the full `strategy=value` text with the stability SHALL be available on hover. Chips SHALL be display only.

#### Scenario: Role chip
- **WHEN** a candidate is `role` with value `heading|LLM Leaderboard 2026` and stability `stable`
- **THEN** the chip shows the role icon, `heading "LLM Leaderboard 2026"`, and the stable dot

#### Scenario: Scope prefixed css chip
- **WHEN** an item container selector is `css` with value `:scope > div > div > div`
- **THEN** the chip shows the `{}` tag, the direct child marker, and `div > div > div`, with the item level stripe

#### Scenario: Full value on hover
- **WHEN** a field chip's value is cut with an ellipsis and the user hovers it
- **THEN** the full `strategy=value` text and its stability are shown

### Requirement: Selector input
Every place where the panel accepts selector text SHALL use one selector input. These places are the list parent and item container fields, the typed selector for the selection, and exclusions. The selector input SHALL have:
- a strategy dropdown, as defined in "Panel dropdown menus"
- a value box
- the live match count of the entered selector
- where the place supports it, a pick control and a control that lists the candidates

The strategy trigger SHALL show the strategy's tag and name. The strategy menu SHALL list `role`, `testid`, `id`, `class`, `text`, `css`, and `xpath`, in that order. Each row SHALL show the strategy's tag, its name, and a grey example:

| Strategy | Example |
|---|---|
| `role` | `button "Buy"` |
| `testid` | `data-testid` |
| `id` | `main` |
| `class` | `card` |
| `text` | `"Next"` |
| `css` | `div > a` |
| `xpath` | `ul/li` |

The menu SHALL end with a footer that says pasting `strategy=value` switches the strategy automatically.

Text pasted or typed as `strategy=value` with a known strategy SHALL set the dropdown to that strategy and keep only the value in the box. A value starting with `/` or `./` while the dropdown is on `css` SHALL switch the dropdown to `xpath`. Submitting SHALL send the selector in the `strategy=value` form. A selector that is invalid or matches nothing SHALL mark the input as invalid with an inline error. Picking an element on the page for that place SHALL fill both the dropdown and the value from the picked element's primary candidate.

#### Scenario: Paste switches the strategy
- **WHEN** the dropdown is on `css` and the user pastes `xpath=//ol/li` into the value box
- **THEN** the dropdown shows `xpath` and the value box holds `//ol/li`

#### Scenario: Typed role selector
- **WHEN** the user chooses `role` in the dropdown, types `listitem` in the item container input, and submits
- **THEN** the recorder receives `role=listitem` and the count shows the `listitem` elements inside the list parent

#### Scenario: Strategy menu content
- **WHEN** the user opens the strategy menu while the input is on `id`
- **THEN** the menu lists the seven strategies with their tags and examples, `id` has the accent background, and the footer mentions pasting `id=…`

### Requirement: Selector stack display
Where the panel shows an item container, it SHALL show the levels of the composed selector as a selector stack: one row per level, outermost first (list parent, then item container, then the field when one is shown), each row indented below the previous one with a connector, holding the level's name, the level's primary selector as a selector chip with that level's stripe color, and the level's match count (for a field, the containers holding a match out of the container count). Levels that are not set SHALL be omitted. The stack SHALL be used in the Rows section, the item proposal, the inspector of an item scoped selection, and the editor of an item scoped field. A field row in the field list SHALL show only the field's own chip, not the stack. The stack SHALL be display only. The recipe SHALL keep one scoped selector list per level.

#### Scenario: Stack for an item field
- **WHEN** the list parent is `id=rso`, the item container is `css=:scope > div > div`, and the selected element is an item scoped `h3`
- **THEN** the inspector shows a stack with rows for the list parent `rso`, the item `div > div` with the direct child marker, and the field `h3`, in that order and indented

#### Scenario: Stack without a list parent
- **WHEN** the confirmed item container has no list parent
- **THEN** the stack starts at the item container

#### Scenario: Field row shows one chip
- **WHEN** the field list shows an item scoped `title` field whose table has a list parent and an item container
- **THEN** the row shows one chip for the `title` selector and no list parent or item chip

#### Scenario: Stack is not interactive
- **WHEN** the user clicks a chip in the Rows section stack
- **THEN** nothing changes

### Requirement: Clear the selection
The selection panel SHALL offer a clear control. Clearing SHALL remove the selection, any item proposal shown for it, and a pending field edit, stop highlighting the selected element, and show the empty state: the pick strip with no inspector, candidates, or actions. The draft SHALL NOT change. Confirmed item containers SHALL stay highlighted.

#### Scenario: Clear after a pick with a proposal
- **WHEN** the user picks a title, the item proposal appears, and the user clicks the clear control
- **THEN** the proposal and the inspector disappear, no item container is set, and the draft's fields are unchanged

### Requirement: Typed selector for the selection
The selection panel SHALL accept selector text through the selector input, in the same `strategy=value` form as the list parent and item container fields. When the active table is a list, the text SHALL be resolved inside each item container and the selection SHALL have scope `item`; otherwise it SHALL be resolved against the document with scope `page`. When it matches, the typed candidate SHALL become the primary candidate, shown with its stability and match count, and the first element it matches (in the first container that holds a match for a list) SHALL become the selected element with its inspector. For a list the panel SHALL show the number of containers holding at least one match out of the container count. A candidate that matches in only some containers SHALL be accepted, and the panel SHALL offer to mark the field optional. Text that is invalid or matches nothing SHALL show an inline error and leave the previous selection in effect. The same input SHALL be available in the Pick section when nothing is selected and the active table is a list.

#### Scenario: Typed item selector
- **WHEN** 24 product cards are set and the user types `css=h3` with no element selected
- **THEN** the first card's `h3` becomes the selection, the primary candidate is `css=h3` with 24 matches, the scope is `item`, and the panel shows `24/24` coverage

#### Scenario: Partial match
- **WHEN** 10 result containers are set and the user types a selector that matches in 7 of them
- **THEN** the panel shows `7/10` coverage and offers to mark the field optional, and the field can be added

#### Scenario: Matches nothing
- **WHEN** the user types `css=.no-such-class`
- **THEN** an inline error says the selector matches nothing and the previous selection stays

### Requirement: Edit a saved field
The panel SHALL offer an edit action on each field in the list, by clicking the field's summary or an Edit button. Editing SHALL open the field in the selection panel, prefilled with its name, type, attribute, optional flag, dedup key flag, its saved selector candidates with current match counts, and its primary candidate; the field keeps its scope. The element the field's primary selector resolves to (inside the first container that holds a match for item scope) SHALL be selected and inspected, and every match SHALL be highlighted. When the field resolves nothing on the current page, the panel SHALL show the saved values with a zero-match notice and no selected element. While editing, a new pick or a typed selector SHALL replace the selection for the edited field, and the field options SHALL keep their edited values. "Update field" SHALL replace the field at its position with the edited values and selectors, the chosen candidate first, and refresh its fingerprint from the selected element. "Cancel" SHALL leave the field unchanged. Both SHALL return the panel to the empty state. The field being edited SHALL be marked in the field list, and other panel actions that act on the selection (list suggestion, list setup, pagination target, record as step) SHALL be unavailable while editing.

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
The Rows section of a list SHALL offer an Edit action. Editing SHALL open the list setup seeded from the set item container: the saved list parent and item container with their candidates and current match counts, the saved exclusions, the number of siblings skipped as dissimilar, and the first three matched items' text as samples, with no "your pick" row. The screen SHALL be titled for editing, SHALL show the item count before the edit next to the current one, and SHALL name the accept action "Update list". While editing, the same edits SHALL be available as in any list setup: pick or type the list parent and the item container, choose a primary candidate, adjust the item level and the list parent from the ladders, include all siblings, and add or remove exclusions. While the edited container differs from the saved one, the screen SHALL list every field of the table whose primary candidate would match in fewer of the new containers than there are, with its coverage against them, and SHALL say when a field would read nothing.

"Update list" SHALL replace the table's item container, list parent, and exclusions with the edited values, refresh the item fingerprint, and keep every field with its name, scope, and options. Field match counts SHALL be refreshed against the new containers, and a field that no longer matches SHALL show the zero-match warning. Updating SHALL NOT add a field. "Cancel" SHALL leave the item unchanged. Both SHALL close the list setup and return the panel to the empty state.

The Rows section SHALL offer Remove only while the table has no fields. When the set item container matches nothing on the current page, the Rows section SHALL say so and SHALL NOT offer Edit; the list parent re-pick SHALL stay available, and Remove SHALL stay available while the table has no fields.

Field editing SHALL be unavailable while the list setup is open.

#### Scenario: Open the confirmed item for editing
- **WHEN** 24 product cards are set with the product list as list parent and the user clicks Edit in the Rows section
- **THEN** the list setup shows the list parent and the card container with 24 items, all 24 cards highlighted, and Update list and Cancel actions

#### Scenario: Move to the broader level and update
- **WHEN** the user edits the list, chooses a level with 12 matches in "Adjust item level", and clicks Update list
- **THEN** the table's item container is that element with 12 matches, the field list is unchanged in names and count, and each field shows its refreshed match count

#### Scenario: Previous count shown
- **WHEN** the user edits a list of 11 items and chooses a level with 13 matches
- **THEN** the screen shows 13 items and that it was 11

#### Scenario: Field that would read nothing
- **WHEN** the user edits the list to a level under which the `rating` field's primary candidate matches in none of the 13 new containers and `title` matches in 11
- **THEN** the screen says 1 field would read nothing and lists `rating` with `0/13` and `title` with `11/13`

#### Scenario: Include all siblings after confirming
- **WHEN** 8 results were set with 1 sibling skipped as dissimilar, the user edits the list and turns on include all siblings, then updates
- **THEN** the item container matches 9 elements and no sibling is reported as skipped

#### Scenario: Re-pick the item container while editing
- **WHEN** the user edits the list and picks a different element that holds the first item for the item row
- **THEN** the setup shows that element as the item container with its match count, and the draft is unchanged until Update list

#### Scenario: Update breaks a field
- **WHEN** the user updates the list to a level under which the `price` field's selector matches nothing
- **THEN** `price` stays in the field list with the zero-match warning offering re-pick or mark optional

#### Scenario: Cancel keeps the item
- **WHEN** the user edits the list, changes the item selector, and clicks Cancel
- **THEN** the item container, list parent, exclusions, and fields are as they were before Edit

#### Scenario: Item not on this page
- **WHEN** the set item container matches nothing after a navigation
- **THEN** the Rows section shows a zero-match notice and Edit is absent

#### Scenario: No remove once locked
- **WHEN** the list `results` has a field
- **THEN** the Rows section offers Edit and no Remove

### Requirement: Table tab bar
The panel SHALL show a table tab bar with one tab per table of the draft, in recipe order, each with the table's name, its row count on the current page when known, an icon for its mode (a list icon for a list, a page icon for a page table, and a neutral icon for a table with no mode yet), and an error dot when the table has a validation error. One tab SHALL be active. A new draft SHALL start with one table named `items`. A pinned `+` tab at the end SHALL add a table (with a name unique among the draft's tables, kebab-case, defaulting to `page` when no table without an item container exists, else `table-N`) and activate it. When the tabs do not fit, the bar SHALL scroll horizontally and end with a "N more" control listing the hidden tables. Double-clicking a tab, pressing F2 on a focused tab, or choosing Rename in the table's "…" menu SHALL rename the table inline; a name that is not kebab-case or not unique SHALL be refused with an error and the previous name kept. The table's "…" menu SHALL offer Rename, Move left, Move right, Use for pagination, Clear table, and Remove table, and SHALL show the mode lock as defined in "Clear table". Remove table SHALL be offered only when the draft has more than one table and SHALL remove the table's item container and fields. Tabs SHALL be reorderable by dragging a tab, by Alt+Left and Alt+Right on a focused tab, and by Move left and Move right; the `+` tab SHALL NOT move and SHALL NOT be a drop target. The order of the tabs SHALL be the order of the recipe's tables. Use for pagination SHALL move the table in front of every other table with an item container; it SHALL be unavailable for a table without an item container and for the table that already drives pagination. When the draft's pagination kind is not `none`, the tab of the primary table (the first table with an item container) SHALL carry a "drives pagination" badge, and when a reorder changes the primary table, the panel SHALL show a toast naming the new primary table. Reordering SHALL NOT offer undo. The active table SHALL receive picks, list suggestions, list setups, added fields, field edits, and item edits. Switching and reordering tabs SHALL be unavailable while the list setup is open.

#### Scenario: Add a page table
- **WHEN** the draft has the table `products` with 24 containers and the user clicks the `+` tab
- **THEN** the tab bar shows `products` and a new active table named `page` with no item container and no fields

#### Scenario: Rename rejects duplicates
- **WHEN** the user renames a table to `products` while a table `products` exists
- **THEN** the panel shows an error on the name and keeps the previous name

#### Scenario: Remove a table
- **WHEN** the draft has tables `page` and `products` and the user chooses Remove table on `page`
- **THEN** only `products` remains, it is active, and the draft has no `page` fields

#### Scenario: Drag to reorder
- **WHEN** the tabs are `results`, `summary`, `ads` and the user drags `ads` before `results`
- **THEN** the tabs read `ads`, `results`, `summary` and a saved recipe lists the tables in that order

#### Scenario: Primary table changes
- **WHEN** pagination is `next`, `results` and `ads` both have item containers, `results` is first, and the user chooses Use for pagination on `ads`
- **THEN** `ads` moves in front of `results`, the drives pagination badge moves to `ads`, and a toast says that `ads` now drives pagination

#### Scenario: No badge without pagination
- **WHEN** the draft's pagination kind is `none`
- **THEN** no tab carries the drives pagination badge

#### Scenario: Use for pagination on a page table
- **WHEN** the user opens the "…" menu of a table without an item container
- **THEN** Use for pagination is unavailable

#### Scenario: Overflowing tabs
- **WHEN** the draft has more tables than fit in the tab bar
- **THEN** the bar ends with a "N more" control that lists the hidden tables and activates the one chosen

#### Scenario: Mode icons
- **WHEN** the draft has a list `results`, a page table `summary`, and an empty table `table-3`
- **THEN** `results` shows the list icon, `summary` the page icon, and `table-3` the neutral icon

#### Scenario: Tabs locked during list setup
- **WHEN** the list setup is open on `results`
- **THEN** the other tabs cannot be activated and the tabs cannot be reordered

### Requirement: Host snapshots on deep pages
When the host needs the page's DOM snapshot without a pick, such as when the confirmed item container is edited, the snapshot SHALL succeed regardless of the document's nesting depth. The page SHALL attach its own snapshot to the item edit message, and a snapshot the host requests directly from the browser SHALL be transported in a form that does not depend on nesting depth.

#### Scenario: Edit items on a deeply nested page
- **WHEN** the confirmed item container sits inside a page nested more than 200 elements deep and the user clicks Edit on the Items card
- **THEN** the proposal reopens seeded from the confirmed container with no error

#### Scenario: Host snapshot of a deep document
- **WHEN** the host requests a snapshot of a document nested more than 200 elements deep
- **THEN** the snapshot is returned with every element present

### Requirement: Field fallback toggle
Each field row SHALL offer a `fallback` toggle next to `optional` and `key`, off by default, that sets the field's `fallback` value in the draft. A test run SHALL honor the value.

#### Scenario: Turn fallback on
- **WHEN** the user turns on `fallback` for field `desc` and saves
- **THEN** the saved recipe has `fallback: true` on `desc`

#### Scenario: Test run with fallback off
- **WHEN** the item container matches a block where the required field's primary candidate misses, and `fallback` is off
- **THEN** the test run drops that row and reports the missing field

### Requirement: Field container coverage
Each item scoped field row SHALL show the number of item containers in which the field's primary candidate matches, out of the container count, in the compact form `9/11`, with a tooltip naming it as items holding a match. A row whose coverage is below the container count SHALL show it in the warning tone.

#### Scenario: Partial coverage shown
- **WHEN** 11 containers are set and the field's primary candidate matches in 9
- **THEN** the field row shows `9/11` in the warning tone

### Requirement: Highlight matches the runner
The page highlight of item containers SHALL cover the same elements the runner resolves as containers for the same item block, including CSS selectors that start with `:scope`.

#### Scenario: Scope prefixed container selector
- **WHEN** the list parent is `id=rso` and the item container is `css=:scope > div > div > div` matching 11 elements
- **THEN** all 11 elements are highlighted as items

### Requirement: One mode per table
Each table of the draft SHALL be in one of three modes, derived from its content: a *list* when it has an item container, a *page table* when it has fields and no item container, and *no mode yet* when it has neither. Every field the recorder adds to a list SHALL have scope `item`, and every field it adds to a page table or to a table with no mode yet SHALL have scope `page`; the recorder SHALL NOT offer a scope choice. While a table has no fields, its item container MAY be set, edited, or removed. Once a table has a field, its mode SHALL be locked: the item container of a list SHALL stay editable but SHALL NOT be removable, and a page table SHALL NOT get an item container. When a table's first field is added and the table still has the name it was created with by default (`items` for the draft's first table, or the name the `+` tab gave it), the table SHALL be renamed `page` if it became a page table or `items` if it became a list, unless another table already has that name; a name the user typed SHALL NOT be changed.

A draft loaded from a saved recipe whose list holds `page` scoped fields SHALL keep those fields as they are and SHALL save, test, and run them as before. The panel SHALL mark each such field with a warning that it is read once from the page and SHALL offer "Move to page table", which moves the field with its selectors and options to the first table without an item container, creating a table named `page` (or the first free `table-N`) when none exists.

#### Scenario: Empty table has no mode
- **WHEN** a new draft starts
- **THEN** its table `items` has no item container, no fields, and the table header reads "No mode yet"

#### Scenario: First field makes a page table
- **WHEN** the table `items` has no mode yet and the user adds the page heading as a field
- **THEN** the field has scope `page`, the table is renamed `page`, and its header reads "Page · 1 row"

#### Scenario: First field locks a list
- **WHEN** the table `results` has an item container with 11 items and no fields, and the user adds a title field
- **THEN** the field has scope `item`, the header reads "List · 11 rows", and the Rows section offers Edit but no Remove

#### Scenario: User name is kept
- **WHEN** the user renamed the empty table to `search-info` and then adds a field without setting up a list
- **THEN** the table is still named `search-info`

#### Scenario: Old mixed table
- **WHEN** the user opens a saved recipe whose `products` list has an item field `title` and a page field `category`
- **THEN** `category` is shown with a warning and "Move to page table", and a test run still repeats `category` on every `products` row

#### Scenario: Move a page field out of a list
- **WHEN** the user chooses "Move to page table" on `category` and the draft has no table without an item container
- **THEN** a table `page` is created holding `category` with its selectors and options, and `products` keeps only its item fields

### Requirement: List setup
The panel SHALL offer a list setup screen in the Pick section of the active table. It SHALL open from the list suggestion ("Set up list" or the `L` key), from "Set up list manually…", from "Repeats N× — start a list table" and "New list table" (in the new table), and from Edit in the Rows section. It SHALL show, top to bottom: a header naming the table with a back control; the number of items on the page and where they come from; a selector stack with the list parent, the item container, and, when opened from a pick, the pick as a greyed "your pick" row with its coverage; the text of the first three items as samples, with a separator between the text parts of each item and a "+ N more · show all on page" line; the exclusions with their counts and an input to add one; two collapsed controls, "Adjust item level" and "Adjust list parent", each with a one-line summary; and the actions Accept and Cancel. While the screen is open every item container SHALL be highlighted on the page and the list parent outlined.

Clicking the list parent or item row of the stack SHALL turn it into a selector input with a strategy choice, the value, the live match count, a pick control, and the candidate list, as defined for the selector input; a typed or picked value SHALL be applied as defined in "Editing the proposal fields".

"Adjust item level", when opened, SHALL list the pick and its ancestors up to the list parent, each with its distance from the pick (`↑1`, `↑2`, …), its top selector as a chip, and the number of matches of that level inside the list parent; the level the recorder proposes SHALL be marked "likely item"; a level whose matched elements are the same as another listed level SHALL be folded into a line naming that level; the "include all siblings" toggle SHALL be offered here. "Adjust list parent", when opened, SHALL list the ancestors of the item container, each with its chip and the number of children like the item, with the proposed one marked "likely list parent". Hovering a row of either list SHALL outline that element on the page; clicking it SHALL make it the item container or the list parent and recompute the items as defined in "Editing the proposal fields".

When the list parent or the item container resolves nothing, the screen SHALL show 0 items and name the level that matches nothing, and Accept SHALL be unavailable. Accept (or Enter) SHALL set the active table's item container, list parent, and exclusions and close the screen. When the screen was opened from a pick inside the new containers, the panel SHALL return to the selected element, now computed with scope `item` inside the containers and showing its coverage, without adding a field. When the pick is itself an item container, or is not inside one, the panel SHALL return to the empty Pick state with the message "List ready — pick fields inside an item". Cancel (or Esc) SHALL close the screen, leave the table unchanged, and return to the state it was opened from, including the list suggestion. Other tabs, the table's "…" menu, and field edits SHALL be unavailable while the screen is open.

#### Scenario: Open the setup from the suggestion
- **WHEN** the user picks a result title in an empty table, the suggestion says it repeats 11 times, and the user presses `L`
- **THEN** the list setup shows 11 items, the list parent `#rso`, the item container, the title as "your pick" with `11/11`, and three samples, and the 11 items are highlighted on the page

#### Scenario: Accept returns to the pick
- **WHEN** the user accepts the setup
- **THEN** the table has an item container with 11 items and no fields, and the Pick section shows the title selected with scope `item`, `11/11` coverage, and "Add field"

#### Scenario: Cancel keeps the table empty
- **WHEN** the user opens the setup from the suggestion and presses Esc
- **THEN** the table has no item container and the Pick section shows the title selected with the suggestion card again

#### Scenario: Pick is the item itself
- **WHEN** the user picked a whole result block, set up the list with that block as the item container, and accepts
- **THEN** the table has its item container, no field is selected, and the Pick section says "List ready — pick fields inside an item"

#### Scenario: Adjust the item level
- **WHEN** the user opens "Adjust item level" and chooses the level `↑4` with 13 matches
- **THEN** the item container becomes that level, the count reads 13, the samples and highlights update, and the stack shows the new item selector

#### Scenario: Same elements folded
- **WHEN** the levels `↑2` and `↑3` above the pick match the same 11 elements
- **THEN** "Adjust item level" lists `↑3` with its count and shows `↑2` as a line saying it matches the same elements as `↑3`

#### Scenario: Type the list parent by hand
- **WHEN** the user clicks the list parent row, chooses `id` in the strategy choice, and types `search`
- **THEN** the items are recomputed inside `#search`, the count and samples update

#### Scenario: List parent matches nothing
- **WHEN** the user types a list parent selector that matches nothing
- **THEN** the setup shows 0 items, says the list parent matches nothing, and Accept is unavailable

#### Scenario: Manual setup
- **WHEN** the user picks the page heading in an empty table, where nothing repeats, and chooses "Set up list manually…"
- **THEN** the list setup opens with empty list parent and item rows ready for input and Accept unavailable until the item matches at least one element

### Requirement: Picks outside the active list
When the active table is a list and a pick is outside every item container of the table, the Pick section SHALL show the selected element and a banner "Outside the <table> list", and "Add field" SHALL be unavailable for the active table. The banner SHALL offer "Add to <table>" naming the first table without an item container when one exists, else "New page table" with an editable name prefilled with the default new table name, and "Re-pick". When the picked element repeats on its own outside the list, the banner SHALL also say how many times it repeats and offer "New list table". When the pick is inside an item container of another list table, the banner SHALL instead say "Belongs to the <table> list", show that table's list parent and item container as a selector stack with the number of the item holding the pick, and offer "Switch to <table>" and "Re-pick". "Add to <table>", "New page table", and "Switch to <table>" SHALL activate (or create and activate) that table and recompute the kept selection for it, without adding a field. "New list table" SHALL create and activate a new table and open the list setup there from the kept selection. "Re-pick" SHALL start picking. These banners SHALL NOT be shown while a field is being edited or re-picked.

#### Scenario: Pick outside with a page table
- **WHEN** `results` is an active list with 11 items, a page table `summary` exists, and the user picks the result count line
- **THEN** the banner says "Outside the results list", "Add field" is unavailable, and choosing "Add to summary" activates `summary` with the line selected with scope `page`

#### Scenario: Pick outside with no page table
- **WHEN** `results` is the only table and the user picks the result count line
- **THEN** the banner offers "New page table" prefilled with `page`, and choosing it creates `page`, activates it, and keeps the line selected

#### Scenario: Repeating element outside the list
- **WHEN** the user picks a related search link that repeats 9 times outside the `results` containers
- **THEN** the banner says it repeats 9 times and offers "New list table", which creates a table and opens the list setup for the links

#### Scenario: Pick inside another list
- **WHEN** `results` is active, `ads` is a list with 2 items, and the user picks the title inside the first ad
- **THEN** the banner says "Belongs to the ads list", names item 1 of 2, and "Switch to ads" activates `ads` with the title selected with scope `item`

#### Scenario: No field added silently
- **WHEN** the user chooses "Add to summary" from the banner
- **THEN** `summary` has the same fields as before until the user adds the selection

### Requirement: Clear table
The table's "…" menu SHALL show the table's mode and, when the table has fields, a disabled line saying the mode is locked and that Clear table changes it. The menu SHALL offer Clear table when the table has fields or an item container. Clear table SHALL remove the table's fields, item container, list parent, and exclusions, keep its name and position, and leave the table with no mode. Clear table SHALL be unavailable while the list setup is open or a field is being edited.

#### Scenario: Locked mode hint
- **WHEN** the user opens the "…" menu of the list `results` with 3 fields
- **THEN** the menu shows that the mode is locked to list and offers Clear table

#### Scenario: Clear a list
- **WHEN** the user chooses Clear table on `results`
- **THEN** `results` has no fields and no item container, its header reads "No mode yet", and the next repeating pick in it shows the list suggestion

### Requirement: List outlines on the page
While picking with a list as the active table, the page overlay SHALL outline the active table's list parent in the list parent level color and each of its item containers in the item level color, the same colors the selector chips use for those levels, and SHALL lightly dim the rest of the page. The item containers of other list tables SHALL get a muted dashed outline with a label naming the table and "list". The hover tag SHALL say "item k of N" when the hovered element is inside the k-th of the active table's N containers, and SHALL say "outside <table> list" in the warning color when it is outside all of them. With a page table or a table with no mode active, picking SHALL look as before. The overlay SHALL NOT use a color per table.

#### Scenario: Hover inside the list
- **WHEN** `results` is active with 11 containers, picking is on, and the user hovers the title in the third result
- **THEN** the 11 containers are outlined in the item color, the list parent in the list parent color, the rest of the page is dimmed, and the tag says "item 3 of 11"

#### Scenario: Hover outside the list
- **WHEN** the user hovers the result count line above the results
- **THEN** the tag says "outside results list" in the warning color

#### Scenario: Other list muted
- **WHEN** `results` is active and `ads` is a list with 2 containers
- **THEN** the 2 ad containers have a muted dashed outline labeled `ads · list`

### Requirement: Hover walk while picking
In every picking mode (picking a field, picking a list level, re-picking a field or a step), Up or `[` SHALL move the hover target from the current target to its parent, and Down or `]` SHALL move it one step back toward the element under the pointer (the start element). Down at the start element SHALL do nothing. The walk SHALL stop below `body`. Moving the pointer onto another element SHALL reset the hover target to that element. Clicking while the target is walked up SHALL pick the walked target when the click lands inside it, and the element under the pointer otherwise. Alt+click SHALL use the element under the cursor through overlays as the start element, and the walk SHALL apply from it. A walked target SHALL be treated like a hovered one: while picking a list level it is refused with the same reason when out of range, and while re-picking its fingerprint score is shown. While the target is walked up, the hover tag SHALL show the distance from the start element (`↑1`, `↑2`, …) and the target's size in pixels, and a small marker SHALL label the start element "start".

#### Scenario: Walk up to a wrapper
- **WHEN** picking is active, the user hovers a result title, and presses Up twice
- **THEN** the highlight moves to the title's grandparent, the tag shows `↑2`, the repeat count, and the size, and the title carries the "start" marker

#### Scenario: Click picks the walked target
- **WHEN** the hover target is walked up to the result block and the user clicks the title inside it
- **THEN** the result block is selected, not the title

#### Scenario: Walk back down
- **WHEN** the hover target is walked up twice and the user presses Down once
- **THEN** the highlight moves to the title's parent and the tag shows `↑1`

#### Scenario: Pointer move resets the walk
- **WHEN** the hover target is walked up and the user moves the pointer onto another result's snippet
- **THEN** the snippet is the hover target and the tag shows no distance

#### Scenario: Walk while picking a list parent
- **WHEN** the user picks the list parent in the list setup, hovers a title, and presses Up until the target is the results wrapper
- **THEN** the wrapper is not refused and clicking selects it as the list parent

#### Scenario: Walk refused level
- **WHEN** the user picks the item level in the list setup and walks the target up above the list parent
- **THEN** the tag says the element is outside the list and a click is ignored

### Requirement: Pick hints
While picking, the page overlay SHALL show a hint strip at the bottom of the viewport reading "Picking", followed by "in <table>" when the active table is a list, with the key hints "↑ ↓ parent / child", "click to pick", "Alt+click through overlays", and "Esc cancel". The strip SHALL NOT take pointer events. While picking, the Pick section of the panel SHALL show "Picking on the page" with a Cancel control and, when an element is hovered, a hovering card with the walk distance when walked up, the repeat count when the target repeats, and a short path from the hover target down to the start element with the start element marked "start". The card SHALL show the hint "Wrappers are hard to click — hover any child and press ↑ until the whole item is outlined." Leaving picking mode SHALL remove the strip and the card.

#### Scenario: Strip in a list table
- **WHEN** `results` is an active list and the user starts picking
- **THEN** the bottom of the page shows "Picking in results" with the key hints

#### Scenario: Hovering card follows the walk
- **WHEN** the user hovers a result title and presses Up twice
- **THEN** the Pick section shows `↑2`, "11 similar siblings", and a path from the result block down to the title marked "start"

#### Scenario: Hints go away
- **WHEN** the user presses Esc while picking
- **THEN** the strip and the hovering card are gone

### Requirement: Inferred list parent
When a list setup opened from a pick proposes a list parent, and when a list setup opened manually or from a new list table gets an item container while no list parent was set or cleared by the user, the recorder SHALL use as list parent the nearest common ancestor of every matched item container that is below `body`, or no list parent when that ancestor is `body` or the document. The item container candidates SHALL then be computed relative to that list parent, and the item count SHALL not change. Such a list parent SHALL be marked inferred. The mark SHALL be shown as an "inferred" badge on the list parent row of the selector stack in the list setup and in the Rows section, and in the "Adjust list parent" summary. Picking, typing, choosing from the "Adjust list parent" list, or clearing the list parent SHALL remove the mark; a list parent the user cleared SHALL NOT be inferred again during the same list setup. Changing the item level SHALL keep the list parent and its mark. Accepting the list setup SHALL keep the mark on the table's item container for the rest of the session. The mark SHALL NOT be saved in the recipe; a list loaded from a saved recipe SHALL show no mark.

#### Scenario: Inferred from a pick
- **WHEN** the user picks a result title in an empty table and opens the list setup from the suggestion
- **THEN** the list parent row shows `#rso` with the "inferred" badge and "Adjust list parent" summarizes `#rso · inferred`

#### Scenario: Inferred in a manual setup
- **WHEN** the user opens "Set up list manually…" and picks one product card for the item row, and all 24 cards sit in the product grid
- **THEN** the list parent becomes the product grid marked inferred, the item selector is relative to it, and the count stays 24

#### Scenario: No list parent at body
- **WHEN** a manual setup's item selector matches elements whose nearest common ancestor is `body`
- **THEN** the list parent stays empty and nothing is marked inferred

#### Scenario: User choice removes the mark
- **WHEN** the list parent is inferred and the user types `id=search` in its row
- **THEN** the list parent is `#search` and shows no "inferred" badge

#### Scenario: Cleared stays cleared
- **WHEN** the user clears an inferred list parent and then picks another item level
- **THEN** the list parent stays empty

#### Scenario: Mark kept after accept
- **WHEN** the user accepts a setup with an inferred list parent
- **THEN** the Rows section stack shows the list parent with the "inferred" badge and its control reads "Change"

#### Scenario: Not saved
- **WHEN** the recipe is saved and opened again in a new recording session
- **THEN** the Rows section shows the list parent without the "inferred" badge and the saved recipe has no field for the mark

### Requirement: Match highlight for a pick
The page SHALL highlight in the match style every element that the selection's item-relative primary candidate resolves to, inside each item container, in these states:
- The list setup is open from a pick. The containers are the proposed items, and the candidate is the pick's top relative candidate shown on the "your pick" row.
- The active table has a set item container and the selection is inside one of its containers, with scope `item`. The containers are the table's non-excluded containers.

No match highlight SHALL be shown in these states:
- For a selection while the active table has no item container and no list setup is open, including while the list suggestion is shown and after a page-scoped field is added.
- For a selection outside every container.
- For a selection that is itself an item container.
- Inside excluded containers.

The highlight SHALL follow the selection: it SHALL update when the user walks the selection up or down or chooses another candidate, and it SHALL clear when the selection is cleared or a field is added. Editing a saved field SHALL keep highlighting every match of the edited field as defined in "Edit a saved field".

#### Scenario: Suggestion without green
- **WHEN** the user picks a result title in an empty table and the list suggestion appears
- **THEN** only the picked title is highlighted and no other title shows the match highlight

#### Scenario: Green during list setup
- **WHEN** the user opens the list setup from that pick and the proposal has 11 items
- **THEN** the title in each of the 11 items shows the match highlight

#### Scenario: Green after accepting the list
- **WHEN** the user accepts the setup and the panel returns to the title selected with scope `item`
- **THEN** the title in each item container shows the match highlight without adding a field

#### Scenario: Green on a later pick
- **WHEN** the list is set, a field was added, and the user picks the price inside the third item
- **THEN** the price in every item container that has one shows the match highlight

#### Scenario: Page table without green
- **WHEN** the active table has no item container and the user picks the page heading and adds it as a field
- **THEN** no match highlight is shown before or after adding it

#### Scenario: Walk out of the item
- **WHEN** the list is set and the user walks the selection up with Left past the item container
- **THEN** the match highlight clears

#### Scenario: Excluded container
- **WHEN** the list is set with the exclusion `.sponsored` and the user picks a title inside a normal item
- **THEN** titles inside the sponsored containers show no match highlight

### Requirement: Panel dropdown menus
The panel SHALL render its choice menus (the selector input's strategy choice and the field type choice) as panel menus in the panel's theme, not as browser-native select menus.

**Trigger**
- The trigger SHALL show the current value.
- It SHALL open the menu on click, Enter, Space, ArrowDown, or ArrowUp.

**Menu**
- The menu SHALL float below the trigger, or above it when there is not enough room below inside the panel.
- It SHALL NOT be clipped by the section that contains the trigger.
- It SHALL mark the current value with the accent background and SHALL focus it on open.

**Keys in an open menu**
- ArrowDown and ArrowUp SHALL move the active row, wrapping at the ends.
- Home and End SHALL jump to the first and last row.
- Typing a letter SHALL move to the next row whose name starts with it.
- Enter or Space SHALL choose the active row and close the menu.
- Escape SHALL close the menu without changing the value and SHALL NOT trigger any other panel or page shortcut, such as cancelling picking or the list setup.
- Tab SHALL close the menu.

**Mouse**
- Clicking a row SHALL choose it.
- Clicking outside the menu SHALL close it.

**Focus and roles**
- Choosing a row or closing the menu SHALL return focus to the trigger.
- The trigger SHALL expose a button role with an expanded state, and the menu SHALL expose listbox and option roles with the selected option marked.

#### Scenario: Choose with the keyboard
- **WHEN** the field type trigger shows `text`, the user focuses it, presses ArrowDown to open the menu, presses ArrowDown once, and presses Enter
- **THEN** the field type becomes `number` and focus is on the trigger

#### Scenario: Escape only closes the menu
- **WHEN** the list setup is open and the user opens the strategy menu of the item container input and presses Escape
- **THEN** the menu closes, the strategy is unchanged, and the list setup stays open

#### Scenario: Outside click closes
- **WHEN** a menu is open and the user clicks elsewhere in the panel
- **THEN** the menu closes and the value is unchanged

#### Scenario: Menu near the panel bottom
- **WHEN** the trigger is near the bottom of the panel and the menu would not fit below it
- **THEN** the menu opens above the trigger, fully visible

### Requirement: Field type menu content
The field type menu SHALL list `text`, `number`, `url`, `image`, `date`, and `html`, in that order. Each row SHALL show a glyph, the type name, and a short grey example of what the type reads.

#### Scenario: Type rows
- **WHEN** the user opens the field type menu
- **THEN** it lists the six types in order, each with a glyph and an example, and the current type has the accent background

### Requirement: Humanize toggle
The Recipe section SHALL offer a "Humanize input" toggle with a short hint that it slows runs to look like a person and that it helps on sites with bot protection. The toggle SHALL show the draft's `browser.humanize`, off when it is absent. Turning it on SHALL set `browser.humanize` to `true` in the draft. Turning it off SHALL remove the key, and an empty `browser` block SHALL then be removed too. Saving SHALL write the value to the recipe. Editing a recipe SHALL keep its other `browser` keys (`proxy`, `timezone`, `locale`) unchanged. The recording session itself SHALL NOT use humanized input.

#### Scenario: Turn on and save
- **WHEN** the user turns on "Humanize input" and saves
- **THEN** the saved recipe has `browser.humanize` set to `true`

#### Scenario: Other browser keys kept
- **WHEN** a recipe with `browser.proxy` and `browser.timezone` is edited, the toggle is turned on, and the recipe is saved
- **THEN** the saved recipe keeps `browser.proxy` and `browser.timezone` and adds `browser.humanize` set to `true`

#### Scenario: Turn off removes the key
- **WHEN** a recipe whose `browser` block holds only `humanize: true` is edited, the toggle is turned off, and the recipe is saved
- **THEN** the saved recipe has no `browser` block

### Requirement: Field hover toggle
A saved field row SHALL show a `hover` toggle next to `optional`, `fallback`, and `key`, and the pick form SHALL show one next to `optional` and `key`, so the flag can be set before the field is added; both carry a tooltip saying the mouse is moved over the element before it is read. The pick form's toggle SHALL start off for a new selection and at the stored value when a saved field is opened for editing, and Add field or Update SHALL send its value. Toggling it SHALL update the draft field's `hover` flag, and saving SHALL write it to the recipe (left out when false). Editing a recipe SHALL show the stored value.

#### Scenario: Turn on hover
- **WHEN** the user turns on the `hover` toggle of a field and saves
- **THEN** the saved recipe's field has `"hover": true`

#### Scenario: Hover from the pick form
- **WHEN** the user selects an element, turns on `hover` in the pick form, and adds the field
- **THEN** the new field has `hover` on

#### Scenario: Edit keeps hover
- **WHEN** a recipe whose field has `"hover": true` is opened with `webscoop edit`
- **THEN** that field's `hover` toggle is on

### Requirement: Preview of hover fields
The recorder's preview SHALL NOT move the mouse pointer for hover fields; it SHALL read their elements as they are. Preview values of a field with `hover` on SHALL carry a visible badge stating the value is resolved on hover at run time, in the field row and in the results preview.

#### Scenario: Badge
- **WHEN** a field has `hover` on
- **THEN** its preview value shows the hover badge and the pointer is not moved by the preview

### Requirement: Panel input events stay out of the page
User input events that start inside the recorder UI (the panel, the overlay, and the results drawer) SHALL NOT reach event listeners the page registered in the bubble phase on its own elements, `document`, or `window`. This covers keyboard (`keydown`, `keyup`, `keypress`), text input (`beforeinput`, `input`, `change`, composition events), clipboard (`copy`, `cut`, `paste`), pointer, mouse (including `click`, `dblclick`, `auxclick`, `contextmenu`), `wheel`, and focus-change (`focusin`, `focusout`) events. Characters typed into panel inputs SHALL still appear there, and every panel control SHALL keep working, including its keyboard shortcuts, menus, and outside-click closing. Listeners the page registered in the capture phase are not covered by this requirement.

#### Scenario: Page does not steal focus while typing
- **WHEN** the page moves focus to its search box on any `keydown` it receives on `document`, and the user types `hello` into a panel text input
- **THEN** the panel input holds `hello` and the page's search box never gains focus

#### Scenario: Page click handler
- **WHEN** the page counts clicks with a bubble-phase listener on `document`, and the user clicks buttons in the panel
- **THEN** the page's count does not change and the panel buttons act

#### Scenario: Panel shortcuts still work
- **WHEN** focus is in the panel (not in an input) and the user presses a panel shortcut such as `p`
- **THEN** the shortcut acts as before
