import type { Recipe, RecipeTable } from './schema';

/** Name of the single table a shorthand recipe (top level `item` and `fields`) stands for. */
export const SHORTHAND_TABLE = 'items';

/** Every table of the recipe, in recipe order; the shorthand form is one table named `items`. */
export function tablesOf(recipe: Pick<Recipe, 'item' | 'fields' | 'tables'>): RecipeTable[] {
  if (recipe.tables) return recipe.tables;
  return [{ name: SHORTHAND_TABLE, ...(recipe.item ? { item: recipe.item } : {}), fields: recipe.fields ?? [] }];
}

/** Index of the primary table: the first with an item block, or -1 when no table has one. */
export function primaryTableIndex(tables: readonly RecipeTable[]): number {
  return tables.findIndex((t) => t.item !== undefined);
}

/** The recipe with its tables replaced, in the form it was written in: a shorthand recipe stays shorthand. */
export function withTables(recipe: Recipe, tables: RecipeTable[]): Recipe {
  if (recipe.tables) return { ...recipe, tables };
  // Assigning existing keys keeps their place, so a written back file changes only where it must.
  const [table] = tables;
  return { ...recipe, ...(table?.item ? { item: table.item } : {}), fields: table?.fields ?? [] };
}
