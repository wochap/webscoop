import { classifyFillElement } from '../fill-kind';

/**
 * Functions an exported script evaluates in the page, serialized from here so
 * both preludes act on elements exactly as the runner's browser adapter does.
 * Each one references nothing outside its body: it runs as its source text.
 */

/** Whether a checkbox, switch, or radio is checked now. */
function isChecked(el: Element): boolean {
  return el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true';
}

/** The option values a select gets: by value first, then by visible label; for a multiple select, one option per line. */
function selectValues(el: Element, wanted: string): { values: string[] } | { missing: string } {
  const select = el as HTMLSelectElement;
  const options = Array.from(select.options ?? []);
  const want = select.multiple ? wanted.split('\n').filter((w) => w !== '') : [wanted];
  const values: string[] = [];
  for (const w of want) {
    const hit = options.find((o) => o.value === w) ?? options.find((o) => o.label.trim() === w || o.text.trim() === w);
    if (!hit) return { missing: w };
    values.push(hit.value);
  }
  return { values };
}

/** Whether a combobox takes typed text itself. */
function isEditable(el: Element): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable;
}

/** The value a text fill reads back. */
function readBack(el: Element): string {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? '');
}

/** Whether an element is a same-origin iframe whose document can be reached. */
function frameReachable(el: Element): boolean {
  if (!(el instanceof HTMLIFrameElement)) return false;
  try {
    return el.contentDocument !== null;
  } catch {
    return false;
  }
}

/** Whether a next or load-more control is disabled: `disabled`, `aria-disabled="true"`, or an anchor without `href`. */
function isDisabled(el: Element): boolean {
  return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || (el.tagName.toLowerCase() === 'a' && !el.hasAttribute('href'));
}

/** For each item container, whether it is one of the excluded elements. */
function excludedMask(els: Element[], others: Node[]): boolean[] {
  return els.map((el) => others.includes(el));
}

/** Resolves after the next animation frame, so hover handlers have run. */
function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/** Scroll the window to the bottom of the document. */
function scrollToBottom(): void {
  window.scrollTo(0, document.documentElement.scrollHeight);
}

/** A URL resolved against a base, or the raw text when it is not one. */
function resolveUrl([raw, base]: [string, string]): string {
  try {
    return new URL(raw, base).href;
  } catch {
    return raw;
  }
}

/** A URL with one query parameter set. */
function setQueryParam([href, name, value]: [string, string, string]): string {
  const url = new URL(href);
  url.searchParams.set(name, value);
  return url.href;
}

const HELPERS = {
  classifyFill: classifyFillElement,
  isChecked,
  selectValues,
  isEditable,
  readBack,
  frameReachable,
  isDisabled,
  excludedMask,
  nextFrame,
  scrollToBottom,
  resolveUrl,
  setQueryParam,
} as const;

export type PageHelperName = keyof typeof HELPERS;

/** Every page helper's source text, by name, as the exported scripts embed it. */
export const PAGE_HELPERS: Readonly<Record<PageHelperName, string>> = Object.fromEntries(
  Object.entries(HELPERS).map(([name, fn]) => [name, fn.toString()]),
) as Record<PageHelperName, string>;
