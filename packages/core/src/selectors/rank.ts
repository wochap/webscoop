import { STABILITY_ORDER, STRATEGY_ORDER, type Candidate } from './generate';

export interface RankOptions {
  /** When the candidate should match one element per item: the item count to match. */
  itemCount?: number;
}

/**
 * Order candidates: ones that match something first, then hits and
 * unverified ones before misses, then (for item scoped fields) ones whose
 * count equals the item count, then by stability, then by
 * strategy order, then unique matches before non-unique ones. Stable for ties.
 */
export function rank<T extends Candidate>(candidates: readonly T[], opts: RankOptions = {}): T[] {
  const keys = (c: T): number[] => {
    const known = c.count !== undefined;
    return [
      known && c.count === 0 ? 1 : 0,
      c.hit === false ? 1 : 0,
      opts.itemCount !== undefined && known ? (c.count === opts.itemCount ? 0 : 1) : 0,
      STABILITY_ORDER.indexOf(c.stability),
      STRATEGY_ORDER.indexOf(c.strategy),
      known ? (c.count === 1 ? 0 : 1) : 0,
    ];
  };
  return candidates
    .map((candidate, index) => ({ candidate, index, keys: keys(candidate) }))
    .sort((a, b) => {
      for (let i = 0; i < a.keys.length; i++) {
        const diff = a.keys[i]! - b.keys[i]!;
        if (diff !== 0) return diff;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.candidate);
}
