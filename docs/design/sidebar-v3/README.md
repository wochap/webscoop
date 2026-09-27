# Sidebar v3 design reference

Claude Design frames for the recorder sidebar. The `.dc.html` files open in Chromium; frame labels are the `label` attributes in the files. The frames are drawn 376px wide; the panel is 400px wide.

The design is implemented by four OpenSpec changes: `sidebar-shell` (layout, sections, tab bar, selector display), `table-modes` (one mode per table, list setup, outside-list banners, overlay colors), `pick-helpers` (hover walk, ancestor ladder, inferred badges), and `recipe-url-edit` (URL template and variable editing).

## Frame index

### `Webscoop Sidebar v2.dc.html`

| Frame | Change | Status |
|---|---|---|
| `Webscoop sidebar v2` (canvas) | — | container of the frames below |
| `01 Idle first open` | `sidebar-shell` | done |
| `02 Recipe editing` | `recipe-url-edit` | |
| `03 Picking` | `pick-helpers` | |
| `03 Picking sidebar` | `pick-helpers` | |
| `04 Element selected` | `sidebar-shell` (inspector, candidates, breadcrumb), `pick-helpers` (ladder) | done for `sidebar-shell` |
| `05 Items proposal` | `table-modes` | done (replaced by the v3 list setup) |
| `06 Working state` | `sidebar-shell` | done |
| `07 Editing field` | `sidebar-shell` | done (without the Non-Goals extras) |
| `08 Component sheet` | `sidebar-shell` (section headers, chip grid, selector input states, tab bar overflow) | done |

### `Webscoop Sidebar v3 - List flow.dc.html`

| Frame | Change | Status |
|---|---|---|
| `Turn 2 list flow` (canvas) | — | container of the frames below |
| `04a Empty table repeating pick` | `sidebar-shell` (Pick section without the CTA card), `table-modes` (CTA card) | done |
| `04b After accept` | `sidebar-shell` | done |
| `04c Outside list` | `sidebar-shell` (Rows stack), `table-modes` (banner) | done |
| `04c2 Outside list repeats` | `table-modes` | done |
| `04d Belongs to ads` | `table-modes` | done |
| `04e Page table repeating` | `table-modes` | done |
| `05a List setup` | `table-modes` | done |
| `05b Adjust item level` | `table-modes`, `pick-helpers` | done for `table-modes` |
| `05c Manual list parent` | `table-modes` | done |
| `05c2 Invalid list parent` | `table-modes` | done |
| `05d Edit list` | `table-modes` | done |
| `06 Overlay` | `table-modes` | done |
| `07 Tab bar states` | `sidebar-shell`, `table-modes` (mode lock, Clear table) | done |

### Components

| File | Change |
|---|---|
| `SelectorChip.dc.html` | `sidebar-shell` (`ui/selector-chip.tsx`) |
| `SelectorInput.dc.html` | `sidebar-shell` (`ui/selector-input.tsx`) |
| `WebscoopScreen.dc.html` | frame wrapper used by the two sidebar files |

## Deviations

Agreed differences between the frames and the panel.

| Design | Panel | Reason |
|---|---|---|
| Toast "ads now drives pagination" with Undo | Toast without Undo | No undo anywhere in the recorder |
| Per-table outline colors on the page overlay; a color dot on each tab | Chips and overlay share the level colors; other tables use a muted outline; no tab color dot | One color meaning across the panel and the page |
| "Drives pagination" badge always on the first list tab | Only when the pagination kind is not `none` | The badge is noise without pagination |
| v2 tab menu "Duplicate" | Not offered | Not in v3; no duplicate table behavior exists |
| `04a`: no "Set up list manually…" | Quiet link when nothing repeats | A way to make a list when detection fails; replaces "Use as item container" |
| `05a` Accept on a pick of the item itself goes to `04b` | Goes to the empty Pick state with "List ready — pick fields inside an item" | A field reading the whole container is not useful |
| `04a` `in item / page` toggle | No scope choice; the scope follows the table's mode | One mode per table |
| "inferred" badge on the list parent row (`05a`, `05b`) | Not shown | The draft does not record whether the list parent was derived; `pick-helpers` adds it |
| `06`: hint "↑ ↓ parent / child" in the pick strip | Not shown | Hover walk belongs to `pick-helpers` |
| `05b`: "on page 13 incl. 2 ads" for a level that also matches other tables' items | Plain match count inside the list parent | Counting other tables' items per ladder row adds cost for a rare hint |
| `05a`: no include all siblings control | Toggle inside "Adjust item level" | Keeps the existing capability reachable without adding a row to the main screen |
| `04c`: new page table name prefilled from the element (`search-info`) | Prefilled with the default new table name (`page` or `table-N`) | Same default as the `+` tab; the user edits it inline |
| `04b` / old item card: Highlight toggle | Removed | Matches are always highlighted during setup; v3 has no toggle |
| `05a`: "+ 8 more · show all on page" link | "+ N more · all highlighted on the page", not a link | Every item is already highlighted while the list setup is open |
| `05b`: the likely item row and a folded row side by side | A level folded into a single-child wrapper above it is listed as "↑n hidden · same elements as ↑m"; "likely item" marks the kept row when the proposed level is not folded | The ladder lists each set of elements once |
| `04a`, `04b`, `04e`: "Add field" with an `Enter` key hint | "Add field" without a key hint | Enter accepts the list setup; adding a field stays a click |
| `05a`: no skipped count | "N skipped as dissimilar" under the count | The recorder spec keeps the skipped count in the list setup |
| `05a`: Exclude above the two "Adjust" controls | Exclude below them | `05b` draws it below; one order for both states |
| `06`: pick strip "Picking in results" at the bottom of the page | The panel's pick strip | The on-page strip belongs to `pick-helpers` with the hover walk |
| 376px frame width | 400px panel | The recorder spec fixes the panel width |
| Phosphor glyphs from unpkg, regular, bold, and fill | Inline SVG subset, regular plus bold for the strategy tags and warnings | The panel runs inside third-party pages and loads nothing remote |
| Rows section: stack only | Stack plus a "N rows" line, the list parent re-pick row, and the exclusion input | Existing edit hooks and exclusions stay reachable without the list setup of `table-modes` |
| Field rows: coverage only | Match count and `9/11` coverage side by side | The recorder spec still lists a match count per field |
| Tab "…" menu on each tab | One "…" menu in the active table's header | Menus act on the active table; the host renames and removes only the active table |
| Selecting a tab while an element is selected: panel sends `draft.selectTable` then `selection.retarget` | The host retargets the kept selection itself on `draft.selectTable` and `draft.addTable` | One message, no window where the selection belongs to no table |
| Pagination starts collapsed | It opens when a pagination target is marked | The user just set it and needs its options |

