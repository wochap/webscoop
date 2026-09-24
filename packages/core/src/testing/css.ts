import type { DomNode } from './dom';

/**
 * A small CSS selector engine for serialized DOM: type, universal, `#id`,
 * `.class`, attribute selectors (`=`, `~=`, `^=`, `$=`, `*=`), `:nth-of-type(n)`, `:nth-child(n)`,
 * `:first-child`, `:last-child`, descendant and child combinators, selector lists.
 */

interface AttrTest {
  name: string;
  op?: '=' | '~=' | '^=' | '$=' | '*=';
  value?: string;
}

interface Compound {
  tag: string | null;
  ids: string[];
  classes: string[];
  attrs: AttrTest[];
  nthOfType: number | null;
  nthChild: number | null;
  firstChild: boolean;
  lastChild: boolean;
}

interface Step {
  compound: Compound;
  /** Combinator linking this step to the previous one. */
  combinator: ' ' | '>' | null;
}

const IDENT = /^-?[_a-zA-Z][\w-]*/;

class Parser {
  pos = 0;
  constructor(readonly src: string) {}

  fail(): never {
    throw new Error(`unsupported CSS selector: ${this.src}`);
  }

  peek(): string {
    return this.src[this.pos] ?? '';
  }

  ident(): string {
    const m = IDENT.exec(this.src.slice(this.pos));
    if (!m) this.fail();
    this.pos += m[0].length;
    return m[0];
  }

  skipSpace(): boolean {
    const start = this.pos;
    while (/\s/.test(this.peek())) this.pos++;
    return this.pos > start;
  }

  quoted(): string {
    const quote = this.peek();
    if (quote !== '"' && quote !== "'") return this.ident();
    const end = this.src.indexOf(quote, this.pos + 1);
    if (end === -1) this.fail();
    const value = this.src.slice(this.pos + 1, end);
    this.pos = end + 1;
    return value;
  }

  compound(): Compound {
    const c: Compound = { tag: null, ids: [], classes: [], attrs: [], nthOfType: null, nthChild: null, firstChild: false, lastChild: false };
    let any = false;
    if (this.peek() === '*') {
      this.pos++;
      any = true;
    } else if (IDENT.test(this.src.slice(this.pos))) {
      c.tag = this.ident().toLowerCase();
      any = true;
    }
    for (;;) {
      const ch = this.peek();
      if (ch === '#') {
        this.pos++;
        c.ids.push(this.ident());
      } else if (ch === '.') {
        this.pos++;
        c.classes.push(this.ident());
      } else if (ch === '[') {
        this.pos++;
        this.skipSpace();
        const name = this.ident().toLowerCase();
        this.skipSpace();
        const opMatch = /^(=|~=|\^=|\$=|\*=)/.exec(this.src.slice(this.pos));
        if (opMatch) {
          this.pos += opMatch[0].length;
          this.skipSpace();
          const value = this.quoted();
          this.skipSpace();
          c.attrs.push({ name, op: opMatch[0] as AttrTest['op'], value });
        } else {
          c.attrs.push({ name });
        }
        if (this.peek() !== ']') this.fail();
        this.pos++;
      } else if (ch === ':') {
        this.pos++;
        const pseudo = this.ident();
        if (pseudo === 'first-child') c.firstChild = true;
        else if (pseudo === 'last-child') c.lastChild = true;
        else if ((pseudo === 'nth-of-type' || pseudo === 'nth-child') && this.peek() === '(') {
          const end = this.src.indexOf(')', this.pos);
          const n = Number(this.src.slice(this.pos + 1, end).trim());
          if (!Number.isInteger(n) || n < 1) this.fail();
          if (pseudo === 'nth-child') c.nthChild = n;
          else c.nthOfType = n;
          this.pos = end + 1;
        } else this.fail();
      } else break;
      any = true;
    }
    if (!any) this.fail();
    return c;
  }

  complex(): Step[] {
    const steps: Step[] = [];
    this.skipSpace();
    steps.push({ compound: this.compound(), combinator: null });
    for (;;) {
      const hadSpace = this.skipSpace();
      const ch = this.peek();
      if (ch === '' || ch === ',') break;
      let combinator: ' ' | '>' = ' ';
      if (ch === '>') {
        combinator = '>';
        this.pos++;
        this.skipSpace();
      } else if (!hadSpace) this.fail();
      steps.push({ compound: this.compound(), combinator });
    }
    return steps;
  }

  list(): Step[][] {
    const list = [this.complex()];
    while (this.peek() === ',') {
      this.pos++;
      list.push(this.complex());
    }
    this.skipSpace();
    if (this.pos !== this.src.length) this.fail();
    return list;
  }
}

function matchesAttr(value: string | undefined, test: AttrTest): boolean {
  if (value === undefined) return false;
  if (!test.op) return true;
  const expected = test.value ?? '';
  switch (test.op) {
    case '=':
      return value === expected;
    case '~=':
      return value.split(/\s+/).includes(expected);
    case '^=':
      return expected !== '' && value.startsWith(expected);
    case '$=':
      return expected !== '' && value.endsWith(expected);
    case '*=':
      return expected !== '' && value.includes(expected);
  }
}

function matchesCompound(node: DomNode, c: Compound): boolean {
  const { tag, attrs } = node.el;
  if (c.tag && c.tag !== tag) return false;
  for (const id of c.ids) if (attrs.id !== id) return false;
  if (c.classes.length > 0) {
    const classes = (attrs.class ?? '').split(/\s+/);
    for (const cls of c.classes) if (!classes.includes(cls)) return false;
  }
  for (const test of c.attrs) if (!matchesAttr(attrs[test.name], test)) return false;
  const siblings = node.parent?.children ?? [node];
  if (c.firstChild && siblings[0] !== node) return false;
  if (c.lastChild && siblings[siblings.length - 1] !== node) return false;
  if (c.nthChild !== null && siblings.indexOf(node) + 1 !== c.nthChild) return false;
  if (c.nthOfType !== null) {
    const sameType = siblings.filter((s) => s.el.tag === tag);
    if (sameType.indexOf(node) + 1 !== c.nthOfType) return false;
  }
  return true;
}

function matchesComplex(node: DomNode, steps: Step[], i: number, scope: DomNode | null): boolean {
  const step = steps[i]!;
  if (!matchesCompound(node, step.compound)) return false;
  if (i === 0) return true;
  const isInScope = (n: DomNode | null): n is DomNode => n !== null && n !== scope;
  if (step.combinator === '>') {
    return isInScope(node.parent) && matchesComplex(node.parent, steps, i - 1, scope);
  }
  for (let p = node.parent; isInScope(p); p = p.parent) {
    if (matchesComplex(p, steps, i - 1, scope)) return true;
  }
  return false;
}

export function compileCss(selector: string): (node: DomNode, scope: DomNode | null) => boolean {
  const list = new Parser(selector).list();
  return (node, scope) => list.some((steps) => matchesComplex(node, steps, steps.length - 1, scope));
}
