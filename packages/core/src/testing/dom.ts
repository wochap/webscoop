import type { SerializedElement, SerializedNode } from '../ports';
import { implicitRole, normalize, simpleAccessibleName, textContent } from '../selectors/aria';

export { normalize, textContent };

type Child = SerializedNode | string | null | undefined | false | Child[];

/** Build a serialized element: `h('li', { class: 'card' }, h('h2', {}, 'Title'))`. */
export function h(tag: string, attrs: Record<string, string | undefined> = {}, ...children: Child[]): SerializedElement {
  const cleanAttrs: Record<string, string> = {};
  for (const [name, value] of Object.entries(attrs)) if (value !== undefined) cleanAttrs[name] = value;
  const flat: SerializedNode[] = [];
  const push = (child: Child) => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) child.forEach(push);
    else if (typeof child === 'string') flat.push({ type: 'text', text: child });
    else flat.push(child);
  };
  children.forEach(push);
  return { type: 'element', tag: tag.toLowerCase(), attrs: cleanAttrs, children: flat };
}

/** Element with parent links, used by the matchers. */
export interface DomNode {
  el: SerializedElement;
  parent: DomNode | null;
  children: DomNode[];
  /** Position in document order. */
  order: number;
}

export function indexTree(root: SerializedElement): { root: DomNode; all: DomNode[] } {
  const all: DomNode[] = [];
  const visit = (el: SerializedElement, parent: DomNode | null): DomNode => {
    const node: DomNode = { el, parent, children: [], order: all.length };
    all.push(node);
    for (const child of el.children) if (child.type === 'element') node.children.push(visit(child, node));
    return node;
  };
  return { root: visit(root, null), all };
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export function outerHtml(node: SerializedNode): string {
  if (node.type === 'text') return escapeText(node.text);
  const attrs = Object.entries(node.attrs)
    .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`)
    .join('');
  if (VOID.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${innerHtml(node)}</${node.tag}>`;
}

export function innerHtml(el: SerializedElement): string {
  return el.children.map(outerHtml).join('');
}

/** Implicit ARIA role for the common elements; explicit `role` wins. */
export function roleOf(node: DomNode): string | null {
  return implicitRole(node.el);
}

/** Accessible name, simplified: aria-label, img alt, then text content. */
export function accessibleName(node: DomNode): string {
  return simpleAccessibleName(node.el);
}
