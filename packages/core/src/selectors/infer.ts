import { elementChildren, siblingsOf, type AnnotatedNode } from './annotated';
import { compoundOf } from './generate';

/** Minimum child-structure similarity for two siblings to count as the same kind of item. */
export const SIMILARITY_THRESHOLD = 0.6;

/** One candidate container level: a representative element and every matching item. */
export interface ItemLevel {
  node: AnnotatedNode;
  /** Every item at this level, in document order, including `node`. */
  items: AnnotatedNode[];
}

export interface ItemProposal {
  /** The proposed item container: the one that holds the picked element. */
  container: AnnotatedNode;
  /** Every item like the container, in document order, including the container. */
  siblings: AnnotatedNode[];
  broader: ItemLevel | null;
  narrower: ItemLevel | null;
}

/** Multiset of descendant tags to depth 2, keyed by depth. */
function childTags(node: AnnotatedNode): Map<string, number> {
  const bag = new Map<string, number>();
  const add = (key: string) => bag.set(key, (bag.get(key) ?? 0) + 1);
  for (const child of elementChildren(node)) {
    add(`1:${child.tag}`);
    for (const grandchild of elementChildren(child)) add(`2:${grandchild.tag}`);
  }
  return bag;
}

/** Weighted Jaccard similarity of two multisets; two empty sets are identical. */
export function jaccard(a: Map<string, number>, b: Map<string, number>): number {
  let min = 0;
  let max = 0;
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key) ?? 0;
    const y = b.get(key) ?? 0;
    min += Math.min(x, y);
    max += Math.max(x, y);
  }
  return max === 0 ? 1 : min / max;
}

export function similarity(a: AnnotatedNode, b: AnnotatedNode): number {
  if (a.tag !== b.tag) return 0;
  return jaccard(childTags(a), childTags(b));
}

const TOP = new Set(['html', 'body', 'head']);
/** Wrappers the proposal may descend into; links, headings, and inline text are item parts, not items. */
const INNER = new Set([
  'a',
  'button',
  'label',
  'span',
  'strong',
  'em',
  'b',
  'i',
  'small',
  'img',
  'picture',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

function isAncestorOrSelf(ancestor: AnnotatedNode, node: AnnotatedNode): boolean {
  for (let cur: AnnotatedNode | null | undefined = node; cur; cur = cur.parent) if (cur === ancestor) return true;
  return false;
}

function similarGroup(node: AnnotatedNode): AnnotatedNode[] {
  return siblingsOf(node).filter((s) => s === node || similarity(s, node) >= SIMILARITY_THRESHOLD);
}

/** The child of `item` that plays the role `model` plays in its own item: same compound, else same tag. */
function counterpart(item: AnnotatedNode, model: AnnotatedNode): AnnotatedNode | undefined {
  const compound = compoundOf(model);
  const children = elementChildren(item);
  return children.find((c) => compoundOf(c) === compound) ?? children.find((c) => c.tag === model.tag);
}

function levelBelow(level: ItemLevel, child: AnnotatedNode): ItemLevel {
  const items = level.items.map((item) => (item === level.node ? child : counterpart(item, child))).filter((n): n is AnnotatedNode => !!n);
  return { node: child, items };
}

/**
 * Find the repeating structure the picked element belongs to: the nearest
 * ancestor-or-self with at least two similar siblings (same tag, child-tag
 * similarity at or above the threshold). Single-child block wrappers below it
 * are descended into, so `li > article` proposes the `article`. Never
 * proposes `body` or `html`. Returns null when nothing repeats.
 */
export function inferItems(node: AnnotatedNode): ItemProposal | null {
  let repeating: ItemLevel | null = null;
  for (let cur: AnnotatedNode | null | undefined = node; cur && cur.parent && !TOP.has(cur.tag); cur = cur.parent) {
    const group = similarGroup(cur);
    if (group.length >= 3) {
      repeating = { node: cur, items: group };
      break;
    }
  }
  if (!repeating) return null;

  const chain: ItemLevel[] = [repeating];
  for (;;) {
    const level = chain.at(-1)!;
    const children = elementChildren(level.node);
    const only = children[0];
    if (children.length !== 1 || !only || only === node || INNER.has(only.tag) || !isAncestorOrSelf(only, node)) break;
    const below = levelBelow(level, only);
    if (below.items.length !== level.items.length) break;
    chain.push(below);
  }
  const container = chain.at(-1)!;

  let broader: ItemLevel | null = chain.length > 1 ? chain.at(-2)! : null;
  if (!broader) {
    const parent = repeating.node.parent;
    if (parent && parent.parent && !TOP.has(parent.tag)) {
      const group = similarGroup(parent);
      if (group.length >= 2) broader = { node: parent, items: group };
    }
  }

  let narrower: ItemLevel | null = null;
  const towards = elementChildren(container.node).find((c) => c !== node && isAncestorOrSelf(c, node));
  if (towards) {
    const level = levelBelow(container, towards);
    if (level.items.length > 0) narrower = level;
  }

  return { container: container.node, siblings: container.items, broader, narrower };
}
