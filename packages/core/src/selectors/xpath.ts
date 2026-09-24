import type { ElementRef, Session } from '../ports';
import { ancestorsOf, siblingsOf, type AnnotatedNode } from './annotated';

const FOREIGN = new Set(['svg', 'math']);
const PLAIN = /^[a-z][a-z0-9]*$/;

/** Name test for one step; elements outside the HTML namespace match only by local name. */
function nameTest(node: AnnotatedNode): string {
  const foreign = FOREIGN.has(node.tag) || ancestorsOf(node).some((a) => FOREIGN.has(a.tag));
  return foreign || !PLAIN.test(node.tag) ? `*[local-name()='${node.tag.replace(/'/g, '')}']` : node.tag;
}

function step(node: AnnotatedNode): string {
  const sameTag = siblingsOf(node).filter((s) => s.tag === node.tag);
  return `${nameTest(node)}[${node.parent ? sameTag.indexOf(node) + 1 : 1}]`;
}

/**
 * Positional XPath of a node in an annotated tree, built from the root down:
 * `/html[1]/body[1]/main[1]/...` when the tree is a whole document, else
 * relative to the tree's root (`./li[3]/article[1]`), which `Session.resolve`
 * evaluates inside the element the tree was taken from.
 */
export function xpathFor(node: AnnotatedNode): string {
  const chain = [node, ...ancestorsOf(node)].reverse();
  const root = chain[0]!;
  if (root.tag === 'html') return `/${chain.map(step).join('/')}`;
  if (chain.length === 1) return '.';
  return `./${chain.slice(1).map(step).join('/')}`;
}

/** The live element a snapshot node stands for, through its positional XPath. */
export async function refForNode(session: Session, node: AnnotatedNode, within?: ElementRef): Promise<ElementRef | null> {
  const value = xpathFor(node);
  if (value === '.') return within ?? null;
  const [ref] = await session.resolve({ strategy: 'xpath', value, stability: 'fragile' }, within);
  return ref ?? null;
}
