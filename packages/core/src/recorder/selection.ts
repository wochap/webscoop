import { ancestorsOf, pathOf, type AnnotatedNode } from '../selectors/annotated';
import { normalize, textContent } from '../selectors/aria';
import { fingerprint } from '../selectors/fingerprint';
import { generate } from '../selectors/generate';
import type { Crumb, Path, Selection } from './protocol';

/** Breadcrumb label: role when present, else tag, plus the first class. */
export function crumbLabel(node: AnnotatedNode): string {
  const cls = (node.attrs.class ?? '').split(/\s+/).find(Boolean);
  return `${node.role ?? node.tag}${cls ? `.${cls}` : ''}`;
}

/** Ancestors from `body` down to the node itself. */
export function breadcrumb(node: AnnotatedNode): Crumb[] {
  const chain = [node, ...ancestorsOf(node)].reverse();
  const body = chain.findIndex((n) => n.tag === 'body');
  return chain.slice(body === -1 ? 0 : body).map((n) => ({ label: crumbLabel(n), path: pathOf(n) }));
}

/**
 * What the page sends about a picked element: generated candidates, the
 * fingerprint, the breadcrumb, and the containing item when one is known.
 */
export function selectionOf(node: AnnotatedNode, opts: { containerPath?: Path | null } = {}): Selection {
  return {
    path: pathOf(node),
    tag: node.tag,
    ...(node.role ? { role: node.role } : {}),
    ...(node.name ? { name: node.name } : {}),
    text: normalize(textContent(node)).slice(0, 200),
    attrs: { ...node.attrs },
    candidates: generate(node),
    fingerprint: fingerprint(node),
    ancestors: breadcrumb(node),
    containerPath: opts.containerPath ?? null,
  };
}
