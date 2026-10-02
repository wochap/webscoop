# Proposal

## Why

Dragging rows in the recorder sidebar gives poor feedback. In the Sequence section the drag image lags far behind the cursor, and no vertical list shows where a row will land. The table tab bar has a drop line, but the line never shows before the first tab or after the last tab because the scrolling tab strip clips it.

## What Changes

- Every reorderable sidebar list (fields, flow steps, Sequence blocks) shows a horizontal accent-colored drop line in the gap where the dragged row will land. The table tab bar keeps its vertical line.
- The drop target becomes a gap between rows, chosen by the cursor's position relative to the hovered row's midpoint. Dropping moves the row into that gap. Fields and steps today move to the hovered row's index; they now follow the line.
- No line shows for a gap that would leave the order unchanged (directly before or after the dragged row).
- The drag image is a copy of the dragged row (for the paginate block, only its header row), anchored at the point where the user grabbed it, so it stays under the cursor from the start of the drag. The source row is dimmed while dragging.
- Sequence blocks support gaps at the top level and inside the paginate block, including an empty paginate block. The paginate block shows no line inside itself while it is the dragged block.
- The tab drop line shows before the first tab and after the last tab.
- Drag handling stays on native HTML5 drag and drop and is shared by all four lists.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `recorder`: adds a requirement for drag feedback in sidebar lists (drag image under the cursor, drop line in the target gap, gap-based drop).

## Impact

- `packages/inject/src/ui/fields.tsx`, `flows.tsx`, `tables.tsx`, `sequence.tsx`: drag handlers replaced by a shared hook.
- New shared drag helper in `packages/inject/src/ui/` (slot computation, drag image, state).
- `packages/inject/src/styles.css`: drop line styles; tab line moved inside the tab box.
- `packages/inject/test/*`: unit tests for slot computation and drops. No e2e tests for drag.
- No protocol or core changes: `draft.moveField`, the step move, `draft.moveTable`, and `sequence.move` keep their messages.
