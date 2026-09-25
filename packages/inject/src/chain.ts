import type { ProtocolCandidate } from '@webscoop/core/page';

/** Separator between the levels of a composed selector chain. */
export const CHAIN_SEPARATOR = ' » ';

/**
 * The composed selector chain for display: each set level's primary
 * selector as `strategy=value`, outermost first (list parent, item
 * container, field), joined by `»`. Levels that are not set are left out.
 * Display only: the recipe keeps one scoped selector list per level.
 */
export function selectorChain(levels: readonly (ProtocolCandidate | null | undefined)[]): string {
  return levels
    .filter((c): c is ProtocolCandidate => Boolean(c))
    .map((c) => `${c.strategy}=${c.value}`)
    .join(CHAIN_SEPARATOR);
}
