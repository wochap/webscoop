import type { Fingerprint } from '../recipe/schema';
import { ancestorsOf, type AnnotatedNode } from './annotated';
import { normalize, textContent } from './aria';
import { classifyToken } from './tokens';

const ALLOWED = new Set(['id', 'data-testid', 'name', 'type', 'href', 'alt', 'title']);

function stableAttrs(node: AnnotatedNode): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const name of Object.keys(node.attrs).sort()) {
    const value = node.attrs[name]!;
    if (!ALLOWED.has(name) && !name.startsWith('aria-')) continue;
    if (name === 'href') {
      attrs.href = value.replace(/\d/g, '#');
      continue;
    }
    if ((name === 'id' || name === 'data-testid') && classifyToken(value) === 'hashed') continue;
    attrs[name] = value;
  }
  return attrs;
}

/**
 * What the element looked like at capture time, for healing: tag, role and
 * name, a text sample, stable attributes, the nearest 6 ancestors, and the
 * bounding box in CSS pixels.
 */
export function fingerprint(node: AnnotatedNode): Fingerprint {
  return {
    tag: node.tag,
    ...(node.role ? { role: node.role } : {}),
    ...(node.name ? { name: node.name } : {}),
    textSample: normalize(textContent(node)).slice(0, 80),
    attrs: stableAttrs(node),
    ancestors: ancestorsOf(node)
      .slice(0, 6)
      .map((a) => a.role ?? a.tag),
    bbox: node.bbox ? { ...node.bbox } : { x: 0, y: 0, w: 0, h: 0 },
  };
}
