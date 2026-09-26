import type { Row } from '../events';
import type { PaginationKind, RecipeField } from '../recipe/schema';
import type { StopReason } from './types';

/**
 * Drops rows already seen on an earlier page. Rows are identified by the key
 * field's value, or by all field values together when no field is the key.
 * One instance per item table: keys never cross tables.
 */
export class Dedup {
  private readonly seen = new Set<string>();
  private readonly key: string | undefined;
  private readonly names: string[];
  /** Rows dropped so far. */
  duplicates = 0;

  constructor(table: { fields: readonly RecipeField[] }) {
    this.key = table.fields.find((f) => f.key)?.name;
    this.names = table.fields.map((f) => f.name);
  }

  keyOf(row: Row): string {
    return JSON.stringify(this.key !== undefined ? row[this.key] : this.names.map((name) => row[name]));
  }

  /**
   * Which rows are new, without remembering them yet. Page 1 is never
   * deduplicated; later pages drop rows seen before, also within the page.
   */
  preview(rows: readonly Row[], page: number): { kept: Row[]; dropped: number; commit(): void } {
    const keys = rows.map((row) => this.keyOf(row));
    const kept: Row[] = [];
    const fresh = new Set<string>();
    rows.forEach((row, i) => {
      const key = keys[i]!;
      if (page === 1 || (!this.seen.has(key) && !fresh.has(key))) kept.push(row);
      fresh.add(key);
    });
    const dropped = rows.length - kept.length;
    return {
      kept,
      dropped,
      commit: () => {
        for (const key of keys) this.seen.add(key);
        this.duplicates += dropped;
      },
    };
  }
}

/** One extracted page, as the stop rules see it. */
export interface PageSummary {
  page: number;
  url: string;
  /** Dedup key of the page's first row before dedup, or null for an empty page. */
  firstKey: string | null;
  /** Rows before dedup. */
  raw: number;
  /** Rows after dedup. */
  kept: number;
}

export interface StopInput {
  current: PageSummary;
  /** The page before, or null on page 1. */
  previous: PageSummary | null;
  kind: PaginationKind;
  stopRules: readonly string[];
  limit: number | 'all';
  cap: number;
}

export interface StopVerdict {
  reason: StopReason | null;
  /** The page is not a page of its own (empty, or a repeat of the previous one): its rows are not emitted. */
  discard: boolean;
}

/**
 * Stop rules, in order: an empty page, the loop guard (same URL and first
 * row as the previous page), `no-new-items`, `first-item-repeats`, kind
 * `none`, the limit, the cap on `all`.
 */
export function evaluateStop({ current, previous, kind, stopRules, limit, cap }: StopInput): StopVerdict {
  if (previous) {
    if (current.raw === 0) return { reason: 'no-new-items', discard: true };
    const sameFirst = current.firstKey !== null && current.firstKey === previous.firstKey;
    if (sameFirst && current.url === previous.url) return { reason: 'loop', discard: false };
    if (stopRules.includes('no-new-items') && current.kept === 0) return { reason: 'no-new-items', discard: false };
    if (stopRules.includes('first-item-repeats') && sameFirst) return { reason: 'first-item-repeats', discard: true };
  }
  if (kind === 'none') return { reason: 'none', discard: false };
  if (limit !== 'all' && current.page >= limit) return { reason: 'limit', discard: false };
  if (limit === 'all' && current.page >= cap) return { reason: 'cap', discard: false };
  return { reason: null, discard: false };
}
