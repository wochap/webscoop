import type { ProtocolCandidate } from '@webscoop/core/page';

/** Separator between the levels of a composed selector chain. */
export const CHAIN_SEPARATOR = ' » ';

/** One level of a composed selector chain: its primary selector as `strategy=value`. */
export interface ChainLevel {
  /** What the level is, such as `list parent`; shown as the chip's tooltip. */
  label?: string;
  value: string;
}

/**
 * The levels of a composed selector chain, outermost first (list parent,
 * item container, field), each with the label at the same index. Levels that
 * are not set are left out. Display only: the recipe keeps one scoped
 * selector list per level.
 */
export function chainLevels(levels: readonly (ProtocolCandidate | null | undefined)[], labels: readonly string[] = []): ChainLevel[] {
  const out: ChainLevel[] = [];
  for (const [i, c] of levels.entries()) {
    if (!c) continue;
    const label = labels[i];
    out.push({ ...(label ? { label } : {}), value: `${c.strategy}=${c.value}` });
  }
  return out;
}

/** Labels of the list parent, item container, and field levels, in chain order. */
export const CHAIN_LABELS = ['list parent', 'item', 'field'] as const;

/** The composed selector chain as one string, joined by `»`, for titles and tests. */
export function selectorChain(levels: readonly (ProtocolCandidate | null | undefined)[]): string {
  return chainLevels(levels)
    .map((l) => l.value)
    .join(CHAIN_SEPARATOR);
}
