## ADDED Requirements

### Requirement: Drag feedback in panel lists

Every list in the panel that can be reordered by drag (fields, flow steps, Sequence blocks, and table tabs) SHALL give the same drag feedback:

- **Drag image:** the image that follows the cursor SHALL be a copy of the dragged row, held at the point where the user grabbed it, from the first movement of the drag. For the paginate block the image SHALL be its header row only. The dragged row SHALL stay in place and be dimmed until the drag ends.
- **Drop slot:** while the cursor is over a row of the same list, the drop target SHALL be the gap before that row when the cursor is in the row's first half (top half for vertical lists, left half for the tab bar), else the gap after it.
- **Drop line:** the panel SHALL show a 2px line in the accent color in the drop slot: horizontal for vertical lists, vertical for the tab bar. The line SHALL be fully visible for every slot, including the slot before the first row and the slot after the last row, also when the list scrolls. At most one line SHALL show at a time.
- **No-op slots:** no line SHALL show for the slot directly before or after the dragged row, and dropping there SHALL leave the order unchanged.
- **Drop:** releasing over a row SHALL move the dragged row into the slot the line shows. Ending the drag in any other way (Esc, release outside the list) SHALL remove the line and the dimming, and SHALL leave the order unchanged.
- **Sequence nesting:** Sequence blocks SHALL have slots at the top level and inside the paginate block. An empty paginate block SHALL offer one slot inside it. The paginate block SHALL show no slot inside itself while it is the dragged block.
- A row SHALL accept only rows dragged from its own list: dragging a field over a step, or a step of one flow over a step of another flow, SHALL show no line.

The `+` tab SHALL stay outside the drop targets as defined in "Table tab bar".

#### Scenario: Line shows the slot below the hovered field
- **WHEN** the fields are `title`, `price`, `url` and the user drags `title` with the cursor over the bottom half of `price`
- **THEN** a horizontal accent line shows between `price` and `url`, and dropping orders the fields `price`, `title`, `url`

#### Scenario: Line before the first row
- **WHEN** the steps are `click`, `fill`, `press` and the user drags `press` over the top half of `click`
- **THEN** a line shows above `click`, fully visible, and dropping orders the steps `press`, `click`, `fill`

#### Scenario: No line next to the dragged row
- **WHEN** the user drags the second field over the bottom half of the first field
- **THEN** no line shows, and dropping leaves the order unchanged

#### Scenario: Drag image under the cursor in the Sequence section
- **WHEN** the sidebar is scrolled down to the Sequence section and the user starts dragging a block by its handle
- **THEN** the copy of the block's row is under the cursor at the grab point from the first movement

#### Scenario: Paginate block drag image
- **WHEN** the user drags the paginate block
- **THEN** the drag image shows only its header row, and no line shows inside the paginate block

#### Scenario: Drop into the paginate block
- **WHEN** the Sequence is `flow login`, `paginate` with `extract results` inside, and the user drags `flow login` over the bottom half of `extract results`
- **THEN** a line shows inside the paginate block after `extract results`, and dropping puts `flow login` inside the paginate block after `extract results`

#### Scenario: Empty paginate block
- **WHEN** the paginate block has no blocks inside and the user drags `extract results` over its inner area
- **THEN** a line shows inside the paginate block, and dropping puts `extract results` inside it

#### Scenario: Tab line after the last tab
- **WHEN** the tabs are `results`, `summary`, `ads` and the user drags `results` over the right half of `ads`
- **THEN** a vertical line shows after `ads`, fully visible, and dropping orders the tabs `summary`, `ads`, `results`

#### Scenario: Cancelled drag
- **WHEN** the user drags a field and presses Esc
- **THEN** the line and the dimming go away and the order is unchanged
