import { normalize, textContent, type DomNode } from './dom';

/**
 * A small XPath subset for serialized DOM: absolute and relative location
 * paths with `/`, `//`, `.`, `..`, name tests or `*`, and predicates made of
 * positions, `@attr`, `@attr='v'`, `text()='v'`, `normalize-space()='v'`,
 * `contains(@attr|text()|., 'v')`, `starts-with(...)`, joined with `and`.
 */

type Axis = 'child' | 'descendant' | 'self' | 'parent';

interface XStep {
  axis: Axis;
  name: string;
  predicates: string[];
}

function fail(src: string): never {
  throw new Error(`unsupported XPath: ${src}`);
}

function splitSteps(src: string): { absolute: boolean; steps: XStep[] } {
  let rest = src.trim();
  let absolute = false;
  let pendingAxis: Axis = 'child';
  if (rest.startsWith('//')) {
    absolute = true;
    pendingAxis = 'descendant';
    rest = rest.slice(2);
  } else if (rest.startsWith('/')) {
    absolute = true;
    rest = rest.slice(1);
  }
  const steps: XStep[] = [];
  while (rest.length > 0) {
    let i = 0;
    let depth = 0;
    let quote = '';
    for (; i < rest.length; i++) {
      const ch = rest[i]!;
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '[') depth++;
      else if (ch === ']') depth--;
      else if (ch === '/' && depth === 0) break;
    }
    const token = rest.slice(0, i).trim();
    const nameMatch = /^(\.\.|\.|\*|[A-Za-z][\w-]*)/.exec(token);
    if (!nameMatch) fail(src);
    const name = nameMatch[0];
    const predicates: string[] = [];
    let p = name.length;
    while (p < token.length) {
      if (token[p] !== '[') fail(src);
      let d = 0;
      let q = '';
      let j = p;
      for (; j < token.length; j++) {
        const ch = token[j]!;
        if (q) {
          if (ch === q) q = '';
        } else if (ch === '"' || ch === "'") q = ch;
        else if (ch === '[') d++;
        else if (ch === ']' && --d === 0) break;
      }
      predicates.push(token.slice(p + 1, j).trim());
      p = j + 1;
    }
    if (name === '.') steps.push({ axis: pendingAxis === 'descendant' ? 'descendant' : 'self', name: '*', predicates });
    else if (name === '..') steps.push({ axis: 'parent', name: '*', predicates });
    else steps.push({ axis: pendingAxis, name: name.toLowerCase(), predicates });
    rest = rest.slice(i);
    if (rest.startsWith('//')) {
      pendingAxis = 'descendant';
      rest = rest.slice(2);
    } else if (rest.startsWith('/')) {
      pendingAxis = 'child';
      rest = rest.slice(1);
    }
  }
  return { absolute, steps };
}

function splitAnd(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && expr.startsWith(' and ', i)) {
      parts.push(expr.slice(start, i).trim());
      start = i + 5;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts;
}

function operand(node: DomNode, src: string, expr: string): string | undefined {
  if (expr.startsWith('@')) return node.el.attrs[expr.slice(1).toLowerCase()];
  if (expr === 'text()') {
    return node.el.children.map((c) => (c.type === 'text' ? c.text : '')).join('');
  }
  if (expr === '.' || expr === 'string()' || expr === 'string(.)') return textContent(node.el);
  if (expr === 'normalize-space()' || expr === 'normalize-space(.)') return normalize(textContent(node.el));
  fail(src);
}

function literal(src: string, expr: string): string {
  const m = /^(['"])(.*)\1$/.exec(expr.trim());
  if (!m) fail(src);
  return m[2]!;
}

function testPredicate(node: DomNode, position: number, src: string, pred: string): boolean {
  if (/^\d+$/.test(pred)) return position === Number(pred);
  if (pred === 'last()') return false; // handled by caller
  return splitAnd(pred).every((part) => {
    let m: RegExpExecArray | null;
    if ((m = /^(contains|starts-with)\((.+?),\s*(['"].*['"])\)$/.exec(part))) {
      const value = operand(node, src, m[2]!.trim());
      const needle = literal(src, m[3]!);
      if (value === undefined) return false;
      return m[1] === 'contains' ? value.includes(needle) : value.startsWith(needle);
    }
    if ((m = /^(.+?)\s*=\s*(['"].*['"])$/.exec(part))) {
      return operand(node, src, m[1]!.trim()) === literal(src, m[2]!);
    }
    if (part.startsWith('@')) return operand(node, src, part) !== undefined;
    fail(src);
  });
}

function descendants(node: DomNode, out: DomNode[]): void {
  for (const child of node.children) {
    out.push(child);
    descendants(child, out);
  }
}

/** Evaluate an XPath against a context node; `document` is the virtual node above `<html>`. */
export function evaluateXPath(src: string, context: DomNode, document: DomNode): DomNode[] {
  const { absolute, steps } = splitSteps(src);
  let current: DomNode[] = [absolute ? document : context];
  for (const step of steps) {
    const next = new Set<DomNode>();
    for (const ctx of current) {
      let candidates: DomNode[];
      if (step.axis === 'child') candidates = ctx.children;
      else if (step.axis === 'self') candidates = [ctx];
      else if (step.axis === 'parent') candidates = ctx.parent ? [ctx.parent] : [];
      else {
        // `//name` is descendant-or-self::node()/child::name, applied per parent.
        const parents: DomNode[] = [ctx];
        descendants(ctx, parents);
        for (const parent of parents) {
          let group = parent.children.filter((c) => step.name === '*' || c.el.tag === step.name);
          group = applyPredicates(group, step, src);
          group.forEach((n) => next.add(n));
        }
        continue;
      }
      candidates = candidates.filter((c) => step.name === '*' || c.el.tag === step.name);
      applyPredicates(candidates, step, src).forEach((n) => next.add(n));
    }
    current = [...next].sort((a, b) => a.order - b.order);
  }
  return current.filter((n) => n !== document);
}

function applyPredicates(nodes: DomNode[], step: XStep, src: string): DomNode[] {
  let result = nodes;
  for (const pred of step.predicates) {
    result = result.filter((node, i) =>
      pred === 'last()' ? i === result.length - 1 : testPredicate(node, i + 1, src, pred),
    );
  }
  return result;
}
