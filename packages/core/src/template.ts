import type { RecipeVar } from './recipe/schema';

const VARIABLE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Names of the `{name}` variables used in a URL template, in order of first use. */
export function templateVariables(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(VARIABLE)) {
    const name = match[1]!;
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
  return template.replace(VARIABLE, (_, name: string) => encodeURIComponent(resolved.get(name)!));
}

/**
 * Replace every `{name}` in a step value with the raw value, taken from
 * `values` first and the declared default second. Unlike `fillTemplate`
 * nothing is encoded: the text is typed, not put in a URL.
 */
export function fillText(template: string, vars: readonly RecipeVar[], values: Readonly<Record<string, string>> = {}): string {
  const missing = templateVariables(template).filter((name) => (values[name] ?? vars.find((v) => v.name === name)?.default) === undefined);
  if (missing.length > 0) throw new MissingVariableError(missing);
  return template.replace(VARIABLE, (_, name: string) => values[name] ?? vars.find((v) => v.name === name)!.default!);
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
  if (brace !== -1) return `invalid URL template "${template}": unmatched "${stripped[brace]}" (variables look like {name})`;
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

/** Split a template into text runs and `{name}` variables. */
export function templateParts(template: string): ({ text: string } | { name: string })[] {
  const parts: ({ text: string } | { name: string })[] = [];
  let last = 0;
  for (const m of template.matchAll(VARIABLE)) {
    if (m.index > last) parts.push({ text: template.slice(last, m.index) });
    parts.push({ name: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last) });
  return parts;
}

/** Replace every `{from}` in the text with `{to}`; other text is untouched. */
export function renameVariable(text: string, from: string, to: string): string {
  return text.replace(VARIABLE, (whole, name: string) => (name === from ? `{${to}}` : whole));
}

/** Replace every `{name}` in the text with the value, URL-encoded when `encode` is set. */
export function inlineVariable(text: string, name: string, value: string, encode: boolean): string {
  const inlined = encode ? encodeURIComponent(value) : value;
  return text.replace(VARIABLE, (whole, found: string) => (found === name ? inlined : whole));
}

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) found.push(i);
  return found;
}

/**
 * Turn a page URL back into a template: each variable with a non-empty value
 * whose URL-encoded or form-encoded (`+` for spaces) value occurs exactly once
 * becomes `{name}`. Longer values are tried first, and a matched span is not
 * reused. Other variables are left out.
 */
export function retemplateUrl(url: string, vars: readonly { name: string; value: string }[]): string {
  let parts: ({ text: string } | { name: string })[] = [{ text: url }];
  const candidates = vars.filter((v) => v.value !== '').sort((a, b) => b.value.length - a.value.length);
  for (const v of candidates) {
    const form = new URLSearchParams({ v: v.value }).toString().slice(2);
    for (const encoded of [encodeURIComponent(v.value), form]) {
      const hits = parts.flatMap((part, p) => ('text' in part ? occurrences(part.text, encoded).map((at) => ({ p, at })) : []));
      if (hits.length !== 1) continue;
      const { p, at } = hits[0]!;
      const text = (parts[p] as { text: string }).text;
      const split = [{ text: text.slice(0, at) }, { name: v.name }, { text: text.slice(at + encoded.length) }].filter((s) => !('text' in s) || s.text !== '');
      parts = [...parts.slice(0, p), ...split, ...parts.slice(p + 1)];
      break;
    }
  }
  return parts.map((part) => ('text' in part ? part.text : `{${part.name}}`)).join('');
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
