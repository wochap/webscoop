import type { SerializedElement, SerializedNode, SerializedText } from '../ports';
import { implicitRole, normalize, textContent } from './aria';

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A serialized element with the data selector generation needs: accessible
 * role and name, geometry, and a link to its parent. Every `SerializedElement`
 * is a valid `AnnotatedNode` without annotations.
 */
export interface AnnotatedNode extends SerializedElement {
  role?: string;
  name?: string;
  bbox?: BBox;
  parent?: AnnotatedNode | null;
  children: (AnnotatedNode | SerializedText)[];
}

/** Roles whose accessible name comes from their content. */
const NAME_FROM_CONTENT = new Set([
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'heading',
  'link',
  'menuitem',
  'option',
  'radio',
  'row',
  'tab',
  'tooltip',
  'treeitem',
]);

/** Simplified accessible name for a role, or undefined when the element has none. */
export function nameFor(el: SerializedElement, role: string | null): string | undefined {
  const label = el.attrs['aria-label'];
  if (label && normalize(label)) return normalize(label);
  if (el.tag === 'img') return el.attrs.alt ? normalize(el.attrs.alt) : undefined;
  if (el.tag === 'input') {
    const value = el.attrs.value ?? el.attrs.placeholder;
    return value ? normalize(value) : undefined;
  }
  if (role && NAME_FROM_CONTENT.has(role)) {
    const text = normalize(textContent(el));
    return text || undefined;
  }
  return undefined;
}

export interface AnnotateOptions {
  /** Compute role and name where the input does not carry them. Default true. */
  roles?: boolean;
}

/**
 * Copy a serialized tree into annotated nodes with parent links. Role, name,
 * and bbox already present on the input (for example sent by the page) are
 * kept; missing roles and names are computed with the simplified rules.
 */
export function annotate(root: SerializedElement, opts: AnnotateOptions = {}): AnnotatedNode {
  const roles = opts.roles ?? true;
  const visit = (el: SerializedElement & Partial<AnnotatedNode>, parent: AnnotatedNode | null): AnnotatedNode => {
    const node: AnnotatedNode = { type: 'element', tag: el.tag, attrs: { ...el.attrs }, children: [], parent };
    const role = el.role ?? (roles ? implicitRole(el) ?? undefined : undefined);
    if (role !== undefined) node.role = role;
    const name = el.name ?? (roles && el.role === undefined ? nameFor(el, role ?? null) : undefined);
    if (name !== undefined) node.name = name;
    if (el.bbox) node.bbox = { ...el.bbox };
    for (const child of el.children as SerializedNode[]) {
      node.children.push(child.type === 'text' ? { type: 'text', text: child.text } : visit(child, node));
    }
    return node;
  };
  return visit(root, null);
}

export function elementChildren(node: AnnotatedNode): AnnotatedNode[] {
  return node.children.filter((c): c is AnnotatedNode => c.type === 'element');
}

/** Element siblings including the node itself, in document order. */
export function siblingsOf(node: AnnotatedNode): AnnotatedNode[] {
  return node.parent ? elementChildren(node.parent) : [node];
}

/** Ancestors from the parent up to the root. */
export function ancestorsOf(node: AnnotatedNode): AnnotatedNode[] {
  const out: AnnotatedNode[] = [];
  for (let p = node.parent; p; p = p.parent) out.push(p);
  return out;
}

/** Element-child indices from the root to the node. */
export function pathOf(node: AnnotatedNode): number[] {
  const path: number[] = [];
  for (let cur = node; cur.parent; cur = cur.parent) path.unshift(elementChildren(cur.parent).indexOf(cur));
  return path;
}

export function nodeAt(root: AnnotatedNode, path: readonly number[]): AnnotatedNode | null {
  let cur: AnnotatedNode | undefined = root;
  for (const index of path) {
    cur = elementChildren(cur).at(index);
    if (!cur || index < 0) return null;
  }
  return cur;
}

/** All elements under and including the root, in document order. */
export function descendantsOf(root: AnnotatedNode): AnnotatedNode[] {
  const out: AnnotatedNode[] = [];
  const walk = (n: AnnotatedNode) => {
    out.push(n);
    elementChildren(n).forEach(walk);
  };
  walk(root);
  return out;
}

/** Plain JSON form: drops parent links so the tree can cross the page bridge. */
export function detach(node: AnnotatedNode): SerializedElement {
  const { parent: _parent, children, ...rest } = node;
  return {
    ...rest,
    children: children.map((c) => (c.type === 'text' ? c : detach(c))),
  } as SerializedElement;
}
