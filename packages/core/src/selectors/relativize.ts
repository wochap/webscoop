import type { AnnotatedNode } from './annotated';
import { compoundOf, segmentNodesOf, type Candidate } from './generate';

interface Compound {
  tag: string | null;
  classes: string[];
}

const POSITIONAL = /:nth-(?:child|of-type)\(\d+\)/g;
const HAS_POSITIONAL = /:nth-(?:child|of-type)\(\d+\)/;

function parseCompound(segment: string): Compound {
  const base = segment.replace(POSITIONAL, '');
  const tag = /^[a-zA-Z][\w-]*/.exec(base)?.[0]?.toLowerCase() ?? null;
  const classes = [...base.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]!);
  return { tag, classes };
}

/** Split a CSS complex selector into compounds and the combinators between them. */
function splitCss(value: string): { segments: string[]; combinators: string[] } | null {
  const segments: string[] = [];
  const combinators: string[] = [];
  let current = '';
  let depth = 0;
  let pending: string | null = null;
  for (const ch of value.trim()) {
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    if (depth === 0 && (ch === ' ' || ch === '>')) {
      if (current) {
        segments.push(current);
        current = '';
        pending = ' ';
      }
      if (ch === '>') pending = '>';
      continue;
    }
    if (depth === 0 && (ch === ',' || ch === '+' || ch === '~')) return null;
    if (pending !== null) {
      combinators.push(pending === '>' ? ' > ' : ' ');
      pending = null;
    }
    current += ch;
  }
  if (current) segments.push(current);
  return { segments, combinators };
}

function matchesContainer(segment: Compound, container: Compound): boolean {
  if (container.tag === null && container.classes.length === 0) return false;
  if (container.tag !== null && segment.tag !== container.tag) return false;
  return container.classes.every((c) => segment.classes.includes(c));
}

/** Split an XPath into steps at `/` outside predicates, keeping `//` as an empty step. */
function splitXPath(value: string): string[] {
  const steps: string[] = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === '/' && depth === 0) {
      steps.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  steps.push(current);
  return steps;
}

function isAncestorOrSelf(ancestor: AnnotatedNode, node: AnnotatedNode): boolean {
  for (let cur: AnnotatedNode | null | undefined = node; cur; cur = cur.parent) if (cur === ancestor) return true;
  return false;
}

/**
 * Where to cut a generated candidate for a container element: the number of
 * leading segments to drop, `'self'` when the candidate ends at the container,
 * or null when the container is not above any segment (keep the candidate).
 */
function cutAt(nodes: readonly AnnotatedNode[], container: AnnotatedNode): number | 'self' | null {
  let above = 0;
  while (above < nodes.length && isAncestorOrSelf(nodes[above]!, container)) above++;
  if (above === 0) return null;
  if (above === nodes.length) return 'self';
  return above;
}

/** Cut a CSS candidate by its segment nodes; combinators come from the text. */
function cutCss<T extends Candidate>(out: T, candidate: Candidate, nodes: readonly AnnotatedNode[], container: AnnotatedNode, anchor = false): T | null {
  const split = splitCss(candidate.value);
  if (!split || split.segments.length !== nodes.length) return null;
  const cut = cutAt(nodes, container);
  if (cut === 'self') return null;
  if (cut === null) return out;
  // A child combinator right below the container keeps its depth through `:scope`.
  const scoped = anchor && nodes[cut - 1] === container && split.combinators[cut - 1] === ' > ';
  let value = (scoped ? ':scope > ' : '') + split.segments[cut]!;
  for (let i = cut + 1; i < split.segments.length; i++) value += split.combinators[i - 1]! + split.segments[i]!;
  if (candidate.strategy === 'class') return { ...out, value };
  const positional = split.segments.slice(cut).some((s) => HAS_POSITIONAL.test(s));
  return { ...out, value, stability: positional ? 'fragile' : 'medium' };
}

