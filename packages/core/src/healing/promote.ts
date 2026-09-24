import type { ElementRef, SerializedElement } from '../ports';
import type { Fingerprint, SelectorCandidate } from '../recipe/schema';
import { descendantsOf, type AnnotatedNode } from '../selectors/annotated';
import { fingerprint } from '../selectors/fingerprint';
import { compoundOf, generate, type Candidate } from '../selectors/generate';
import { rank } from '../selectors/rank';
import { relativize } from '../selectors/relativize';
import { refForNode, xpathFor } from '../selectors/xpath';
import { ancestorTokens } from './score';
import type { HealContext, HealOutcome, HealTarget, Resolution } from './types';

/** A target's new selectors and fingerprint after it healed. */
export interface Promotion {
  target: HealTarget;
  outcome: HealOutcome;
  oldPrimary: SelectorCandidate;
  newPrimary: SelectorCandidate;
  selectors: SelectorCandidate[];
  fingerprint?: Fingerprint;
  /** Item containers the new primary resolves in, for item scoped fields. */
  coverage?: number;
}

const key = (c: SelectorCandidate) => `${c.strategy}=${c.value}`;
const bare = (c: SelectorCandidate): SelectorCandidate => ({ strategy: c.strategy, value: c.value, stability: c.stability });

function dedupe(list: readonly SelectorCandidate[]): SelectorCandidate[] {
  const seen = new Set<string>();
  return list.filter((c) => !seen.has(key(c)) && seen.add(key(c)));
}

async function resolves(ctx: HealContext, c: SelectorCandidate, within?: ElementRef): Promise<ElementRef[]> {
  try {
    return await ctx.session.resolve(c, within);
  } catch {
    return [];
  }
}

/** Item containers a candidate resolves in. */
async function coverageOf(ctx: HealContext, c: SelectorCandidate): Promise<number> {
  let hits = 0;
  for (const container of ctx.containers ?? []) if ((await resolves(ctx, c, container)).length > 0) hits++;
  return hits;
}

/**
 * Find the snapshot node for a live element: same tag and attributes, then
 * confirmed through its positional XPath.
 */
export async function locateNode(ctx: HealContext, ref: ElementRef, within?: ElementRef): Promise<AnnotatedNode | null> {
  const [root, self] = await Promise.all([ctx.snapshotOf(within), ctx.session.snapshot(ref)]);
  if (self.type !== 'element') return null;
  const wanted = self as SerializedElement;
  const sameAttrs = (n: AnnotatedNode) => {
    const a = Object.keys(n.attrs);
    return a.length === Object.keys(wanted.attrs).length && a.every((k) => n.attrs[k] === wanted.attrs[k]);
  };
  for (const node of descendantsOf(root)) {
    if (node.tag !== wanted.tag || !sameAttrs(node)) continue;
    const found = await refForNode(ctx.session, node, within);
    if (found && (await ctx.session.same(found, ref))) return node;
  }
  return null;
}

/**
 * Fresh selectors for the element a rung found: generated candidates that
 * resolve that element in the scope, ranked; the resolving selector first,
 * then old candidates that still resolve, then the positional XPath. The
 * fingerprint is refreshed from the live element. Rungs that pick their own
 * selectors (a user re-pick) keep them.
 */
export async function promote(target: HealTarget, resolution: Resolution, ctx: HealContext): Promise<Promotion> {
  const within = resolution.within ?? ctx.within;
  const found = resolution.refs[0]!;
  const itemScoped = target.kind === 'field' && target.scope === 'item';
  const containers = ctx.containers ?? [];
  const oldPrimary = target.selectors[0]!;
  const resolvingIndex = resolution.outcome.kind === 'candidate' ? resolution.outcome.index : -1;

  const oldAlive: SelectorCandidate[] = [];
  for (const [i, c] of target.selectors.entries()) {
    if (i === resolvingIndex) continue;
    if ((await resolves(ctx, c, within)).length > 0) oldAlive.push(c);
  }

  const finish = async (selectors: SelectorCandidate[], fp: Fingerprint | undefined): Promise<Promotion> => {
    const list = dedupe(selectors.map(bare));
    const coverage = itemScoped && list[0] ? await coverageOf(ctx, list[0]) : undefined;
    return {
      target,
      outcome: resolution.outcome,
      oldPrimary,
      newPrimary: list[0]!,
      selectors: list,
      ...(fp ? { fingerprint: fp } : {}),
      ...(coverage !== undefined ? { coverage } : {}),
    };
  };

  if (resolution.selectors && resolution.selectors.length > 0) {
    return finish([...resolution.selectors, ...oldAlive], resolution.fingerprint ?? target.fingerprint);
  }

  const node = resolution.node ?? (await locateNode(ctx, found, within));
  const resolving = resolvingIndex >= 0 ? [target.selectors[resolvingIndex]!] : [];
  if (!node) return finish([...resolving, resolution.selector, ...oldAlive], target.fingerprint);

  const root = await ctx.snapshotOf(within);
  let fresh: Candidate[] = generate(node, { positional: target.kind !== 'item' });
  if (itemScoped) fresh = fresh.map((c) => relativize(c, compoundOf(root))).filter((c): c is Candidate => c !== null);

  const verified: Candidate[] = [];
  for (const c of fresh) {
    const refs = await resolves(ctx, c, within);
    if (refs.length === 0) continue;
    if (target.kind === 'item') {
      let hit = false;
      for (const r of refs) if ((hit = await ctx.session.same(r, found))) break;
      if (hit) verified.push({ ...c, count: refs.length });
    } else if (await ctx.session.same(refs[0]!, found)) {
      verified.push({ ...c, count: itemScoped ? await coverageOf(ctx, c) : refs.length });
    }
  }
  let ranked: Candidate[];
  if (target.kind === 'item') {
    // A container selector must match every item, not just the one found.
    const most = Math.max(0, ...verified.map((c) => c.count ?? 0));
    ranked = rank(verified.filter((c) => c.count === most));
  } else {
    ranked = rank(verified, itemScoped ? { itemCount: containers.length } : {});
  }

  const positional: SelectorCandidate[] = target.kind === 'item' ? [] : [{ strategy: 'xpath', value: xpathFor(node), stability: 'fragile' }];
  const selectors = [...resolving, ...ranked, ...oldAlive, ...positional];
  if (selectors.length === 0) selectors.push(resolution.selector);

  const fp: Fingerprint = { ...fingerprint(node), ancestors: ancestorTokens(node, ctx.outerAncestors) };
  return finish(selectors, fp);
}
