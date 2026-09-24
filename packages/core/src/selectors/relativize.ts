import type { Candidate } from './generate';

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

/**
 * Express a candidate relative to an item container, given the container's
 * CSS selector (its last compound identifies the container element).
 * Segments up to and including the container are dropped, which removes the
 * positional parts that differ between sibling items. Item-specific
 * strategies (`id`, `text`) have no relative form and yield null; a `role`
 * candidate keeps its role and drops the item-specific name.
 */
export function relativize<T extends Candidate>(candidate: T, containerPath: string): T | null {
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
    case 'css': {
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
