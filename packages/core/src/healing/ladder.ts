import type { ElementRef } from '../ports';
import { fuzzyResolver } from './fuzzy';
import type { HealContext, HealTarget, Resolution, Resolver } from './types';

/** Scopes to try in order: every item container for item scoped fields, else the context's scope. */
function scopes(ctx: HealContext): (ElementRef | undefined)[] {
  return ctx.containers && ctx.containers.length > 0 ? [...ctx.containers] : [ctx.within];
}

async function tryCandidates(target: HealTarget, ctx: HealContext, limit: number): Promise<Resolution | null> {
  for (const [index, selector] of target.selectors.slice(0, limit).entries()) {
    for (const within of scopes(ctx)) {
      const refs = await ctx.session.resolve(selector, within);
      if (refs.length > 0) return { refs, outcome: { kind: 'candidate', index }, selector, ...(within ? { within } : {}) };
    }
  }
  return null;
}

/** Rung 1: the stored candidates in listed order; the first that resolves anything in the scope wins. */
export const candidatesResolver: Resolver = {
  name: 'candidates',
  resolve: (target, ctx) => tryCandidates(target, ctx, Infinity),
};

/** Rung 1 with healing disabled: the first stored candidate only. */
export const firstCandidateResolver: Resolver = {
  name: 'first-candidate',
  resolve: (target, ctx) => tryCandidates(target, ctx, 1),
};

/**
 * The default ladder. With healing on: stored candidates, fuzzy fingerprint
 * match, then any extra rungs (a model-assisted rung, a user re-pick). With
 * healing off: the first stored candidate only.
 */
export function defaultLadder(opts: { enabled: boolean; extra?: readonly Resolver[] }): Resolver[] {
  if (!opts.enabled) return [firstCandidateResolver];
  return [candidatesResolver, fuzzyResolver, ...(opts.extra ?? [])];
}

/**
 * Try each rung in order; the first that resolves at least one element wins
 * and later rungs do not run. `accept` can turn a resolution down (for
 * example a fuzzy match whose selector does not hold across item
 * containers), which moves on to the next rung.
 */
export async function resolveTarget(ladder: readonly Resolver[], target: HealTarget, ctx: HealContext): Promise<Resolution | null>;
export async function resolveTarget<T>(
  ladder: readonly Resolver[],
  target: HealTarget,
  ctx: HealContext,
  accept: (resolution: Resolution) => Promise<T | null>,
): Promise<T | null>;
export async function resolveTarget<T>(
  ladder: readonly Resolver[],
  target: HealTarget,
  ctx: HealContext,
  accept?: (resolution: Resolution) => Promise<T | null>,
): Promise<T | Resolution | null> {
  for (const rung of ladder) {
    const resolution = await rung.resolve(target, ctx);
    if (!resolution || resolution.refs.length === 0) continue;
    if (!accept) return resolution;
    const accepted = await accept(resolution);
    if (accepted !== null) return accepted;
  }
  return null;
}