## Token mapping

Nocturne names (`_ds/nocturne-*/styles.css`) and the panel's `--ws-*` tokens (`packages/inject/src/styles.css`). The panel keeps one token system and embeds its fonts; Nocturne's stylesheet and its Google Fonts import are not loaded.

| Nocturne | Panel | Value |
|---|---|---|
| `--color-bg` | `--ws-bg` | `#161826` |
| `--color-surface` | `--ws-surface` | `#232532` |
| `--color-neutral-900` | `--ws-surface-2`, `--ws-neutral-900` | `#292b31` |
| `--color-neutral-800` | `--ws-neutral-800` | `#3f424d` |
| `--color-neutral-700` | `--ws-edge`, `--ws-neutral-700` | `#595d6c` |
| `--color-neutral-600` | `--ws-neutral-600` | `#75798c` |
| `--color-neutral-500` | `--ws-text-faint`, `--ws-neutral-500` | `#9397ab` |
| `--color-neutral-400` | `--ws-text-muted` | `#b2b6ca` |
| `--color-neutral-300` | `--ws-neutral-300` | `#cfd3e5` |
| `--color-neutral-200` | `--ws-neutral-200` | `#e4e7f5` |
| `--color-text` | `--ws-text` | `#e9e9ed` |
| `--color-divider` | `--ws-border` | `rgba(233, 233, 237, 0.16)` |
| `--color-accent` | `--ws-accent` | `#9184d9` |
| `--color-accent-200` | `--ws-accent-200` | `#e7e5fe` |
| `--color-accent-300` | `--ws-accent-300`, `--ws-accent-text` | `#d2cefd` |
| `--color-accent-400` | `--ws-accent-400` | `#b5abfc` |
| `--color-accent-500` | `--ws-accent-500` | `#968ae0` |
| `--color-accent-600` | `--ws-accent-600` | `#796cbf` |
| `--color-accent-700` | `--ws-accent-700` | `#5d5294` |
| `--color-accent-800` | `--ws-accent-800` | `#423a6a` |
| `--color-accent-900` | `--ws-accent-900`, `--ws-accent-tint` | `#2b2741` |
| chip stripe `list` | `--ws-level-list` | `oklch(0.74 0.09 235)` |
| chip stripe `item` | `--ws-level-item` | `var(--ws-accent)` |
| chip stripe `field` | `--ws-level-field` | `oklch(0.76 0.11 340)` |
| chip stripe `page` | `--ws-level-page` | `var(--ws-neutral-500)` |
| chip dot `stable` | `--ws-stab-stable` | `oklch(0.78 0.13 155)` |
| chip dot `medium` | `--ws-stab-medium` | `oklch(0.82 0.13 80)` |
| chip dot `fragile` | `--ws-stab-fragile` | `oklch(0.68 0.17 25)` |
| chip strategy tag background | `--ws-tag-bg` | `color-mix(in srgb, var(--ws-neutral-800) 55%, transparent)` |
| chip body | `--ws-chip-bg` | `color-mix(in srgb, var(--ws-surface) 70%, var(--ws-bg))` |
| section divider `linear-gradient(90deg, transparent, neutral-800 48px, …)` | `--ws-divider` | same gradient over `--ws-neutral-800` |
| invalid input border `oklch(0.62 0.15 25)` | `--ws-invalid` | `oklch(0.62 0.15 25)` |
| `--space-*`, `--radius-*` | `--ws-s1`…`--ws-s6`, `--ws-r-sm`, `--ws-r-md`, `--ws-r-lg` | unchanged |

`--ws-accent-300` was `#b5abfc` (Nocturne `accent-400`) before this change; it now follows Nocturne and `#b5abfc` is `--ws-accent-400`.
