/**
 * Selector level colors for the page overlay. The panel's chips use the
 * `--ws-level-*` custom properties in `styles.css`; the overlay's shadow root
 * cannot read them, so it takes these constants, which a test keeps equal.
 */
export const LEVEL_COLORS = {
  list: 'oklch(0.74 0.09 235)',
  item: '#9184d9',
  field: 'oklch(0.76 0.11 340)',
  page: '#9397ab',
} as const;

/** Outline of another list table's containers: muted grey, dashed. */
export const MUTED_OUTLINE = '#75798c';
/** The dim over the page outside the active containers while picking in a list. */
export const DIM = 'rgba(14, 15, 24, 0.28)';
/** Hover outline and tag text outside the active list. */
export const WARN = '#e6c98f';
/** Above this many containers the dim is skipped; the outlines stay. */
export const MAX_DIM_CONTAINERS = 200;
