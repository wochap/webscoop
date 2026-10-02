import type { Block, Flow, InnerBlock, Paginate, Pagination, Recipe, RecipeTable } from './schema';
import { DEFAULT_MAX_RETRIES } from './constants';

/** The sequence's paginate block, or null when the recipe extracts one page. */
export function paginateOf(recipe: Pick<Recipe, 'sequence'>): Paginate | null {
  for (const block of recipe.sequence) if ('paginate' in block) return block.paginate;
  return null;
}

/** The pagination settings the strategies and stop rules use; kind `none` without a paginate block. */
export function paginationOf(recipe: Pick<Recipe, 'sequence'>): Pagination {
  const block = paginateOf(recipe);
  if (!block) return { kind: 'none', limit: 1, stopRules: [], delayMs: 0 };
  const { do: _do, table: _table, ...settings } = block;
  return settings;
}

/** The recipe with its paginate block replaced; a recipe without one is returned as is. */
export function withPaginate(recipe: Recipe, update: (block: Paginate) => Paginate): Recipe {
  if (!paginateOf(recipe)) return recipe;
  return { ...recipe, sequence: recipe.sequence.map((b) => ('paginate' in b ? { paginate: update(b.paginate) } : b)) };
}

/** Name of the paginate block's driving table: its `table`, else the first item table extracted in `do`; null when none. */
export function drivingTable(block: Pick<Paginate, 'table' | 'do'>, tables: readonly Pick<RecipeTable, 'name' | 'item'>[]): string | null {
  if (block.table !== undefined) return block.table;
  for (const inner of block.do) {
    if ('extract' in inner && tables.find((t) => t.name === inner.extract)?.item) return inner.extract;
  }
  return null;
}

export const isReactive = (flow: Pick<Flow, 'trigger'>): boolean => flow.trigger !== undefined;

/** Times a reactive flow may fire between two successful extractions. */
export const maxRetriesOf = (flow: Pick<Flow, 'maxRetries'>): number => flow.maxRetries ?? DEFAULT_MAX_RETRIES;

/** Every block of the sequence in run order, a paginate block's `do` after the block itself. */
export function walkBlocks(sequence: readonly Block[]): (Block | InnerBlock)[] {
  return sequence.flatMap((b) => ('paginate' in b ? [b, ...b.paginate.do] : [b]));
}

/**
 * The sequence a recorder draft gets while the user has not edited it: called
 * flows in list order, then each table once; a paginate block wraps the
 * driving table's extract and every table after it.
 */
export function defaultSequence(
  flows: readonly Pick<Flow, 'name' | 'trigger'>[],
  tables: readonly string[],
  paginate: Omit<Paginate, 'do'> | null,
): Block[] {
  const blocks: Block[] = flows.filter((f) => !isReactive(f)).map((f) => ({ flow: f.name }));
  if (!paginate) return [...blocks, ...tables.map((t) => ({ extract: t }))];
  const start = paginate.table !== undefined && tables.includes(paginate.table) ? tables.indexOf(paginate.table) : 0;
  const before = tables.slice(0, start).map((t) => ({ extract: t }));
  const inner = tables.slice(start).map((t) => ({ extract: t }));
  if (inner.length === 0) return [...blocks, ...before];
  return [...blocks, ...before, { paginate: { ...paginate, do: inner } }];
}
