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
