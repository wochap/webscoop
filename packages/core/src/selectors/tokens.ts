import type { AnnotatedNode } from './annotated';

export type TokenClass = 'stable' | 'hashed';

const HASHED_PREFIX = /^(?:css|sc|jsx|emotion)-/;
const HASHED_SUFFIX = /-(?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]{4,}$|-[a-f0-9]{8,}$/;
const ALNUM_RUN = /[A-Za-z0-9]{5,}/g;

/** Whether a run of letters and digits looks machine generated rather than written. */
function mixedRun(run: string): boolean {
  if (/\d/.test(run) && /[A-Za-z]/.test(run)) return true;
  let flips = 0;
  for (let i = 1; i < run.length; i++) {
    const a = run[i - 1]!;
    const b = run[i]!;
    if ((a >= 'a' && a <= 'z' && b >= 'A' && b <= 'Z') || (a >= 'A' && a <= 'Z' && b >= 'a' && b <= 'z')) flips++;
  }
  return flips >= 3;
}

/**
 * Classify a class token or attribute value as `hashed` when it matches a
 * generated pattern: a run of 5 or more mixed letters and digits, a `css-`,
 * `sc-`, `jsx-`, or `emotion-` prefix, or a trailing `-` plus 4 or more hex or
 * base64 characters.
 */
export function classifyToken(token: string): TokenClass {
  if (HASHED_PREFIX.test(token)) return 'hashed';
  if (HASHED_SUFFIX.test(token)) return 'hashed';
  for (const [run] of token.matchAll(ALNUM_RUN)) if (mixedRun(run)) return 'hashed';
  // Values with no letters at all, such as `48213`, are not written by a person either.
  return /^\d{3,}$/.test(token) ? 'hashed' : 'stable';
}

/** An id is stable unless it looks hashed or numeric. */
export function isStableId(id: string): boolean {
  return classifyToken(id) === 'stable' && !/\d{3,}/.test(id) && !/^\d/.test(id);
}

const CSS_IDENT = /^-?[_a-zA-Z][\w-]*$/;

export function classTokens(node: AnnotatedNode): string[] {
  return (node.attrs.class ?? '').split(/\s+/).filter(Boolean);
}

/** Class tokens usable in a CSS candidate: not hashed and a plain identifier. */
export function stableClasses(node: AnnotatedNode): string[] {
  return classTokens(node).filter((t) => CSS_IDENT.test(t) && classifyToken(t) === 'stable');
}
