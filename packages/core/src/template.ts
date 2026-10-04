import type { RecipeVar } from './recipe/schema';

/** A `{name}` or reserved `{+name}` variable: group 1 is the `+`, group 2 the name. */
export const VARIABLE = /\{(\+?)([A-Za-z_][A-Za-z0-9_]*)\}/g;

const RESERVED_SAFE = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]/;

/**
 * Reserved encoding (RFC 6570 `{+name}`): keep unreserved and reserved
 * characters and valid `%XX` escapes, percent-encode everything else as UTF-8.
 */
export function encodeReserved(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; ) {
    if (value[i] === '%' && /^%[0-9A-Fa-f]{2}/.test(value.slice(i, i + 3))) {
      out += value.slice(i, i + 3);
      i += 3;
      continue;
    }
    const ch = String.fromCodePoint(value.codePointAt(i)!);
    out += RESERVED_SAFE.test(ch) ? ch : encodeURIComponent(ch);
    i += ch.length;
  }
  return out;
}

/** Encode a value for a `{+name}` (reserved) or `{name}` occurrence. */
export function encodeFor(reserved: boolean, value: string): string {
  return reserved ? encodeReserved(value) : encodeURIComponent(value);
}

/** Names of the `{name}` and `{+name}` variables used in a URL template, in order of first use. */
export function templateVariables(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(VARIABLE)) {
    const name = match[2]!;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export class MissingVariableError extends Error {
  constructor(readonly names: string[]) {
    super(`missing value for variable${names.length > 1 ? 's' : ''} ${names.join(', ')}`);
    this.name = 'MissingVariableError';
  }
}

/**
 * Replace every `{name}` in the template with the URL-encoded value, taken from
 * `values` first and the declared default second.
 */
export function fillTemplate(
  template: string,
  vars: readonly RecipeVar[],
  values: Readonly<Record<string, string>> = {},
): string {
  const resolved = new Map<string, string>();
  const missing: string[] = [];
  for (const name of templateVariables(template)) {
    const value = values[name] ?? vars.find((v) => v.name === name)?.default;
    if (value === undefined) missing.push(name);
    else resolved.set(name, value);
  }
  if (missing.length > 0) throw new MissingVariableError(missing);
  return template.replace(VARIABLE, (_, plus: string, name: string) => encodeFor(plus === '+', resolved.get(name)!));
}

/**
 * Replace every `{name}` in a step value with the raw value, taken from
 * `values` first and the declared default second. Unlike `fillTemplate`
 * nothing is encoded: the text is typed, not put in a URL.
 */
export function fillText(template: string, vars: readonly RecipeVar[], values: Readonly<Record<string, string>> = {}): string {
  const missing = templateVariables(template).filter((name) => (values[name] ?? vars.find((v) => v.name === name)?.default) === undefined);
  if (missing.length > 0) throw new MissingVariableError(missing);
  return template.replace(VARIABLE, (_, _plus: string, name: string) => values[name] ?? vars.find((v) => v.name === name)!.default!);
}

/** A valid variable name: a letter or underscore, then letters, digits, or underscores. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Why a URL template cannot be opened, or null: a brace outside a `{name}`
 * variable, or not an absolute http(s) URL once its variables are filled.
 * The CLI and the recorder share this rule and its messages.
 */
export function templateProblem(template: string): string | null {
  // A digit is valid wherever a variable may sit: host, port, path, or query.
  const stripped = template.replace(VARIABLE, '1');
  const brace = stripped.search(/[{}]/);
  if (brace !== -1) return `invalid URL template "${template}": unmatched "${stripped[brace]}" (variables look like {name} or {+name})`;
  let url: URL;
  try {
    url = new URL(stripped);
  } catch {
    return `invalid URL template "${template}": not an absolute URL`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `invalid URL template "${template}": only http and https pages can be recorded`;
  }
  return null;
}

export type TemplatePart = { text: string } | { name: string; reserved: boolean };

/** Split a template into text runs and `{name}` / `{+name}` variables. */
export function templateParts(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const m of template.matchAll(VARIABLE)) {
    if (m.index > last) parts.push({ text: template.slice(last, m.index) });
    parts.push({ name: m[2]!, reserved: m[1] === '+' });
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last) });
  return parts;
}

/** Replace every `{from}` with `{to}` and `{+from}` with `{+to}`; other text is untouched. */
export function renameVariable(text: string, from: string, to: string): string {
  return text.replace(VARIABLE, (whole, plus: string, name: string) => (name === from ? `{${plus}${to}}` : whole));
}

/** Replace every `{name}` and `{+name}` with the value, encoded by each occurrence's form when `encode` is set. */
export function inlineVariable(text: string, name: string, value: string, encode: boolean): string {
  return text.replace(VARIABLE, (whole, plus: string, found: string) => (found !== name ? whole : encode ? encodeFor(plus === '+', value) : value));
}

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) found.push(i);
  return found;
}

/**
 * Turn a page URL back into a template: each variable with a non-empty value
 * whose URL-encoded or form-encoded (`+` for spaces) value occurs exactly once
 * becomes `{name}`; failing those, a differing reserved-encoded value becomes `{+name}`. Longer values are tried first, and a matched span is not
 * reused. Other variables are left out.
 */
export function retemplateUrl(url: string, vars: readonly { name: string; value: string }[]): string {
  let parts: TemplatePart[] = [{ text: url }];
  const candidates = vars.filter((v) => v.value !== '').sort((a, b) => b.value.length - a.value.length);
  for (const v of candidates) {
    const form = new URLSearchParams({ v: v.value }).toString().slice(2);
    const full = encodeURIComponent(v.value);
    const reserved = encodeReserved(v.value);
    const tries = [{ encoded: full, reserved: false }, { encoded: form, reserved: false }];
    if (reserved !== full) tries.push({ encoded: reserved, reserved: true });
    for (const { encoded, reserved: isReserved } of tries) {
      const hits = parts.flatMap((part, p) => ('text' in part ? occurrences(part.text, encoded).map((at) => ({ p, at })) : []));
      if (hits.length !== 1) continue;
      const { p, at } = hits[0]!;
      const text = (parts[p] as { text: string }).text;
      const split = [{ text: text.slice(0, at) }, { name: v.name, reserved: isReserved }, { text: text.slice(at + encoded.length) }].filter((s) => !('text' in s) || s.text !== '');
      parts = [...parts.slice(0, p), ...split, ...parts.slice(p + 1)];
      break;
    }
  }
  return parts.map((part) => ('text' in part ? part.text : `{${part.reserved ? '+' : ''}${part.name}}`)).join('');
}

export interface UrlDiff {
  /** The differing middle of the opened URL. */
  from: string;
  /** The differing middle of the rendered URL. */
  to: string;
}

/** The part two URLs differ in, after stripping their common prefix and suffix; null when equal. */
export function urlDiff(opened: string, rendered: string): UrlDiff | null {
  if (opened === rendered) return null;
  let start = 0;
  while (start < opened.length && start < rendered.length && opened[start] === rendered[start]) start++;
  let end = 0;
  while (end < opened.length - start && end < rendered.length - start && opened[opened.length - 1 - end] === rendered[rendered.length - 1 - end]) end++;
  return { from: opened.slice(start, opened.length - end), to: rendered.slice(start, rendered.length - end) };
}

/** Short text for a URL difference: "`x` added", "`x` removed", or "`a` → `b`". */
export function describeUrlDiff(diff: UrlDiff): string {
  if (diff.from === '') return `${diff.to} added`;
  if (diff.to === '') return `${diff.from} removed`;
  return `${diff.from} → ${diff.to}`;
}
