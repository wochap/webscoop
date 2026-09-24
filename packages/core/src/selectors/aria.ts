import type { SerializedElement } from '../ports';

const HIDDEN = new Set(['script', 'style', 'noscript', 'template', 'head']);

export function textContent(el: SerializedElement): string {
  let text = '';
  for (const child of el.children) {
    if (child.type === 'text') text += child.text;
    else if (!HIDDEN.has(child.tag)) text += textContent(child);
  }
  return text;
}

export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Implicit ARIA role for the common elements; explicit `role` wins. */
export function implicitRole(el: SerializedElement): string | null {
  const { tag, attrs } = el;
  if (attrs.role) return attrs.role.split(/\s+/)[0]!;
  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'a':
      return 'href' in attrs ? 'link' : null;
    case 'button':
      return 'button';
    case 'img':
      return attrs.alt === '' ? 'presentation' : 'img';
    case 'ul':
    case 'ol':
      return 'list';
    case 'li':
      return 'listitem';
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'article':
      return 'article';
    case 'form':
      return 'form';
    case 'table':
      return 'table';
    case 'tr':
      return 'row';
    case 'td':
      return 'cell';
    case 'th':
      return 'columnheader';
    case 'p':
      return 'paragraph';
    case 'section':
      return 'aria-label' in attrs ? 'region' : null;
    case 'input': {
      const type = attrs.type ?? 'text';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      return 'textbox';
    }
    default:
      return null;
  }
}

/** Accessible name, simplified: aria-label, img alt, then text content. */
export function simpleAccessibleName(el: SerializedElement): string {
  const { tag, attrs } = el;
  if (attrs['aria-label']) return normalize(attrs['aria-label']);
  if (tag === 'img') return normalize(attrs.alt ?? '');
  if (tag === 'input') return normalize(attrs.value ?? attrs.placeholder ?? '');
  return normalize(textContent(el));
}
