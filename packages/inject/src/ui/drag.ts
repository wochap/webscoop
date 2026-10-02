import { useState, type DragEvent } from 'react';

/** Drag axis: `y` for vertical lists, `x` for the tab bar. */
export type DragAxis = 'x' | 'y';

/** A row in a drag list: its container (for nested lists such as the paginate block) and index. */
export interface DragRow {
  container: string;
  index: number;
}

/** A gap in a container: `index` is the row the gap sits before (or the row count for the end). */
export type DragSlot = DragRow;

/** The gap a cursor over row `index` points at: before it in its first half, else after it. */
export function slotFor(index: number, rect: { left: number; top: number; width: number; height: number }, clientPos: number, axis: DragAxis): number {
  const start = axis === 'x' ? rect.left : rect.top;
  const size = axis === 'x' ? rect.width : rect.height;
  return size > 0 && clientPos > start + size / 2 ? index + 1 : index;
}

/** A gap directly before or after the dragged row leaves the order unchanged. */
export function isNoop(from: number, slot: number): boolean {
  return slot === from || slot === from + 1;
}

/** Where a row dropped into gap `slot` lands, as a remove-then-insert target index. */
export function dropIndex(from: number, slot: number): number {
  return from < slot ? slot - 1 : slot;
}

/** The drag in progress, shared by every list so a row can reject rows of another list during `dragover`. */
let active: { list: string; from: DragRow } | null = null;

const sameRow = (a: DragRow, b: DragRow) => a.container === b.container && a.index === b.index;

/** The state a row renders: dimmed while dragged, and a line on its first or last edge. */
export interface DragRowState {
  dragging: boolean;
  lineBefore: boolean;
  lineAfter: boolean;
}

/**
 * Shared native drag and drop for a reorderable list. `onMove` gets the
 * dragged row and the target gap, never a no-op gap; `accepts` can reject
 * gaps (such as the paginate block's own inner gaps while it is dragged).
 * `getImage` picks the drag image element from the row, by default the row.
 */
export function useDragList({
  list,
  axis,
  onMove,
  accepts,
  getImage,
}: {
  list: string;
  axis: DragAxis;
  onMove: (from: DragRow, slot: DragSlot) => void;
  accepts?: (from: DragRow, slot: DragSlot) => boolean;
  getImage?: (row: HTMLElement) => HTMLElement | null;
}) {
  const [dragging, setDragging] = useState<DragRow | null>(null);
  // The hovered row (or slot element) and the gap the line shows.
  const [hover, setHover] = useState<{ row: DragRow; slot: DragSlot } | null>(null);

  const clear = () => {
    if (active?.list === list) active = null;
    setDragging(null);
    setHover(null);
  };

  /** The dragged row of this list, or null for no drag, a drag of another list, or a stale one. */
  const source = (): DragRow | null => (active?.list === list && dragging ? active.from : null);

  const target = (from: DragRow, slot: DragSlot) => !(from.container === slot.container && isNoop(from.index, slot.index)) && (accepts?.(from, slot) ?? true);

  const over = (e: DragEvent<HTMLElement>, row: DragRow, slot: DragSlot) => {
    const from = source();
    if (!from) return;
    // Accept the drop even on a no-op gap, so Chromium shows the move cursor and the drop ends cleanly.
    e.preventDefault();
    e.stopPropagation();
    const next = target(from, slot) ? { row, slot } : null;
    if (next?.row.container !== hover?.row.container || next?.row.index !== hover?.row.index || next?.slot.index !== hover?.slot.index || next?.slot.container !== hover?.slot.container) setHover(next);
  };

  const drop = (e: DragEvent<HTMLElement>, slot: DragSlot) => {
    const from = source();
    if (!from) return;
    e.preventDefault();
    e.stopPropagation();
    clear();
    if (target(from, slot)) onMove(from, slot);
  };

  const rowSlot = (e: DragEvent<HTMLElement>, row: DragRow): DragSlot => ({
    container: row.container,
    index: slotFor(row.index, e.currentTarget.getBoundingClientRect(), axis === 'x' ? e.clientX : e.clientY, axis),
  });

  /** Props and state for row `index` of `container`. */
  const row = (index: number, container = '') => {
    const at = { container, index };
    const hovered = hover !== null && sameRow(hover.row, at);
    const state: DragRowState = {
      dragging: dragging !== null && sameRow(dragging, at),
      lineBefore: hovered && hover.slot.index === index,
      lineAfter: hovered && hover.slot.index === index + 1,
    };
    const props = {
      onDragStart: (e: DragEvent<HTMLElement>) => {
        e.stopPropagation();
        active = { list, from: at };
        setDragging(at);
        setHover(null);
        const dt = e.dataTransfer;
        dt?.setData('text/plain', `${container}:${index}`);
        if (dt && typeof dt.setDragImage === 'function') {
          const el = getImage?.(e.currentTarget) ?? e.currentTarget;
          const rect = el.getBoundingClientRect();
          dt.setDragImage(el, e.clientX - rect.left, e.clientY - rect.top);
        }
      },
      onDragOver: (e: DragEvent<HTMLElement>) => over(e, at, rowSlot(e, at)),
      onDrop: (e: DragEvent<HTMLElement>) => drop(e, rowSlot(e, at)),
      onDragEnd: clear,
    };
    return { props, state };
  };

  /** Props and line state for a fixed gap element, such as an empty container's single gap. */
  const slot = (index: number, container = '') => {
    const at = { container, index };
    return {
      props: {
        onDragOver: (e: DragEvent<HTMLElement>) => over(e, at, at),
        onDrop: (e: DragEvent<HTMLElement>) => drop(e, at),
      },
      line: hover !== null && sameRow(hover.row, at) && sameRow(hover.slot, at),
    };
  };

  /** Props for the list container: leaving it clears the line. */
  const containerProps = {
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      const to = e.relatedTarget as Node | null;
      if (!to || !e.currentTarget.contains(to)) setHover(null);
    },
  };

  return { row, slot, containerProps };
}

/** The row's own header (`.ws-row` child), the drag image for fields, steps, and blocks. */
export const rowHeader = (row: HTMLElement): HTMLElement | null => row.querySelector<HTMLElement>(':scope > .ws-row');

/** Class names for a vertical row's drop line. */
export const lineClass = (s: DragRowState) => `${s.lineBefore ? ' ws-drop-before' : ''}${s.lineAfter ? ' ws-drop-after' : ''}`;
