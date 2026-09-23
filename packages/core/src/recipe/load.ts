import { SCHEMA_VERSION, type Recipe } from './schema';
import { validateRecipe, type ValidationError } from './validate';

export class RecipeError extends Error {
  constructor(
    readonly source: string,
    message: string,
    readonly errors: ValidationError[] = [],
  ) {
    super(`${source}: ${message}`);
    this.name = 'RecipeError';
  }

  /** Human readable, one error per line. */
  format(): string {
    if (this.errors.length === 0) return this.message;
    return [this.message, ...this.errors.map((e) => `  ${e.path}: ${e.message}`)].join('\n');
  }
}

/**
 * Bring an older document up to the current schema version. Version 1 is the
 * only version so far, so this is the identity.
 */
export function migrate(document: Record<string, unknown>): Record<string, unknown> {
  return document;
}

/** Parse and validate a recipe from JSON text or an already parsed value. */
export function loadRecipe(json: string | unknown, source = '<recipe>'): Recipe {
  let document: unknown = json;
  if (typeof json === 'string') {
    try {
      document = JSON.parse(json);
    } catch (error) {
      throw new RecipeError(source, `invalid JSON: ${(error as Error).message}`);
    }
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new RecipeError(source, 'a recipe must be a JSON object');
  }
  const version = (document as Record<string, unknown>).schemaVersion;
  if (version !== SCHEMA_VERSION) {
    const found = version === undefined ? 'missing' : JSON.stringify(version);
    throw new RecipeError(source, `unsupported schemaVersion ${found}, expected ${SCHEMA_VERSION}`);
  }
  const result = validateRecipe(migrate(document as Record<string, unknown>));
  if (!result.ok) {
    const count = result.errors.length;
    throw new RecipeError(source, `invalid recipe (${count} error${count === 1 ? '' : 's'})`, result.errors);
  }
  return result.recipe;
}

/** Serialize a recipe as stable, human editable JSON. */
export function saveRecipe(recipe: Recipe): string {
  return `${JSON.stringify(recipe, null, 2)}\n`;
}
