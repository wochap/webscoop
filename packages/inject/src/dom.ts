import { computeAccessibleName, getRole } from 'dom-accessibility-api';
import {
  collapseWhitespace,
  selectionOf,
  type AnnotatedNode,
  type Path,
  type ProtocolCandidate,
  type Selection,
  type SerializedElement,
  type SerializedNode,
} from '@webscoop/core/page';

/** Host elements the recorder adds to the page. They never appear in snapshots or paths. */
export const OWN_TAGS = new Set(['webscoop-root', 'webscoop-overlay', 'webscoop-drawer']);

export function isOwn(node: Node | null): boolean {
  for (let cur: Node | null = node; cur; cur = cur.parentNode ?? (cur as ShadowRoot).host ?? null) {
    if (cur.nodeType === 1 && OWN_TAGS.has((cur as Element).tagName.toLowerCase())) return true;
  }
  return false;
}

export function childElements(el: Element): Element[] {
  return Array.from(el.children).filter((c) => !OWN_TAGS.has(c.tagName.toLowerCase()));
}

/** Element-child indices from `<html>` to the element, skipping recorder hosts. */
export function pathOfElement(el: Element): Path {
  const path: number[] = [];
  const root = el.ownerDocument.documentElement;
  for (let cur: Element = el; cur !== root; ) {
    const parent = cur.parentElement;
    if (!parent) break;
    path.unshift(childElements(parent).indexOf(cur));
    cur = parent;
  }
  return path;
}

export function elementAt(path: readonly number[], doc: Document = document): Element | null {
  let cur: Element | undefined = doc.documentElement;
  for (const index of path) {
    cur = childElements(cur).at(index);
    if (!cur || index < 0) return null;
  }
  return cur ?? null;
}

const OPAQUE = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'canvas', 'video', 'audio']);
const NO_ROLE = new Set(['generic', 'none', 'presentation']);
/** Longest text node kept in a snapshot sent to the host. */
const MAX_TEXT = 300;

/** Picking an element inside an SVG or similar picks the outer element. */
export function pickable(el: Element): Element {
  let out = el;
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (OPAQUE.has(cur.tagName.toLowerCase())) out = cur;
  }
  return out;
}

export function roleOf(el: Element): string | undefined {
  try {
    const role = getRole(el);
    return role && !NO_ROLE.has(role) ? role : undefined;
  } catch {
    return undefined;
  }
}

export function nameOf(el: Element): string | undefined {
  try {
    const name = collapseWhitespace(computeAccessibleName(el));
    return name || undefined;
  } catch {
    return undefined;
  }
}

export function bboxOf(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
}

export interface PageTree {
  root: AnnotatedNode;
  nodeOf: Map<Element, AnnotatedNode>;
}

/** Annotate one element with role, accessible name, and geometry. */
export function annotateElement(node: AnnotatedNode, el: Element): void {
  const role = roleOf(el);
  if (role) node.role = role;
  const name = role ? nameOf(el) : undefined;
  if (name) node.name = name;
  node.bbox = bboxOf(el);
}

/**
 * Serialize the live document into annotated nodes. The picked element and
 * its ancestors get role, name, and bbox from the real DOM.
 */
export function readDocument(target: Element | null, doc: Document = document): PageTree {
  const nodeOf = new Map<Element, AnnotatedNode>();
  const visit = (el: Element, parent: AnnotatedNode | null): AnnotatedNode => {
    const attrs: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) attrs[attr.name] = attr.value;
    const node: AnnotatedNode = { type: 'element', tag: el.tagName.toLowerCase(), attrs, children: [], parent };
    nodeOf.set(el, node);
    if (OPAQUE.has(node.tag)) {
      // Keep the element children so paths stay aligned, but not their content.
      for (const child of Array.from(el.children)) {
        node.children.push({ type: 'element', tag: child.tagName.toLowerCase(), attrs: {}, children: [], parent: node });
      }
      return node;
    }
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) node.children.push({ type: 'text', text: child.textContent ?? '' });
      else if (child.nodeType === 1 && !OWN_TAGS.has((child as Element).tagName.toLowerCase())) {
        node.children.push(visit(child as Element, node));
      }
    }
    return node;
  };
  const root = visit(doc.documentElement, null);
  for (let cur: Element | null = target; cur; cur = cur.parentElement) {
    const node = nodeOf.get(cur);
    if (node) annotateElement(node, cur);
  }
  return { root, nodeOf };
}

