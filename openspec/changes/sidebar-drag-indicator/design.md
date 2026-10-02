# Design

## Context

The four drag lists in `packages/inject/src/ui/` (fields `fields.tsx`, steps `flows.tsx`, tabs `tables.tsx`, Sequence blocks `sequence.tsx`) each wire native HTML5 drag handlers by hand:

- Fields and steps drop onto the hovered row's index (`to: index`). They have no line, and they read the source index from `text/plain`. Because of that, a step dropped on the fields list is read as a field index.
- Tabs compute a gap from the cursor's X midpoint (`drop` state) and convert it with `dropIndex(from, before)`. The line is `.ws-tab-drop::before` at `left: -2px` / `right: -2px`. `.ws-tabs` has `overflow-x: auto`, so the strip clips the line on the first and last tab.
- Sequence blocks set no dragging state and no drag image. The default Chromium drag image of a block, and of the tall paginate block in particular, does not stay under the cursor. The panel is in a closed shadow root under `#ws-root` with `contain: layout`, inside a scrolled sidebar.
- `moveBlock` (`core/src/recorder/draft.ts`) removes the block first, then inserts it at `to` in the list after removal. A paginate block cannot move into itself.

## Goals / Non-Goals

**Goals:**
- One shared drag helper for slot math, drag image, state, and the line, used by all four lists.
- A drag image that stays under the cursor in every list.

**Non-Goals:**
- Pointer-event drag or a custom-rendered ghost. Native DnD stays.
- Auto-scrolling the sidebar while dragging near its edge.
- e2e tests for drag. Unit tests in jsdom cover slot math and drops.
- Changes to protocol messages or core move functions.

## Decisions

### Shared hook `useDragList` in `packages/inject/src/ui/drag.ts`

The hook takes:
- a list id (for example `fields:<table>`, `steps:<flow>`, `tabs`, `sequence`),
- an axis (`'y'` or `'x'`),
- an `onMove(from, slot)` callback.

It returns per-row props (`draggable`, `onDragStart`, `onDragOver`, `onDrop`, `onDragEnd`) and the row's state: dragging, and line before or line after.

A pure function `slotFor(index, rect, clientPos, axis)` returns `index` or `index + 1`. A pure function `isNoop(from, slot)` returns true for `slot === from || slot === from + 1`. Both are exported for unit tests.

Alternative: patching each list in place. Rejected, because the four lists would drift apart again, as they have now.

### Active drag kept in module state, not in `dataTransfer`

A module-level `{ list, index | path }` is set on `dragstart` and cleared on `dragend` and `drop`. `dragover` can then reject other lists synchronously: browsers hide `dataTransfer` data during `dragover`, and only the types are visible. A row ignores `dragover` (no `preventDefault`, no line) when the active drag belongs to a different list. `text/plain` is still set so that Chromium starts the drag.

### Gap semantics with existing messages

- Fields, steps and tabs send `to = dropIndex(from, slot)`. `dropIndex` moves from `tables.tsx` into `drag.ts`. `draft.moveField` and `draft.moveStep` keep their `{ from, to }` shape. Only the computed `to` changes.
- Sequence slots are `{ container: 'top' | 'do', index }`. `to` follows `moveBlock`'s remove-then-insert rule: for a move within the same container, `to = dropIndex(from, slot)`; for a move across containers, `to = slot`. Inner paths become `[paginateIndex, slot]`. When a top-level block above the paginate block moves into it, `moveBlock` already finds the paginate block again after the removal.
- An empty `paginate.do` renders a slot element with a minimum height. That element accepts `dragover` and shows the line for `{ do, 0 }`. The existing `onDrop` of the `ws-paginate-do` container, which appends at the end, is replaced by the per-row slots plus this empty slot.
- While the paginate block itself is dragged, `do` slots are rejected.

### Drag image via `setDragImage` on the row header

On `dragstart` the hook calls `e.dataTransfer.setDragImage(el, e.clientX - rect.left, e.clientY - rect.top)`. `el` is the row's header element: the `.ws-row` child for fields, steps and blocks (for the paginate block this excludes the settings and inner blocks), and the button itself for tabs. Pinning the offset to the grab point stops Chromium from choosing its own anchor.

Risk fallback: Chromium may still misplace an image taken from an element in a scrolled container inside the shadow root. In that case, clone the header into a fixed-position holder at `top: 0; left: 0` of `#ws-root` (the containing block, because of `contain: layout`), pass the clone to `setDragImage`, and remove it on the next animation frame. Task 1 settles which one to use by checking in the real panel.

### Line rendering stays inside the row box

Vertical lists use `.ws-drop-before` / `.ws-drop-after` classes that draw a `::before` / `::after` bar, absolutely positioned at `top: 0` / `bottom: 0` with `left: 0; right: 0; height: 2px; background: var(--ws-accent-400)`. Rows get `position: relative` where they lack it. Tabs keep a vertical bar but at `left: 0` / `right: 0`, inside the tab, so `.ws-tabs` cannot clip it. Only one row renders a line: the row whose slot matches. "After last" renders on the last row, and "before n" renders on row n.

Alternative: an outset bar in the 2px `gap`. Rejected, because a scroll container clips the first and last positions (the cause of the current tab bug).

### Line and state clearing

The slot clears on `dragend` and `drop`, and when the cursor leaves the list container. That check uses `dragleave` on the container, with `relatedTarget` outside the container. Per-row `dragleave` no longer clears the slot, which removes flicker over child spans. Esc fires `dragend`, which clears everything.

## Risks / Trade-offs

- [Chromium drag image misplacement inside the shadow root and scroll] → fallback clone at the top of `#ws-root`, checked by hand in task 1.
- [Fields and steps change drop semantics from "onto row" to "into gap"] → intended. The tests that assert the old index are updated.
- [jsdom has no layout] → tests mock `getBoundingClientRect` and pass `clientX` / `clientY` on `dragOver`, as `tables.test.tsx` already does.
- [The module-level active drag stays set if a `dragend` is lost (for example, the panel re-renders and the row unmounts)] → also clear it on the next `dragstart`, and ignore it once no row of that list is dragging.
