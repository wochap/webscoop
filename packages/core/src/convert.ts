import type { FieldType } from './recipe/schema';

export function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** First numeric token in the text, with thousands separators removed. */
export function parseNumber(raw: string): number | null {
  const match = /-?\d[\d,]*(?:\.\d+)?|-?\.\d+/.exec(raw);
  if (!match) return null;
  const value = Number(match[0].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

export function resolveUrl(raw: string, pageUrl: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    return new URL(trimmed, pageUrl).href;
  } catch {
    return trimmed;
  }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function monthIndex(name: string): number | null {
  const index = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  return index === -1 ? null : index + 1;
}

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * ISO 8601 for the explicit set of accepted formats, or null. Formats:
 * ISO date or date-time, `MM/DD/YYYY`, `DD.MM.YYYY`, `Month D, YYYY`, `D Month YYYY`.
 */
export function parseDate(raw: string): string | null {
  const text = collapseWhitespace(raw);
  let m: RegExpExecArray | null;

  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text))) return isoDate(+m[1]!, +m[2]!, +m[3]!);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(text)) {
    const date = new Date(text.replace(' ', 'T'));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text))) return isoDate(+m[3]!, +m[1]!, +m[2]!);
  if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text))) return isoDate(+m[3]!, +m[2]!, +m[1]!);
  if ((m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(text))) {
    const month = monthIndex(m[1]!);
    return month === null ? null : isoDate(+m[3]!, month, +m[2]!);
  }
  if ((m = /^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})$/.exec(text))) {
    const month = monthIndex(m[2]!);
    return month === null ? null : isoDate(+m[3]!, month, +m[1]!);
  }
  return null;
}

/** Convert a raw string read from the page into the row value for the field type. */
export function convertValue(type: FieldType, raw: string, pageUrl: string): string | number | null {
  switch (type) {
    case 'text':
      return collapseWhitespace(raw);
    case 'number':
      return parseNumber(raw);
    case 'url':
    case 'image':
      return resolveUrl(raw, pageUrl);
    case 'date':
      return parseDate(raw) ?? collapseWhitespace(raw);
    case 'html':
      return raw.trim();
  }
}

/** Attribute read by default when a field does not set `attr`. */
export function defaultAttr(type: FieldType): string | undefined {
  if (type === 'url') return 'href';
  if (type === 'image') return 'src';
  return undefined;
}