/** JSON snapshot for the host: no parent links, long text nodes shortened. */
export function snapshotOf(node: AnnotatedNode): SerializedElement {
  const { parent: _parent, children, ...rest } = node;
  return {
    ...rest,
    children: children.map((c): SerializedNode =>
      c.type === 'text' ? { type: 'text', text: c.text.length > MAX_TEXT ? c.text.slice(0, MAX_TEXT) : c.text } : snapshotOf(c),
    ),
  } as SerializedElement;
}

function queryAll(selector: string, within: ParentNode): Element[] {
  try {
    return Array.from(within.querySelectorAll(selector)).filter((el) => !isOwn(el));
  } catch {
    return [];
  }
}

function cssString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Resolve a candidate in the page, for highlighting only. The host's counts
 * are authoritative; this mirrors them closely enough to draw boxes.
 */
export function resolveLocal(candidate: ProtocolCandidate, within?: Element, doc: Document = document): Element[] {
  const scope: ParentNode = within ?? doc;
  const { value } = candidate;
  switch (candidate.strategy) {
    case 'testid':
      return queryAll(`[data-testid=${cssString(value)}]`, scope);
    case 'id':
      return queryAll(`[id=${cssString(value)}]`, scope);
    case 'css':
      return queryAll(value, scope);
    case 'xpath': {
      const out: Element[] = [];
      try {
        const expr = within && value.startsWith('/') && !value.startsWith('//') ? `.${value}` : value;
        const result = doc.evaluate(expr, within ?? doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < result.snapshotLength; i++) {
          const node = result.snapshotItem(i);
          if (node && node.nodeType === 1 && !isOwn(node)) out.push(node as Element);
        }
      } catch {
        // Invalid expression: nothing to highlight.
      }
      return out;
    }
    case 'role': {
      const bar = value.indexOf('|');
      const role = bar === -1 ? value : value.slice(0, bar);
      const name = bar === -1 ? undefined : value.slice(bar + 1);
      return queryAll('*', scope).filter((el) => roleOf(el) === role && (name === undefined || nameOf(el) === name));
    }
    case 'text': {
      const wanted = collapseWhitespace(value);
      const hit = (el: Element) => collapseWhitespace(el.textContent ?? '') === wanted;
      return queryAll('*', scope).filter((el) => hit(el) && !Array.from(el.children).some(hit));
    }
  }
}

/** First candidate that resolves anything, like the runner's fallback order. */
export function resolveFirstLocal(candidates: readonly ProtocolCandidate[], doc: Document = document): Element[] {
  for (const c of candidates) {
    const found = resolveLocal(c, undefined, doc);
    if (found.length > 0) return found;
  }
  return [];
}

/** Build the `picker.select` payload for an element. */
export function describeSelection(
  el: Element,
  containers: readonly Element[],
  doc: Document = document,
): { selection: Selection; snapshot: SerializedElement } {
  const tree = readDocument(el, doc);
  const node = tree.nodeOf.get(el);
  if (!node) throw new Error('the element is not part of the document');
  const container = containers.find((c) => c === el || c.contains(el)) ?? null;
  const selection = selectionOf(node, { containerPath: container ? pathOfElement(container) : null });
  return { selection, snapshot: snapshotOf(tree.root) };
}

/** Short text for the hover tag and inspector. */
export function excerpt(el: Element, max = 40): string {
  const text = collapseWhitespace(el.textContent ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
