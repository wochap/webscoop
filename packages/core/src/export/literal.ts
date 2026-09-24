/** Target language of a data literal. */
export type LiteralLanguage = 'ts' | 'py';

/** Longest line a nested array or object stays on. */
const INLINE_WIDTH = 100;

function scalar(value: unknown, language: LiteralLanguage): string | null {
  if (value === null || value === undefined) return language === 'py' ? 'None' : 'null';
  if (typeof value === 'boolean') return language === 'py' ? (value ? 'True' : 'False') : String(value);
  // JSON strings and numbers are valid literals in both languages.
  if (typeof value === 'string' || typeof value === 'number') return JSON.stringify(value);
  return null;
}

function inline(value: unknown, language: LiteralLanguage): string {
  const s = scalar(value, language);
  if (s !== null) return s;
  if (Array.isArray(value)) return `[${value.map((v) => inline(v, language)).join(', ')}]`;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  const pad = language === 'ts' ? ' ' : '';
  return `{${pad}${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inline(v, language)}`).join(', ')}${pad}}`;
}

/**
 * Plain data (JSON values) as a TypeScript or Python literal: nested arrays
 * and objects on one line when they fit, else one entry per line.
 */
export function formatLiteral(value: unknown, language: LiteralLanguage, indent = '', prefix = 0): string {
  const flat = inline(value, language);
  if (scalar(value, language) !== null || indent.length + prefix + flat.length <= INLINE_WIDTH) return flat;
  const inner = `${indent}${language === 'py' ? '    ' : '  '}`;
  const comma = language === 'py' ? ',' : '';
  if (Array.isArray(value)) {
    return `[\n${value.map((v) => `${inner}${formatLiteral(v, language, inner)}`).join(',\n')}${comma}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const lines = entries.map(([k, v]) => {
    const key = `${JSON.stringify(k)}: `;
    return `${inner}${key}${formatLiteral(v, language, inner, key.length)}`;
  });
  return `{\n${lines.join(',\n')}${comma}\n${indent}}`;
}
