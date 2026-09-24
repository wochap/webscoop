import type { ElementRef, PageInfo, Session } from '../ports';
import type { PaginationKind, Recipe } from '../recipe/schema';

/** Why a paginated run stopped. */
export const STOP_REASONS = ['limit', 'cap', 'target-missing', 'no-new-items', 'first-item-repeats', 'loop', 'no-growth', 'none'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** Default for the page cap that bounds `limit: all`. */
export const DEFAULT_PAGE_CAP = 500;

/** What advancing produced: a new page, more items on the same page, or the end. */
export type Advance =
  /** A new page; `url` is the URL requested for it, when the strategy navigated to one. */
  | { kind: 'page'; info: PageInfo; url?: string }
  /** The page grew; items from index `from` on are the next page. */
  | { kind: 'grown'; from: number }
  | { kind: 'stop'; reason: StopReason };

/** What a strategy needs from the runner. */
export interface PagerContext {
  session: Session;
  recipe: Recipe;
  /** Navigation and growth timeout in milliseconds. */
  timeoutMs: number;
  /** The pagination target on the current page, healed the first time; null when nothing matches. */
  target(): Promise<ElementRef | null>;
  /** Item containers on the page now. */
  count(): Promise<number>;
  /** Called right before the action that loads the next page. */
  advancing(): void;
  /** Interval between item count checks while waiting for growth. Default 200 ms. */
  pollMs?: number;
  sleep(ms: number): Promise<void>;
}

export interface PageStrategy {
  readonly kind: PaginationKind;
  /** URL of the first page. */
  readonly url: string;
  /** Navigate to the first page. */
  first(ctx: PagerContext): Promise<PageInfo>;
  /** Advance from page `page` to the next one. */
  next(ctx: PagerContext, page: number): Promise<Advance>;
}

/** A recipe or variable value that makes pagination impossible, such as a non-numeric page variable. */
export class PaginationInputError extends Error {
  constructor(
    message: string,
    readonly names: string[] = [],
  ) {
    super(message);
    this.name = 'PaginationInputError';
  }
}
