# Tasks

## 1. Shared drag helper

- [x] 1.1 Create `packages/inject/src/ui/drag.ts` with pure `slotFor(index, rect, clientPos, axis)`, `isNoop(from, slot)`, and `dropIndex(from, slot)`, the last moved from `tables.tsx`; re-export `dropIndex` or update its imports. Verify with new unit tests in `packages/inject/test/drag.test.ts` covering top/bottom and left/right halves, both no-op slots, and `dropIndex` both directions.
- [x] 1.2 Add the module-level active drag (`{ list, from }`), set on `dragstart` and cleared on `dragend` and `drop`, and cleared again on the next `dragstart`. Add the `useDragList({ list, axis, onMove })` hook that returns row props and row state (`dragging`, `lineBefore`, `lineAfter`), plus container props that clear the slot when `dragleave`'s `relatedTarget` is outside the container. Rows of another list do not call `preventDefault` and show no line. Verify with unit tests in `drag.test.ts`: render a small list, dispatch `dragStart` / `dragOver` (mocked `getBoundingClientRect`, `clientY`) / `drop`, and assert `onMove` arguments, line state, and that a foreign drag shows no line.
- [ ] 1.3 In `dragstart`, call `dataTransfer.setDragImage(header, clientX - rect.left, clientY - rect.top)` with the row's header element (a `getImage` option, defaulting to the row), guarded for jsdom where `setDragImage` is missing. Check by hand in the real recorder panel (`webscoop record` on the playground) with the sidebar scrolled to the Sequence section. If the image still lags, use the design's fallback: a clone in a fixed holder at the top of `#ws-root`, removed on the next frame. Verify by hand: the image sits under the cursor from the first movement in the fields, steps, and Sequence lists.

## 2. Styles

- [x] 2.1 In `packages/inject/src/styles.css`, add `.ws-drop-before::before` / `.ws-drop-after::after` (absolute, `left: 0; right: 0; height: 2px; top: 0` / `bottom: 0`, `background: var(--ws-accent-400)`, `border-radius: 1px`, `pointer-events: none`), and `position: relative` on `.ws-field` and `.ws-block` if missing. Add dimming for a dragged block, matching `.ws-field-dragging`. Verify `npm run build` (or the repo's inject build) passes and the line is visible on the first and last rows by hand.
- [x] 2.2 Move the tab bar line inside the tab: `.ws-tab-drop::before` at `left: 0`, `.ws-tab-drop-end::before` at `right: 0; left: auto`. Verify by hand that the line shows before the first tab and after the last tab while the strip scrolls.

## 3. Wire the lists

- [x] 3.1 Fields (`fields.tsx`): replace the hand-wired `dragProps` with `useDragList` (list id per table, axis `y`, header `.ws-row`). `onMove` sends `draft.moveField { from, to: dropIndex(from, slot) }` and focuses the new index. Update `fields.test.tsx` drag case: dragging `url` over the top half of `title` sends `{ from: 2, to: 0 }`, and dragging `title` over the bottom half of `price` sends `{ from: 0, to: 1 }` with the line on `price`'s bottom edge. Verify the test passes.
- [x] 3.2 Steps (`flows.tsx`): same as fields, with list id `steps:<flow index>` and `draft.moveStep`. Add a `flows.test.tsx` drag case with a line, plus a case where a step dragged from another flow shows no line and sends nothing. Verify the tests pass.
- [x] 3.3 Tabs (`tables.tsx`): replace the tab drag handlers with `useDragList` (axis `x`, image = the tab button). Keep `+` out of the drop targets, and keep drag disabled while locked. Keep the `ws-tab-drop` / `ws-tab-drop-end` classes, driven by the hook state, and hide them for no-op slots. Update `tables.test.tsx`: the existing drag case still passes, a new case drags `results` over the right half of `ads` and sends `moveTable { from: 0, to: 2 }` with `ws-tab-drop-end` on `ads`, and a no-op hover shows no line. Verify the tests pass.
- [x] 3.4 Sequence (`sequence.tsx`): use `useDragList` with list id `sequence` and slots `{ container: 'top' | 'do', index }`. Compute `to` per the design: same container uses `dropIndex`, across containers uses `slot`, and inner paths are `[paginateIndex, slot]`. The drag image is the block's `.ws-row`. Add an empty-`do` slot element with a minimum height that shows the line for `{ do, 0 }`. Remove the container `onDrop` that appended at the end. While the paginate block is dragged, reject `do` slots. Add `sequence.test.tsx` cases:
  - a top-level block over the bottom half of the inner block sends `sequence.move { from: [0], to: [1, 1] }` for `flow`, then `paginate` with one inner block;
  - an inner block over the top half of the first top-level block sends `{ from: [1, 0], to: [0] }`;
  - a drop into an empty `do` sends `to: [p, 0]`;
  - dragging the paginate block over its inner rows shows no line.

  Verify the tests pass.

## 4. Check

- [ ] 4.1 Run the inject unit tests and the typecheck (`rtk npm test` in `packages/inject`, or the repo's test script) and verify they pass. Then check by hand in the recorder panel that all four lists show the line in the right gap, show no line next to the dragged row, and that Esc clears the line.
