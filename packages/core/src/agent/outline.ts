import type { SerializedNode, SerializedElement } from '../ports';
import { annotate, descendantsOf, type AnnotatedNode } from '../selectors/annotated';
import { directText, selfHidden } from '../healing/model';

/** Longest outline line, ref included. */
export const OUTLINE_LINE_MAX = 120;
/** Longest `value=` shown for an input. */
export const OUTLINE_VALUE_MAX = 40;
/** Most lines `find` answers with. */
export const FIND_MAX = 20;
/** Share of the context window the outline may fill. */
export const OUTLINE_SHARE = 0.4;
/** Shortest own text that makes a plain element worth a line. */
const MIN_TEXT = 3;

const INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch', 'option', 'textbox', 'searchbox', 'combobox', 'slider', 'spinbutton', 'treeitem']);
const HEADING = /^h[1-6]$/;

type Group = 'interactive' | 'heading' | 'text';

interface Entry {
  ref: string;
  node: AnnotatedNode;
  group: Group;
  /** The rendered line, cut to `OUTLINE_LINE_MAX`. */
  line: string;
  /** Name, text, and href, for `find`. */
  haystack: string;
}

export interface Outline {
  /** Every kept line in document order, cut ones included. */
  all: readonly string[];
  /** The text shown to the model: the lines that fit the budget, then `... <n> more lines; use find` when some were cut. */
  text: string;
  /** Lines left out by the budget. */
  cut: number;
  /** The outline line of a ref, or undefined when the ref is not in this outline. */
  line(ref: string): string | undefined;
  /** The snapshot node a ref stands for. */
  node(ref: string): AnnotatedNode | undefined;
  /** Up to `FIND_MAX` lines, cut ones included, whose name, text, or href contains `text`, ignoring case. */
  find(text: string): string[];
}

/** Secret values by placeholder, e.g. `{password}` → `hunter2`. */
export type Secrets = ReadonlyMap<string, string>;

/** Options to filter or scope outline generation. */
export interface OutlineOptions {
  /** Include only interactive elements, omitting plain text and headings without interactive children. */
  interactive?: boolean;
  /** Scope the outline to elements within the first subtree matching this selector. */
  scope?: string;
  /** Stop recursing into children when node depth is at or beyond this depth. */
  depth?: number;
  /** Secret values to mask. */
  secrets?: Secrets;
}

/**
 * Replaces every secret value in a text with its placeholder, longest value
 * first so a secret containing another is masked whole. The identity when
 * there are no secrets.
 */
