import type { SelectorCandidate, Stability, Strategy } from '../recipe/schema';
import { siblingsOf, type AnnotatedNode } from './annotated';
import { normalize } from './aria';
import { classifyToken, isStableId, stableClasses } from './tokens';

/** A selector candidate, optionally with its live match count as verified by the host. */
export interface Candidate extends SelectorCandidate {
  count?: number;
}

export interface GenerateContext {
  /** Longest text or accessible name used in a `text` or `role` candidate. Default 80. */
  maxTextLength?: number;
  /**
   * Leave out `:nth-child` in CSS candidates, so the selector matches the
   * element and every sibling like it. Used for item containers. Default true.
   */
  positional?: boolean;
}

const NO_ROLE = new Set(['presentation', 'none', 'generic']);

/** Test hook attributes other than `data-testid`, which has its own strategy. */
export const TEST_ATTRS = ['data-qa', 'data-test', 'data-test-id', 'data-cy'] as const;

/** `[data-qa="price"]` for the element's first readable test hook attribute, else empty. */
export function testAttrOf(node: AnnotatedNode): string {
  for (const name of TEST_ATTRS) {
    const value = node.attrs[name];
    if (value && /^[\w-]+$/.test(value) && classifyToken(value) === 'stable') return `[${name}="${value}"]`;
  }
  return '';
}

/** `tag.stable-class...[test-attr]` for one element. */
export function compoundOf(node: AnnotatedNode): string {
  return node.tag + stableClasses(node).map((c) => `.${c}`).join('') + testAttrOf(node);
}

/** The element's compound, plus `:nth-child` when a sibling shares the same compound. */
function segmentOf(node: AnnotatedNode, positional = true): { text: string; positional: boolean } {
  const base = compoundOf(node);
  if (!positional) return { text: base, positional: false };
  const siblings = siblingsOf(node);
  const ambiguous = siblings.some((s) => s !== node && compoundOf(s) === base);
  if (!ambiguous) return { text: base, positional: false };
  return { text: `${base}:nth-child(${siblings.indexOf(node) + 1})`, positional: true };
}

const TOP = new Set(['html', 'body']);

/**
 * Shortest path of tags, stable classes, and test hook attributes: the
 * element's own compound when it has a stable class or test hook, else
 * walking up to the nearest ancestor that has one (or to the child of `body`).
 */
function cssCandidate(node: AnnotatedNode, positional: boolean): Candidate {
  const first = segmentOf(node, positional);
  const segments = [first];
  const anchored = (n: AnnotatedNode) => stableClasses(n).length > 0 || testAttrOf(n) !== '';
  if (!anchored(node) && !TOP.has(node.tag)) {
    for (let cur = node.parent; cur && !TOP.has(cur.tag); cur = cur.parent) {
      segments.unshift(segmentOf(cur, positional));
      if (anchored(cur)) break;
    }
  }
  const usesPosition = segments.some((s) => s.positional);
  return {
    strategy: 'css',
    value: segments.map((s) => s.text).join(' > '),
    stability: usesPosition ? 'fragile' : 'medium',
  };
}

function xpathLiteral(value: string): string | null {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return null;
}

/** Positional step for one element: `tag[k]` among same-tag siblings. */
function xpathStep(node: AnnotatedNode): string {
  const sameTag = siblingsOf(node).filter((s) => s.tag === node.tag);
  return `${node.tag}[${sameTag.indexOf(node) + 1}]`;
}

/** Positional path from the nearest ancestor with an `id` or `data-testid`, else from the root. */
function xpathCandidate(node: AnnotatedNode): Candidate {
  const steps: string[] = [xpathStep(node)];
  for (let cur = node.parent; cur; cur = cur.parent) {
    for (const attr of ['id', 'data-testid'] as const) {
      const value = cur.attrs[attr];
      const literal = value ? xpathLiteral(value) : null;
      if (literal) {
        return { strategy: 'xpath', value: `//${cur.tag}[@${attr}=${literal}]/${steps.join('/')}`, stability: 'fragile' };
      }
    }
    steps.unshift(cur.parent ? xpathStep(cur) : `${cur.tag}[1]`);
  }
  return { strategy: 'xpath', value: `/${steps.join('/')}`, stability: 'fragile' };
}

/** Text of an element whose only child is a single text node. */
export function ownText(node: AnnotatedNode): string | null {
  if (node.children.length !== 1) return null;
  const [child] = node.children;
  if (child?.type !== 'text') return null;
  const text = normalize(child.text);
  return text || null;
}

/**
 * Candidates for one element, at most one per strategy, in strategy order.
 * Strategies that do not apply are omitted.
 */
export function generate(node: AnnotatedNode, ctx: GenerateContext = {}): Candidate[] {
  const max = ctx.maxTextLength ?? 80;
  const out: Candidate[] = [];
  if (node.role && !NO_ROLE.has(node.role) && node.name && node.name.length <= max) {
    out.push({ strategy: 'role', value: `${node.role}|${node.name}`, stability: 'stable' });
  }
  const testid = node.attrs['data-testid'];
  if (testid) out.push({ strategy: 'testid', value: testid, stability: 'stable' });
  const id = node.attrs.id;
  if (id) out.push({ strategy: 'id', value: id, stability: isStableId(id) ? 'stable' : 'fragile' });
  const text = ownText(node);
  if (text && text.length <= max) out.push({ strategy: 'text', value: text, stability: 'fragile' });
  out.push(cssCandidate(node, ctx.positional ?? true));
  out.push(xpathCandidate(node));
  return out;
}

/** Whether an attribute value looks machine generated, for the inspector. */
export function attrStability(name: string, value: string): 'stable' | 'hashed' {
  if (name === 'class') return value.split(/\s+/).filter(Boolean).every((t) => classifyToken(t) === 'stable') ? 'stable' : 'hashed';
  if (name === 'id') return isStableId(value) ? 'stable' : 'hashed';
  return classifyToken(value) === 'stable' ? 'stable' : 'hashed';
}

export const STABILITY_ORDER: readonly Stability[] = ['stable', 'medium', 'fragile'];
export const STRATEGY_ORDER: readonly Strategy[] = ['role', 'testid', 'id', 'text', 'css', 'xpath'];

