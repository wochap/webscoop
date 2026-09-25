import { descendantsOf, elementChildren, type AnnotatedNode } from './annotated';
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
  /** Every element on the container's level under the list parent, similar or not, in document order. */
  all: AnnotatedNode[];
  /** Elements in `all` left out as dissimilar. */
  skipped: AnnotatedNode[];
  /** The list parent the items were found under, or null when that is the document body. */
  within: AnnotatedNode | null;
  broader: ItemLevel | null;
  narrower: ItemLevel | null;
}

export interface InferOptions {
  /** Fix the list parent: items are searched under this element only. */
  within?: AnnotatedNode;
  /** Fix the item level as well (an ancestor-or-self of the picked element below `within`). */
  item?: AnnotatedNode;
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

/** Mean of multisets, key by key. */
function centroid(bags: readonly Map<string, number>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const bag of bags) for (const [key, n] of bag) out.set(key, (out.get(key) ?? 0) + n);
  for (const [key, n] of out) out.set(key, n / Math.max(1, bags.length));
  return out;
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

/** Most ancestors tried as list parent. */
const MAX_LIST_DEPTH = 12;
/** List parents with a larger subtree are skipped, for huge pages. */
const MAX_LIST_SIZE = 5000;

function depthOf(node: AnnotatedNode): number {
  let depth = 0;
  for (let cur = node.parent; cur; cur = cur.parent) depth++;
  return depth;
}

/** Tags from below the list parent down to the item, inclusive. */
function tagPath(list: AnnotatedNode, item: AnnotatedNode): string[] {
  const tags: string[] = [];
  for (let cur: AnnotatedNode | null | undefined = item; cur && cur !== list; cur = cur.parent) tags.unshift(cur.tag);
  return tags;
}

/** Every descendant of `list` reached by the same tag path as `item`, whatever the positions, in document order. */
function rawGroup(list: AnnotatedNode, item: AnnotatedNode): AnnotatedNode[] {
  let level = [list];
  for (const tag of tagPath(list, item)) level = level.flatMap((n) => elementChildren(n).filter((c) => c.tag === tag));
  return level;
}

/**
 * Members of the raw group whose child tags are similar to the group's
 * centroid. When the item itself falls out, the centroid is taken again over
 * the kept members plus the item, and the group filtered once more. The item
 * is always kept.
 */
function similarMembers(raw: readonly AnnotatedNode[], item: AnnotatedNode): AnnotatedNode[] {
  const bags = new Map(raw.map((n) => [n, childTags(n)]));
  const filter = (center: Map<string, number>) => raw.filter((n) => n === item || jaccard(bags.get(n)!, center) >= SIMILARITY_THRESHOLD);
  const first = raw.filter((n) => jaccard(bags.get(n)!, centroid([...bags.values()])) >= SIMILARITY_THRESHOLD);
  if (first.includes(item)) return first;
  return filter(centroid([...first, item].map((n) => bags.get(n)!)));
}

interface Found {
  list: AnnotatedNode;
  item: AnnotatedNode;
  raw: AnnotatedNode[];
  kept: AnnotatedNode[];
  /** Whether most kept members hold a counterpart of the pick: same tag path below the item, same compound. */
  covers: boolean;
}

/** Share of kept members below which a level does not hold the pick's counterpart in most items. */
const COVERAGE = 0.75;

/** Whether `member` holds an element on the same tag path as `pick` below `item`, with the pick's compound. */
function holdsCounterpart(member: AnnotatedNode, path: readonly string[], compound: string): boolean {
  let level = [member];
  for (const tag of path) level = level.flatMap((n) => elementChildren(n).filter((c) => c.tag === tag));
  return level.some((n) => compoundOf(n) === compound);
}

function groupOf(list: AnnotatedNode, item: AnnotatedNode, pick: AnnotatedNode = item): Found {
  const raw = rawGroup(list, item);
  const kept = similarMembers(raw, item);
  const path = tagPath(item, pick);
  const compound = compoundOf(pick);
  const covered = pick === item ? kept.length : kept.filter((m) => holdsCounterpart(m, path, compound)).length;
  return { list, item, raw, kept, covers: covered >= kept.length * COVERAGE };
}

/**
 * Item levels tried under one list parent: ancestors-or-self of the pick
 * below it. The pick itself and inline parts (links, headings, text) only
 * repeat as direct children of the list parent, so a title is never taken
 * for an item because every card has one.
 */
function itemsUnder(list: AnnotatedNode, node: AnnotatedNode): AnnotatedNode[] {
  const out: AnnotatedNode[] = [];
  for (let cur: AnnotatedNode | null | undefined = node; cur && cur !== list; cur = cur.parent) {
    if ((cur === node || INNER.has(cur.tag)) && cur.parent !== list) continue;
    out.push(cur);
  }
  return out;
}

/**
 * Levels whose items mostly hold a counterpart of the pick first (so two
 * parts of one item are not taken for two items), then most kept items,
 * then the shallowest item, then the nearest list parent.
 */
function better(a: Found, b: Found | null): boolean {
  if (!b) return true;
  if (a.covers !== b.covers) return a.covers;
  if (a.kept.length !== b.kept.length) return a.kept.length > b.kept.length;
  const da = depthOf(a.item);
  const db = depthOf(b.item);
  if (da !== db) return da < db;
  return depthOf(a.list) > depthOf(b.list);
}

function search(node: AnnotatedNode, lists: readonly AnnotatedNode[], min: number): Found | null {
  let best: Found | null = null;
  for (const list of lists) {
    for (const item of itemsUnder(list, node)) {
      const found = groupOf(list, item, node);
      if (found.kept.length >= min && better(found, best)) best = found;
    }
  }
  return best;
}

function isTop(node: AnnotatedNode): boolean {
  return TOP.has(node.tag);
}

/**
 * Find the repeating structure the picked element belongs to: a list parent
 * L (an ancestor, never `body`) and an item level I (an ancestor-or-self of
 * the pick below L) whose items are every descendant of L on the same tag
 * path as I, similar to the group's centroid. The pair with the most items
 * (at least 3) wins, preferring the shallowest item and then the nearest list
 * parent. Items that are direct children of `body` are found with no list
 * parent. Single-child block wrappers below the item are descended into, so
 * `li > article` proposes the `article`. Never proposes `body` or `html`.
 * Returns null when nothing repeats.
 *
 * With `opts.within`, only that list parent is tried and one item suffices;
 * with `opts.item` too, the item level is fixed and not descended from.
 */
export function inferItems(node: AnnotatedNode, opts: InferOptions = {}): ItemProposal | null {
  let found: Found | null;
  if (opts.within && opts.item) {
    if (!isAncestorOrSelf(opts.item, node) || opts.item === opts.within || !isAncestorOrSelf(opts.within, opts.item)) return null;
    found = groupOf(opts.within, opts.item);
  } else if (opts.within) {
    if (opts.within === node || !isAncestorOrSelf(opts.within, node)) return null;
    found = search(node, [opts.within], 1);
  } else {
    const lists: AnnotatedNode[] = [];
    for (let cur = node.parent; cur && !isTop(cur) && lists.length < MAX_LIST_DEPTH; cur = cur.parent) {
      if (descendantsOf(cur).length <= MAX_LIST_SIZE) lists.push(cur);
    }
    found = search(node, lists, 3);
    if (!found && !isTop(node)) {
      // Items straight under body: the sibling rule, with no list parent.
      let top: AnnotatedNode = node;
      while (top.parent && !isTop(top.parent)) top = top.parent;
      if (top.parent?.tag === 'body' && (top === node || !INNER.has(top.tag))) {
        const group = groupOf(top.parent, top);
        if (group.kept.length >= 3) found = group;
      }
    }
  }
  if (!found) return null;

  const repeating: ItemLevel = { node: found.item, items: found.kept };
  const chain: ItemLevel[] = [repeating];
  let all = found.raw;
  for (;;) {
    if (opts.item) break;
    const level = chain.at(-1)!;
    const children = elementChildren(level.node);
    const only = children[0];
    if (children.length !== 1 || !only || only === node || INNER.has(only.tag) || !isAncestorOrSelf(only, node)) break;
    const below = levelBelow(level, only);
    if (below.items.length !== level.items.length) break;
    chain.push(below);
    all = levelBelow({ node: level.node, items: all }, only).items;
  }
  const container = chain.at(-1)!;

  let broader: ItemLevel | null = chain.length > 1 ? chain.at(-2)! : null;
  if (!broader) {
    const parent = found.item.parent;
    if (parent && parent !== found.list && !isTop(parent)) {
      const group = groupOf(found.list, parent);
      if (group.kept.length >= 2) broader = { node: parent, items: group.kept };
    } else if (parent && parent.parent && !isTop(parent)) {
      const group = groupOf(parent.parent, parent);
      if (group.kept.length >= 2) broader = { node: parent, items: group.kept };
    }
  }

  let narrower: ItemLevel | null = null;
  const towards = elementChildren(container.node).find((c) => c !== node && isAncestorOrSelf(c, node));
  if (towards) {
    const level = levelBelow(container, towards);
    if (level.items.length > 0) narrower = level;
  }

  const kept = new Set(container.items);
  return {
    container: container.node,
    siblings: container.items,
    all,
    skipped: all.filter((n) => !kept.has(n)),
    within: isTop(found.list) ? null : found.list,
    broader,
    narrower,
  };
}