/** Cut an XPath candidate by its step nodes; the anchor step (`//tag[@id=...]`) stands for its element too. */
function cutXPath<T extends Candidate>(out: T, candidate: Candidate, nodes: readonly AnnotatedNode[], container: AnnotatedNode): T | null {
  const raw = splitXPath(candidate.value);
  // `//a[@id='x']/b[1]` splits into ['', '', "a[@id='x']", 'b[1]']; `/html[1]/b[1]` into ['', 'html[1]', 'b[1]'].
  const steps = raw.slice(raw[1] === '' ? 2 : 1);
  if (steps.length !== nodes.length) return null;
  const cut = cutAt(nodes, container);
  if (cut === 'self') return null;
  if (cut === null) return out;
  return { ...out, value: `./${steps.slice(cut).join('/')}` };
}

export interface RelativizeOptions {
  /**
   * Keep a CSS candidate's depth below the container: when its first kept
   * segment is a direct child of the container, prefix `:scope > `. Without
   * it, `div > div` inside a list parent matches every such pair at any depth.
   * Used for item containers relative to their list parent.
   */
  anchor?: boolean;
}

/**
 * Express a candidate relative to an item container. Given the container
 * element, candidates made by `generate` are cut at that element itself:
 * segments up to and including it are dropped, which removes the positional
 * parts that differ between sibling items. Given a CSS selector instead (or
 * for a candidate not made by `generate`, such as one the user typed), the
 * cut falls after the last segment matching the selector's last compound.
 * Item-specific strategies (`id`, `text`) have no relative form and yield
 * null; a `role` candidate keeps its role and drops the item-specific name.
 */
export function relativize<T extends Candidate>(candidate: T, container: AnnotatedNode | string, opts: RelativizeOptions = {}): T | null {
  const { count: _count, ...rest } = candidate;
  const out = rest as T;
  const nodes = typeof container === 'string' ? undefined : segmentNodesOf(candidate);
  if (nodes && typeof container !== 'string') {
    if (candidate.strategy === 'css' || candidate.strategy === 'class') {
      const cut = cutCss(out, candidate, nodes, container, opts.anchor);
      if (cut !== null || cutAt(nodes, container) === 'self') return cut;
    } else if (candidate.strategy === 'xpath') {
      const cut = cutXPath(out, candidate, nodes, container);
      if (cut !== null || cutAt(nodes, container) === 'self') return cut;
    }
  }
  return relativizeByText(candidate, typeof container === 'string' ? container : compoundOf(container));
}

/**
 * The string form: `containerPath` is the container's CSS selector; its last
 * compound identifies the container element in the candidate.
 */
export function relativizeByText<T extends Candidate>(candidate: T, containerPath: string): T | null {
  const containerSplit = splitCss(containerPath);
  const last = containerSplit?.segments.at(-1);
  const container = last ? parseCompound(last) : { tag: null, classes: [] };
  const { count: _count, ...rest } = candidate;
  const out = rest as T;
  switch (candidate.strategy) {
    case 'id':
    case 'text':
      return null;
    case 'testid':
      return out;
    case 'role': {
      const bar = candidate.value.indexOf('|');
      return bar === -1 ? out : { ...out, value: candidate.value.slice(0, bar) };
    }
    case 'css':
    case 'class': {
      const split = splitCss(candidate.value);
      if (!split) return out;
      let index = -1;
      split.segments.forEach((segment, i) => {
        if (matchesContainer(parseCompound(segment), container)) index = i;
      });
      if (index === -1) return out;
      if (index === split.segments.length - 1) return null;
      let value = split.segments[index + 1]!;
      for (let i = index + 2; i < split.segments.length; i++) value += split.combinators[i - 1]! + split.segments[i]!;
      if (candidate.strategy === 'class') return { ...out, value };
      const positional = split.segments.slice(index + 1).some((s) => HAS_POSITIONAL.test(s));
      return { ...out, value, stability: positional ? 'fragile' : 'medium' };
    }
    case 'xpath': {
      const steps = splitXPath(candidate.value);
      let index = -1;
      steps.forEach((step, i) => {
        const name = /^[a-zA-Z][\w-]*/.exec(step)?.[0]?.toLowerCase();
        if (name && name === container.tag) index = i;
      });
      if (index === -1 || index === steps.length - 1) return null;
      return { ...out, value: `./${steps.slice(index + 1).join('/')}` };
    }
  }
}
