/**
 * How a `fill` step sets an element, decided in the page from the element
 * alone. Both functions run in the page as they are (Playwright serializes
 * them for `evaluate`), so they reference nothing outside their bodies.
 */
export const FILL_KINDS = ['file', 'toggle', 'radio', 'select', 'combobox', 'otp', 'text', 'none'] as const;

export type FillKind = (typeof FILL_KINDS)[number];

/** Kinds a `fill` step can set; `none` (a button, a link) can only open a file chooser. */
export const FILLABLE_KINDS: readonly FillKind[] = ['file', 'toggle', 'radio', 'select', 'combobox', 'otp', 'text'];

/**
 * The element's fill kind, in the steps capability's order: file input,
 * checkbox or switch (`toggle`), radio, native select, combobox, one-character
 * box (`otp`; a fill types into it only with a longer value), text-like.
 */
export function classifyFillElement(el: Element): FillKind {
  const tag = el.tagName.toLowerCase();
  const role = (el.getAttribute('role') ?? '').toLowerCase();
  const type = tag === 'input' ? ((el as HTMLInputElement).type || 'text').toLowerCase() : '';
  if (type === 'file') return 'file';
  if (type === 'checkbox' || role === 'checkbox' || role === 'switch') return 'toggle';
  if (type === 'radio' || role === 'radio') return 'radio';
  if (tag === 'select') return 'select';
  const autocomplete = (el.getAttribute('aria-autocomplete') ?? '').toLowerCase();
  if (role === 'combobox' || (tag === 'input' && ((autocomplete !== '' && autocomplete !== 'none') || el.hasAttribute('list')))) return 'combobox';
  const nonText = ['button', 'submit', 'reset', 'image', 'hidden', 'range', 'color'];
  if (tag === 'input' && nonText.includes(type)) return 'none';
  if (tag === 'input' && el.getAttribute('maxlength') === '1') return 'otp';
  const editable = (el as HTMLElement).isContentEditable || ['', 'true', 'plaintext-only'].includes(el.getAttribute('contenteditable') ?? 'false');
  if (tag === 'input' || tag === 'textarea' || editable || role === 'textbox') return 'text';
  return 'none';
}

/**
 * What a fill of the element would set now, as the recorder prefills it:
 * typed text, the chosen option's label (one per line for a multiple select),
 * `true` or `false`, the combobox's shown text, or the joined characters of
 * the one-character boxes next to it. Empty for a file input or other element.
 */
export function currentFillValue(el: Element, kind: string): string {
  const input = el as HTMLInputElement;
  switch (kind) {
    case 'toggle':
    case 'radio':
      if (el.tagName.toLowerCase() === 'input') return input.checked ? 'true' : 'false';
      return el.getAttribute('aria-checked') === 'true' ? 'true' : 'false';
    case 'select':
      return Array.from((el as HTMLSelectElement).selectedOptions)
        .map((o) => (o.label || o.textContent || '').trim())
        .join('\n');
    case 'combobox':
      return 'value' in el && typeof input.value === 'string' ? input.value : (el.textContent ?? '').trim();
    case 'otp': {
      // The boxes are the one-character inputs of the nearest ancestor holding several.
      let scope: Element | null = el.parentElement;
      for (let depth = 0; scope && depth < 4; depth++, scope = scope.parentElement) {
        const boxes = Array.from(scope.querySelectorAll('input[maxlength="1"]')) as HTMLInputElement[];
        if (boxes.length > 1) return boxes.slice(boxes.indexOf(input)).map((b) => b.value).join('');
      }
      return input.value;
    }
    case 'text':
      if (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea') return input.value;
      return (el.textContent ?? '').trim();
    default:
      return '';
  }
}
