import { dataset, render } from '@webscoop/playground';
import { JSDOM } from 'jsdom';
import type { SerializedElement, SerializedNode } from '../src';

/** Parse HTML into the serialized form `Session.snapshot` produces. */
export function snapshotFromHtml(html: string): SerializedElement {
  const { window } = new JSDOM(html);
  const walk = (node: Node): SerializedNode | null => {
    if (node.nodeType === window.Node.TEXT_NODE) return { type: 'text', text: node.textContent ?? '' };
    if (node.nodeType !== window.Node.ELEMENT_NODE) return null;
    const el = node as Element;
    const attrs: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) attrs[attr.name] = attr.value;
    const children: SerializedNode[] = [];
    for (const child of Array.from(el.childNodes)) {
      const out = walk(child);
      if (out) children.push(out);
    }
    return { type: 'element', tag: el.tagName.toLowerCase(), attrs, children };
  };
  return walk(window.document.documentElement) as SerializedElement;
}

/** The tier 0 catalog as a serialized snapshot. */
export function tier0Snapshot(opts: { sponsored?: number } = {}): SerializedElement {
  return snapshotFromHtml(render(dataset, { tier: 0, seed: 1, ...opts }));
}
