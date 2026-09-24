import { descendantsOf, type AnnotatedNode } from '../selectors/annotated';
import { refForNode, xpathFor } from '../selectors/xpath';
import { scoreFingerprint } from './score';
import type { HealContext, HealTarget, Resolution, Resolver } from './types';

/** The best match must beat the runner-up by at least this much. */
export const FUZZY_MARGIN = 0.05;

export interface FuzzyMatch {
  node: AnnotatedNode;
  score: number;
}

/**
 * Score every element in the tree whose tag or role equals the fingerprint's,
 * best first. The root itself is left out when it is an item container.
 */
export function rankMatches(target: HealTarget, root: AnnotatedNode, ctx: Pick<HealContext, 'outerAncestors' | 'viewport'>, includeRoot: boolean): FuzzyMatch[] {
  const fp = target.fingerprint;
  if (!fp) return [];
  const pool = descendantsOf(root).filter((n) => (includeRoot || n !== root) && (n.tag === fp.tag || (fp.role !== undefined && n.role === fp.role)));
  const opts = { outerAncestors: ctx.outerAncestors, ...(ctx.viewport ? { viewport: ctx.viewport } : {}) };
  return pool.map((node) => ({ node, score: scoreFingerprint(fp, node, opts) })).sort((a, b) => b.score - a.score);
}

/** Accept the best match when it clears the threshold and the margin over the runner-up. */
export function pickMatch(matches: readonly FuzzyMatch[], threshold: number): FuzzyMatch | null {
  const [best, second] = matches;
  if (!best || best.score < threshold) return null;
  if (second && best.score - second.score < FUZZY_MARGIN - 1e-9) return null;
  return best;
}

/** Rung 2: find the element whose fingerprint best matches the stored one, from a snapshot of the scope. */
export const fuzzyResolver: Resolver = {
  name: 'fuzzy',
  async resolve(target, ctx): Promise<Resolution | null> {
    if (!target.fingerprint) return null;
    const within = ctx.probe ? ((await ctx.probe()) ?? ctx.within) : ctx.within;
    const root = await ctx.snapshotOf(within);
    const best = pickMatch(rankMatches(target, root, ctx, !within), ctx.threshold);
    if (!best) return null;
    const ref = await refForNode(ctx.session, best.node, within);
    if (!ref) return null;
    return {
      refs: [ref],
      outcome: { kind: 'fuzzy', score: best.score },
      selector: { strategy: 'xpath', value: xpathFor(best.node), stability: 'fragile' },
      ...(within ? { within } : {}),
      node: best.node,
    };
  },
};
