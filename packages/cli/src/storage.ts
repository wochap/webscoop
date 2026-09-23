import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { loadRecipe, RecipeError, saveRecipe, type Recipe, type RecipeSummary, type StoragePort } from '@webscoop/core';
import { CliError } from './exit';

/** Whether a recipe reference is a path rather than a name in the recipes directory. */
export function isRecipePath(ref: string): boolean {
  return ref.includes('/') || ref.endsWith('.json') || ref.startsWith('.');
}

export interface ListedRecipe extends RecipeSummary {
  path: string;
}

/** Recipes stored as `<name>.json` files in the recipes directory. */
export class FsStorage implements StoragePort {
  /** Problems found while listing, e.g. invalid recipe files. */
  readonly warnings: string[] = [];

  constructor(
    readonly recipesDir: string,
    private readonly cwd: string = process.cwd(),
  ) {}

  pathFor(ref: string): string {
    if (isRecipePath(ref)) return isAbsolute(ref) ? ref : resolve(this.cwd, ref);
    return join(this.recipesDir, `${ref}.json`);
  }

  async list(): Promise<ListedRecipe[]> {
    let entries: string[];
    try {
      entries = await readdir(this.recipesDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const out: ListedRecipe[] = [];
    for (const entry of entries.filter((e) => e.endsWith('.json')).sort()) {
      const path = join(this.recipesDir, entry);
      try {
        const [recipe, info] = await Promise.all([this.load(path), stat(path)]);
        out.push({ name: recipe.name, url: recipe.url, fieldCount: recipe.fields.length, modified: info.mtime, path });
      } catch (error) {
        this.warnings.push(error instanceof CliError ? error.message : `${path}: ${(error as Error).message}`);
      }
    }
    return out;
  }

  async load(ref: string): Promise<Recipe> {
    const path = this.pathFor(ref);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CliError(
          isRecipePath(ref) ? `recipe file not found: ${path}` : `no recipe named "${ref}" in ${this.recipesDir}`,
        );
      }
      throw error;
    }
    try {
      return loadRecipe(text, path);
    } catch (error) {
      if (error instanceof RecipeError) throw new CliError(error.format());
      throw error;
    }
  }

  async save(recipe: Recipe): Promise<void> {
    await mkdir(this.recipesDir, { recursive: true });
    await writeFile(join(this.recipesDir, `${recipe.name}.json`), saveRecipe(recipe));
  }
}
