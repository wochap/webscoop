import type { SelectorCandidate, Stability, Strategy } from '../recipe/schema';
import { siblingsOf, type AnnotatedNode } from './annotated';
import { normalize } from './aria';
import { classifyToken, classTokens, isStableId, stableClasses } from './tokens';

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
  /**
   * The element is generated as a list parent or item container level: a
   * `role` candidate carries the role alone, without an accessible name.
   */
  level?: boolean;
}

/**
 * The element each segment (CSS compound or XPath step) of a generated
 * candidate stands for, top first, so `relativize` can cut at a container
 * element instead of matching selector text. Keyed by the candidate object.
 */
const SEGMENT_NODES = new WeakMap<object, AnnotatedNode[]>();

export function segmentNodesOf(candidate: object): readonly AnnotatedNode[] | undefined {
  return SEGMENT_NODES.get(candidate);
}

function withSegments<T extends object>(candidate: T, nodes: AnnotatedNode[]): T {
  SEGMENT_NODES.set(candidate, nodes);
  return candidate;
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
const anchored = (n: AnnotatedNode) => stableClasses(n).length > 0 || testAttrOf(n) !== '';

function cssCandidate(node: AnnotatedNode, positional: boolean): Candidate {
  const first = segmentOf(node, positional);
  const segments = [first];
  const nodes = [node];
  if (!anchored(node) && !TOP.has(node.tag)) {
    for (let cur = node.parent; cur && !TOP.has(cur.tag); cur = cur.parent) {
      segments.unshift(segmentOf(cur, positional));
      nodes.unshift(cur);
      if (anchored(cur)) break;
    }
  }
  const usesPosition = segments.some((s) => s.positional);
  return withSegments(
    {
      strategy: 'css',
      value: segments.map((s) => s.text).join(' > '),
      stability: usesPosition ? 'fragile' : 'medium',
    },
    nodes,
  );
}

/** A class token as a CSS identifier, escaping characters that are not allowed bare. */
function cssIdent(token: string): string {
  const escaped = token.replace(/[^\w-]/g, (ch) => `\\${ch}`);
  return escaped.replace(/^(-?)(\d)/, (_, dash: string, digit: string) => `${dash}\\3${digit} `);
}

/**
 * The element's tag and every one of its own class tokens, hashed ones
 * included. When none of its tokens is stable, the nearest anchored
 * ancestor's compound comes first, joined with a descendant combinator.
 */
function classCandidate(node: AnnotatedNode): Candidate | null {
  const tokens = classTokens(node);
  if (tokens.length === 0) return null;
  const own = node.tag + tokens.map((t) => `.${cssIdent(t)}`).join('');
  const stability: Stability = tokens.every((t) => classifyToken(t) === 'stable') ? 'medium' : 'fragile';
  const make = (value: string, nodes: AnnotatedNode[]): Candidate => withSegments({ strategy: 'class', value, stability }, nodes);
  if (anchored(node)) return make(own, [node]);
  for (let cur = node.parent; cur && !TOP.has(cur.tag); cur = cur.parent) {
    if (anchored(cur)) return make(`${compoundOf(cur)} ${own}`, [cur, node]);
  }
  return make(own, [node]);
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
  const nodes = [node];
  for (let cur = node.parent; cur; cur = cur.parent) {
    for (const attr of ['id', 'data-testid'] as const) {
      const value = cur.attrs[attr];
      const literal = value ? xpathLiteral(value) : null;
      if (literal) {
        return withSegments({ strategy: 'xpath', value: `//${cur.tag}[@${attr}=${literal}]/${steps.join('/')}`, stability: 'fragile' }, [cur, ...nodes]);
      }
    }
    steps.unshift(cur.parent ? xpathStep(cur) : `${cur.tag}[1]`);
    nodes.unshift(cur);
  }
  return withSegments({ strategy: 'xpath', value: `/${steps.join('/')}`, stability: 'fragile' }, nodes);
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
  if (node.role && !NO_ROLE.has(node.role)) {
    if (ctx.level) out.push({ strategy: 'role', value: node.role, stability: 'stable' });
    // No length cap: a link wrapping a heading and a URL has a long name, and
    // item scoped fields keep only the role (`relativize` drops the name).
    else if (node.name) out.push({ strategy: 'role', value: `${node.role}|${node.name}`, stability: 'stable' });
  }
  const testid = node.attrs['data-testid'];
  if (testid) out.push({ strategy: 'testid', value: testid, stability: 'stable' });
  const id = node.attrs.id;
  if (id) out.push({ strategy: 'id', value: id, stability: isStableId(id) ? 'stable' : 'fragile' });
  const text = ownText(node);
  if (text && text.length <= max) out.push({ strategy: 'text', value: text, stability: 'fragile' });
  const css = cssCandidate(node, ctx.positional ?? true);
  out.push(css);
  const cls = classCandidate(node);
  if (cls && cls.value !== css.value) out.push(cls);
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
export const STRATEGY_ORDER: readonly Strategy[] = ['role', 'testid', 'id', 'text', 'css', 'class', 'xpath'];


const TYPED = /^(role|testid|id|text|css|class|xpath)=([\s\S]+)$/;

/**
 * A selector typed by the user: `strategy=value` for any strategy (such as
 * `role=listitem`), an XPath when it starts with `/`, `./`, or `(`, else CSS.
 * Rated like a generated candidate of that strategy would be.
 */
export function parseSelector(text: string): Candidate {
  const trimmed = text.trim();
  const typed = TYPED.exec(trimmed);
  const strategy = (typed?.[1] ?? (/^(?:\/|\.\/|\()/.test(trimmed) ? 'xpath' : 'css')) as Strategy;
  const value = typed ? typed[2]!.trim() : trimmed;
  switch (strategy) {
    case 'role':
    case 'testid':
      return { strategy, value, stability: 'stable' };
    case 'id':
      return { strategy, value, stability: isStableId(value) ? 'stable' : 'fragile' };
    case 'css':
      return { strategy, value, stability: /:nth-(?:child|of-type)\(/.test(value) ? 'fragile' : 'medium' };
    case 'class':
      return { strategy, value, stability: classTokensOf(value).every((t) => classifyToken(t) === 'stable') ? 'medium' : 'fragile' };
    default:
      return { strategy, value, stability: 'fragile' };
  }
}

function classTokensOf(selector: string): string[] {
  return [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]!);
}
