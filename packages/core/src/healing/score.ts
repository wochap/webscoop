import type { Fingerprint } from '../recipe/schema';
import { ancestorsOf, type AnnotatedNode, type BBox } from '../selectors/annotated';
import { normalize, textContent } from '../selectors/aria';
import { stableAttrs } from '../selectors/fingerprint';

/** Component weights of the fingerprint similarity score; they sum to 1. */
export const SCORE_WEIGHTS = {
  tag: 0.15,
  role: 0.15,
  name: 0.15,
  text: 0.2,
  attrs: 0.15,
  ancestors: 0.1,
  bbox: 0.1,
} as const;

export type ScorePart = keyof typeof SCORE_WEIGHTS;

/** Each weighted component, and their sum. */
export type ScoreParts = Record<ScorePart, number> & { total: number };

export interface Viewport {
  w: number;
  h: number;
}

export const DEFAULT_VIEWPORT: Viewport = { w: 1280, h: 800 };

/** Strings longer than this are cut before the edit distance. */
export const MAX_COMPARE = 200;

/** Levenshtein distance over sequences, both cut to `MAX_COMPARE` items. */
export function editDistance<T>(a: ArrayLike<T>, b: ArrayLike<T>): number {
  const n = Math.min(a.length, MAX_COMPARE);
  const m = Math.min(b.length, MAX_COMPARE);
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  let cur = new Array<number>(m + 1);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m]!;
}

/** 1 minus the normalized edit distance of two sequences. */
export function sequenceSimilarity<T>(a: ArrayLike<T>, b: ArrayLike<T>): number {
  const longest = Math.max(Math.min(a.length, MAX_COMPARE), Math.min(b.length, MAX_COMPARE));
  return longest === 0 ? 1 : 1 - editDistance(a, b) / longest;
}

/** Similarity of two strings after trimming, collapsing whitespace, and case folding. */
export function textSimilarity(a: string, b: string): number {
  return sequenceSimilarity(normalize(a).toLowerCase(), normalize(b).toLowerCase());
}

/** Absent on both sides counts as a match, absent on one side as a miss. */
function presence<T>(a: T | undefined, b: T | undefined, weight: number, compare: (a: T, b: T) => number): number {
  if (a === undefined && b === undefined) return weight;
  if (a === undefined || b === undefined) return 0;
  return weight * compare(a, b);
}

const orUndefined = (s: string | undefined) => (s === undefined || normalize(s) === '' ? undefined : s);
const boxOrUndefined = (b: BBox | undefined) => (!b || (b.w === 0 && b.h === 0) ? undefined : b);

function pairs(attrs: Record<string, string>): Set<string> {
  return new Set(Object.entries(attrs).map(([k, v]) => `${k}=${v}`));
}

function attrOverlap(a: Record<string, string>, b: Record<string, string>): number {
  const x = pairs(a);
  const y = pairs(b);
  let shared = 0;
  for (const p of x) if (y.has(p)) shared++;
  return shared / (x.size + y.size - shared);
}

function proximity(a: BBox, b: BBox, viewport: Viewport): number {
  const dx = a.x + a.w / 2 - (b.x + b.w / 2);
  const dy = a.y + a.h / 2 - (b.y + b.h / 2);
  const diagonal = Math.hypot(viewport.w, viewport.h) || 1;
  return Math.max(0, 1 - Math.hypot(dx, dy) / diagonal);
}

export interface ScoreOptions {
  viewport?: Viewport;
  /**
   * Ancestor tokens above the root of the tree the node lives in, nearest
   * first. Used when the node comes from a subtree snapshot, such as one item
   * container, so its ancestor chain still reaches the document root.
   */
  outerAncestors?: readonly string[];
}

/** Ancestor tokens (role, else tag) of a node, nearest first, at most `max` (6, like a fingerprint). */
export function ancestorTokens(node: AnnotatedNode, outer: readonly string[] = [], max = 6): string[] {
  return [...ancestorsOf(node).map((a) => a.role ?? a.tag), ...outer].slice(0, max);
}

/** Wrapper elements a page may add around a field without the ancestor chain counting as different. */
export const MAX_INSERTED_WRAPPERS = 3;

/**
 * Similarity of a stored ancestor chain (cut at 6) with a live one. The live
 * chain is cut at the stored length plus up to `MAX_INSERTED_WRAPPERS`, and
 * the best cut counts, so added wrappers cost a little and do not also push
 * the shared ancestors out of the window.
 */
export function ancestorSimilarity(stored: readonly string[], live: readonly string[]): number {
  let best = 0;
  for (let extra = 0; extra <= MAX_INSERTED_WRAPPERS; extra++) {
    best = Math.max(best, sequenceSimilarity(stored, live.slice(0, stored.length + extra)));
    if (stored.length + extra >= live.length) break;
  }
  return best;
}

/** Each weighted component of the similarity between a stored fingerprint and a live node. */
export function scoreParts(fp: Fingerprint, node: AnnotatedNode, opts: ScoreOptions = {}): ScoreParts {
  const w = SCORE_WEIGHTS;
  const viewport = opts.viewport ?? DEFAULT_VIEWPORT;
  const liveText = normalize(textContent(node)).slice(0, 80);
  const liveAncestors = ancestorTokens(node, opts.outerAncestors, 6 + MAX_INSERTED_WRAPPERS);
  const liveAttrs = stableAttrs(node);
  const emptyToUndefined = (a: Record<string, string>) => (Object.keys(a).length === 0 ? undefined : a);
  const emptyList = (a: readonly string[]) => (a.length === 0 ? undefined : a);
  const parts: Record<ScorePart, number> = {
    tag: fp.tag === node.tag ? w.tag : 0,
    role: presence(orUndefined(fp.role), orUndefined(node.role), w.role, (a, b) => (a === b ? 1 : 0)),
    name: presence(orUndefined(fp.name), orUndefined(node.name), w.name, textSimilarity),
    text: presence(orUndefined(fp.textSample), orUndefined(liveText), w.text, textSimilarity),
    attrs: presence(emptyToUndefined(fp.attrs), emptyToUndefined(liveAttrs), w.attrs, attrOverlap),
    ancestors: presence(emptyList(fp.ancestors), emptyList(liveAncestors), w.ancestors, ancestorSimilarity),
    bbox: presence(boxOrUndefined(fp.bbox), boxOrUndefined(node.bbox), w.bbox, (a, b) => proximity(a, b, viewport)),
  };
  const total = Object.values(parts).reduce((sum, v) => sum + v, 0);
  return { ...parts, total: Math.round(total * 10_000) / 10_000 };
}

/** Similarity between a stored fingerprint and a live node, from 0 to 1. */
export function scoreFingerprint(fp: Fingerprint, node: AnnotatedNode, opts: ScoreOptions = {}): number {
  return scoreParts(fp, node, opts).total;
}