export function masker(secrets: Secrets | undefined): (text: string) => string {
  const pairs = [...(secrets ?? new Map<string, string>())].filter(([, value]) => value.length > 0).sort((a, b) => b[1].length - a[1].length);
  if (pairs.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const [placeholder, value] of pairs) out = out.split(value).join(placeholder);
    return out;
  };
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`);
const quote = (text: string) => text.replace(/"/g, "'");
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

function roleOf(node: AnnotatedNode): string | undefined {
  if (node.attrs.role) return node.attrs.role.split(/\s+/)[0];
  if (node.role && node.role !== 'presentation') return node.role;
  switch (node.tag) {
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    case 'summary':
      return 'button';
    default:
      return 'onclick' in node.attrs ? 'button' : undefined;
  }
}

function interactive(node: AnnotatedNode): boolean {
  if (node.tag === 'input') return (node.attrs.type ?? 'text') !== 'hidden';
  if (node.tag === 'a') return 'href' in node.attrs || INTERACTIVE_ROLES.has(node.attrs.role ?? '');
  if (node.tag === 'button' || node.tag === 'select' || node.tag === 'textarea' || node.tag === 'summary') return true;
  return 'onclick' in node.attrs || INTERACTIVE_ROLES.has(node.attrs.role?.split(/\s+/)[0] ?? '');
}

const isHeading = (node: AnnotatedNode) => HEADING.test(node.tag) || node.attrs.role === 'heading';

function nameOf(node: AnnotatedNode): string {
  const a = node.attrs;
  if (node.tag === 'input' || node.tag === 'textarea' || node.tag === 'select') {
    const type = a.type ?? 'text';
    if (type === 'submit' || type === 'button' || type === 'reset') return squash(a['aria-label'] ?? a.value ?? a.title ?? '');
    return squash(a['aria-label'] ?? a.placeholder ?? a.title ?? a.name ?? '');
  }
  return squash(node.name ?? a['aria-label'] ?? a.title ?? a.alt ?? '');
}

function textOf(node: AnnotatedNode): string {
  const parts: string[] = [];
  const walk = (n: AnnotatedNode) => {
    for (const c of n.children) {
      if (c.type === 'text') parts.push(c.text);
      else if (!selfHidden(c)) walk(c);
    }
  };
  walk(node);
  return squash(parts.join(' '));
}

/** The name a control is known by: its accessible name, else its text. */
export function accessibleName(node: AnnotatedNode): string {
  return nameOf(node) || textOf(node);
}

function matchesCompound(node: AnnotatedNode, sel: string): boolean {
  sel = sel.trim();
  if (!sel || sel === '*') return true;
  let rest = sel;
  const tagMatch = rest.match(/^[a-zA-Z0-9_-]+/);
  if (tagMatch) {
    if (node.tag.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  while (rest.length > 0) {
    if (rest.startsWith('#')) {
      const m = rest.match(/^#([a-zA-Z0-9_-]+)/);
      if (!m) return false;
      if (node.attrs.id !== m[1]) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith('.')) {
      const m = rest.match(/^\.([a-zA-Z0-9_-]+)/);
      if (!m) return false;
      const classes = (node.attrs.class ?? '').split(/\s+/);
      if (!classes.includes(m[1])) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith('[')) {
      const m = rest.match(/^\[([a-zA-Z0-9_-]+)(?:=("[^"]*"|'[^']*'|[^\]]+))?\]/);
      if (!m) return false;
      const attr = m[1]!;
      let val = m[2];
      if (val !== undefined) {
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (node.attrs[attr] !== val) return false;
      } else {
        if (!(attr in node.attrs)) return false;
      }
      rest = rest.slice(m[0].length);
    } else {
      return false;
    }
  }
  return true;
}

export function matchesSelector(node: AnnotatedNode, selector: string): boolean {
  const rawTokens = selector.trim().split(/\s+/);
  const tokens: string[] = [];
  for (const t of rawTokens) {
    if (t === '>') tokens.push('>');
    else if (t.includes('>')) {
      const sub = t.split('>');
      for (let i = 0; i < sub.length; i++) {
        if (i > 0) tokens.push('>');
        if (sub[i]) tokens.push(sub[i]!);
      }
    } else {
      tokens.push(t);
    }
  }
  if (tokens.length === 0) return true;
  const last = tokens[tokens.length - 1]!;
  if (!matchesCompound(node, last)) return false;

  let currNode: AnnotatedNode | null = node;
  let i = tokens.length - 2;

  while (i >= 0 && currNode) {
    if (tokens[i] === '>') {
      const parentToken = tokens[i - 1];
      if (!parentToken) return false;
      currNode = currNode.parent ?? null;
      if (!currNode || !matchesCompound(currNode, parentToken)) return false;
      i -= 2;
    } else {
      const ancestorToken = tokens[i]!;
      let found = false;
      for (let p = currNode.parent; p; p = p.parent) {
        if (matchesCompound(p, ancestorToken)) {
          currNode = p;
          found = true;
          break;
        }
      }
      if (!found) return false;
      i--;
    }
  }
  return i < 0;
}

function findScopedNode(root: AnnotatedNode, selector: string): AnnotatedNode | undefined {
  const all = descendantsOf(root);
  return all.find((n) => matchesSelector(n, selector));
}

function render(ref: string, node: AnnotatedNode, group: Group, mask: (text: string) => string, depth: number): { line: string; haystack: string } {
  let role = group === 'text' ? 'text' : (roleOf(node) ?? (isHeading(node) ? 'heading' : node.tag));
  if (group === 'heading') role = 'heading';
  if (node.tag === 'input' && group === 'interactive') {
    const type = node.attrs.type ?? 'text';
    if (type === 'submit' || type === 'button' || type === 'reset') role = 'button';
    else if (type !== 'checkbox' && type !== 'radio') role = role === 'combobox' ? role : 'textbox';
  }
  let name = group === 'text' ? directText(node) : group === 'heading' ? (nameOf(node) || textOf(node)) : nameOf(node);
  if (group === 'interactive' && !name && node.tag === 'a') name = textOf(node);
  name = mask(squash(name));
  const extras: string[] = [];
  const haystack = [name];
  if (node.tag === 'a' && node.attrs.href !== undefined) {
    const href = mask(node.attrs.href);
    extras.push(`href=${href}`);
    haystack.push(href);
  }
  if (group === 'interactive' && (node.tag === 'input' || node.tag === 'textarea') && role === 'textbox') {
    const value = squash(node.attrs.value ?? '');
    // A password never reaches the model, whatever its value.
    const shown = node.tag === 'input' && node.attrs.type === 'password' && value !== '' ? '***' : mask(value);
    extras.push(`value="${quote(clip(shown, OUTLINE_VALUE_MAX))}"`);
  }
  if (group === 'interactive' && (role === 'checkbox' || role === 'radio') && 'checked' in node.attrs) extras.push('checked');
  if (node.attrs['aria-expanded'] === 'true' || node.attrs['aria-expanded'] === 'false') {
    extras.push(`aria-expanded="${node.attrs['aria-expanded']}"`);
  }
  if (node.attrs.disabled !== undefined || node.attrs['aria-disabled'] === 'true') {
    extras.push('disabled');
  }
  if ((node.tag === 'input' || node.tag === 'textarea') && node.attrs.placeholder) {
    const ph = mask(squash(node.attrs.placeholder));
    extras.push(`placeholder="${quote(clip(ph, OUTLINE_VALUE_MAX))}"`);
    haystack.push(ph);
  }
  const head = `[${ref}] ${role}`;
  const indent = '  '.repeat(Math.min(8, Math.max(0, depth)));
  const line = `${indent}${[head, ...(name ? [`"${quote(name)}"`] : []), ...extras].join(' ')}`;
  return { line: clip(line, OUTLINE_LINE_MAX), haystack: haystack.join(' ').toLowerCase() };
}

/** The elements an outline keeps, in document order, with refs `e1`, `e2`, ... */
function collect(root: AnnotatedNode, mask: (text: string) => string, options: OutlineOptions = {}): Entry[] {
  const entries: Entry[] = [];
  const add = (node: AnnotatedNode, group: Group, depth: number) => {
    const ref = `e${entries.length + 1}`;
    entries.push({ ref, node, group, ...render(ref, node, group, mask, depth) });
  };

  let targetRoot: AnnotatedNode = root;
  if (options.scope) {
    const scoped = findScopedNode(root, options.scope);
    if (!scoped) return [];
    targetRoot = scoped;
  }

  const isScopeRoot = targetRoot !== root;

  const walk = (node: AnnotatedNode, insideInteractive: boolean, depth: number) => {
    const isDocContainer = node.tag === 'html' || node.tag === 'body';
    if (!isDocContainer && selfHidden(node)) return;

    const isInteractive = !isDocContainer && interactive(node);
    const isHeadingNode = !isDocContainer && isHeading(node);
    const isContainerOnly = isScopeRoot && node === targetRoot && !isInteractive && !isHeadingNode && directText(node).length < MIN_TEXT;

    if (!isContainerOnly) {
      if (isInteractive) {
        add(node, 'interactive', depth);
      } else if (!options.interactive) {
        if (isHeadingNode) add(node, 'heading', depth);
        else if (!insideInteractive && directText(node).length >= MIN_TEXT) add(node, 'text', depth);
      }
    }

    if (options.depth !== undefined && depth >= options.depth) {
      return;
    }

    const inside = insideInteractive || isInteractive || isHeadingNode;
    const nextDepth = isDocContainer || isContainerOnly ? 0 : depth + 1;

    for (const c of node.children) {
      if (c.type === 'element') walk(c, inside, nextDepth);
    }
  };

  walk(targetRoot, false, 0);
  return entries;
}

/**
 * The outline of a page snapshot: one line per interactive element, heading,
 * and text-bearing element, in document order, each with a ref `e<n>` that is
 * the same on an unchanged page. Lines beyond `budgetTokens` are left out,
 * text first, then headings, then interactive elements, and a final line says
 * how many. Secret values in names, hrefs, and values are shown as their
 * placeholders, and a password input's value as `***`.
 */
export function buildOutline(
  tree: SerializedNode,
  budgetTokens: number,
  estimate: (text: string) => number,
  optionsOrSecrets?: Secrets | OutlineOptions,
): Outline {
  if (tree.type !== 'element') return emptyOutline();
  const options: OutlineOptions =
    optionsOrSecrets instanceof Map
      ? { secrets: optionsOrSecrets }
      : (optionsOrSecrets ?? {});
  const secrets = options.secrets;
  const entries = collect(annotate(tree as SerializedElement), masker(secrets), options);
  const trailer = (n: number) => `... ${n} more lines; use find`;
  const room = Math.max(0, budgetTokens - estimate(trailer(entries.length)) - 1);
  const keep = new Set<Entry>();
  let used = 0;
  for (const group of ['interactive', 'heading', 'text'] as const) {
    let full = false;
    for (const entry of entries) {
      if (entry.group !== group || full) continue;
      const cost = estimate(entry.line) + 1;
      if (used + cost > room) {
        full = true;
        continue;
      }
      used += cost;
      keep.add(entry);
    }
    if (full) break;
  }
  const cut = entries.length - keep.size;
  const shown = entries.filter((e) => keep.has(e)).map((e) => e.line);
  const text = [...shown, ...(cut > 0 ? [trailer(cut)] : [])].join('\n');
  const byRef = new Map(entries.map((e) => [e.ref, e]));
  return {
    all: entries.map((e) => e.line),
    text,
    cut,
    line: (ref) => byRef.get(ref)?.line,
    node: (ref) => byRef.get(ref)?.node,
    find: (needle) => {
      const n = needle.trim().toLowerCase();
      if (!n) return [];
      return entries.filter((e) => e.haystack.includes(n)).slice(0, FIND_MAX).map((e) => e.line);
    },
  };
}

function emptyOutline(): Outline {
  return { all: [], text: '', cut: 0, line: () => undefined, node: () => undefined, find: () => [] };
}

/** Tokens the outline may take: 40 percent of the context window, less the system message and the goal. */
export function outlineBudget(contextTokens: number, fixedTokens: number): number {
  return Math.max(256, Math.floor(contextTokens * OUTLINE_SHARE) - fixedTokens);
}
