import { SCHEMA_VERSION, type Recipe, type RecipeField } from './schema';
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

/** How to rewrite a version 1 recipe by hand; there is no automatic migration. */
export const VERSION_1_GUIDANCE = [
  'schemaVersion 1 is no longer supported; rewrite the recipe as schemaVersion 2:',
  '  - move steps into called flows under flows, placed in sequence before the extract or paginate block for first-page steps and inside the paginate block\'s do for every-page steps',
  '  - turn type and select steps into fill steps',
  '  - move pagination into a { "paginate": { ...settings, "do": [...] } } block of sequence',
  '  - list every table in sequence as { "extract": name }',
].join('\n');

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
  if (version === 1) throw new RecipeError(source, VERSION_1_GUIDANCE);
  if (version !== SCHEMA_VERSION) {
    const found = version === undefined ? 'missing' : JSON.stringify(version);
    throw new RecipeError(source, `unsupported schemaVersion ${found}, expected ${SCHEMA_VERSION}`);
  }
  const result = validateRecipe(document);
  if (!result.ok) {
    const count = result.errors.length;
    throw new RecipeError(source, `invalid recipe (${count} error${count === 1 ? '' : 's'})`, result.errors);
  }
  return result.recipe;
}

/** A field as written: `fallback` and `hover` are left out when false. */
function savedField(field: RecipeField): Partial<RecipeField> {
  const { fallback, hover, ...rest } = field;
  return { ...rest, ...(fallback ? { fallback } : {}), ...(hover ? { hover } : {}) };
}

/** Serialize a recipe as stable, human editable JSON. An empty `flows` list and false `fallback` and `hover` flags are left out, so recipes keep their shape. */
export function saveRecipe(recipe: Recipe): string {
  const { flows, ...rest } = recipe;
  const out = {
    ...(flows.length > 0 ? recipe : rest),
    ...(recipe.fields ? { fields: recipe.fields.map(savedField) } : {}),
    ...(recipe.tables ? { tables: recipe.tables.map((t) => ({ ...t, fields: t.fields.map(savedField) })) } : {}),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}
