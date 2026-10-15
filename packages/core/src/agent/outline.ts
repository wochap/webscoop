import type { SerializedNode, SerializedElement } from '../ports';
import { annotate, type AnnotatedNode } from '../selectors/annotated';
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

function render(ref: string, node: AnnotatedNode, group: Group): { line: string; haystack: string } {
  let role = group === 'text' ? 'text' : (roleOf(node) ?? (isHeading(node) ? 'heading' : node.tag));
  if (group === 'heading') role = 'heading';
  if (node.tag === 'input' && group === 'interactive') {
    const type = node.attrs.type ?? 'text';
    if (type === 'submit' || type === 'button' || type === 'reset') role = 'button';
    else if (type !== 'checkbox' && type !== 'radio') role = role === 'combobox' ? role : 'textbox';
  }
  let name = group === 'text' ? directText(node) : group === 'heading' ? (nameOf(node) || textOf(node)) : nameOf(node);
  if (group === 'interactive' && !name && node.tag === 'a') name = textOf(node);
  name = squash(name);
  const extras: string[] = [];
  const haystack = [name];
  if (node.tag === 'a' && node.attrs.href !== undefined) {
    extras.push(`href=${node.attrs.href}`);
    haystack.push(node.attrs.href);
  }
  if (group === 'interactive' && (node.tag === 'input' || node.tag === 'textarea') && role === 'textbox') {
    extras.push(`value="${quote(clip(squash(node.attrs.value ?? ''), OUTLINE_VALUE_MAX))}"`);
  }
  if (group === 'interactive' && (role === 'checkbox' || role === 'radio') && 'checked' in node.attrs) extras.push('checked');
  const head = `[${ref}] ${role}`;
  const line = [head, ...(name ? [`"${quote(name)}"`] : []), ...extras].join(' ');
  return { line: clip(line, OUTLINE_LINE_MAX), haystack: haystack.join(' ').toLowerCase() };
}

/** The elements an outline keeps, in document order, with refs `e1`, `e2`, ... */
function collect(root: AnnotatedNode): Entry[] {
  const entries: Entry[] = [];
  const add = (node: AnnotatedNode, group: Group) => {
    const ref = `e${entries.length + 1}`;
    entries.push({ ref, node, group, ...render(ref, node, group) });
  };
  const walk = (node: AnnotatedNode, insideInteractive: boolean) => {
    const container = node.tag === 'html' || node.tag === 'body';
    if (!container && selfHidden(node)) return;
    const isInteractive = !container && interactive(node);
    if (isInteractive) add(node, 'interactive');
    else if (!container && isHeading(node)) add(node, 'heading');
    else if (!container && !insideInteractive && directText(node).length >= MIN_TEXT) add(node, 'text');
    // Text inside a link, button, or heading is already its name.
    const inside = insideInteractive || isInteractive || isHeading(node);
    for (const c of node.children) if (c.type === 'element') walk(c, inside);
  };
  walk(root, false);
  return entries;
}

/**
 * The outline of a page snapshot: one line per interactive element, heading,
 * and text-bearing element, in document order, each with a ref `e<n>` that is
 * the same on an unchanged page. Lines beyond `budgetTokens` are left out,
 * text first, then headings, then interactive elements, and a final line says
 * how many.
 */
export function buildOutline(tree: SerializedNode, budgetTokens: number, estimate: (text: string) => number): Outline {
  if (tree.type !== 'element') return emptyOutline();
  const entries = collect(annotate(tree as SerializedElement));
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
