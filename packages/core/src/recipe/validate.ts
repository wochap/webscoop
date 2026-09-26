import type { z } from 'zod';
import { templateVariables } from '../template';
import { RecipeSchema, type Recipe } from './schema';

export interface ValidationError {
  /** JSON path of the offending value, e.g. `$.fields[1].type`. */
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; recipe: Recipe; errors: [] }
  | { ok: false; errors: ValidationError[] };

export function jsonPath(segments: readonly PropertyKey[]): string {
  let path = '$';
  for (const segment of segments) {
    if (typeof segment === 'number') path += `[${segment}]`;
    else if (typeof segment === 'string' && /^[A-Za-z_$][\w$]*$/.test(segment)) path += `.${segment}`;
    else path += `[${JSON.stringify(String(segment))}]`;
  }
  return path;
}

function zodErrors(error: z.ZodError): ValidationError[] {
  return error.issues.map((issue) => ({ path: jsonPath(issue.path), message: issue.message }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Field checks within one table: unique names, one key at most, `item` scope only with an item block. */
function fieldErrors(fields: unknown[], hasItem: boolean, at: (string | number)[], table?: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const seen = new Map<string, number>();
  const keys: number[] = [];
  const where = table === undefined ? 'the recipe has' : `table "${table}" has`;
  fields.forEach((field, index) => {
    if (!isRecord(field)) return;
    const name = typeof field.name === 'string' ? field.name : `#${index}`;
    if (field.scope === 'item' && !hasItem) {
      errors.push({
        path: jsonPath([...at, index, 'scope']),
        message: `field "${name}" has scope item but ${where} no item block`,
      });
    }
    if (typeof field.name === 'string') {
      if (seen.has(field.name)) {
        errors.push({
          path: jsonPath([...at, index, 'name']),
          message: `duplicate field name "${field.name}" (first declared at ${jsonPath([...at, seen.get(field.name)!])})`,
        });
      } else {
        seen.set(field.name, index);
      }
    }
    if (field.key === true) keys.push(index);
  });
  for (const index of keys.slice(1)) {
    errors.push({
      path: jsonPath([...at, index, 'key']),
      message: `only one field may set key: true (already set at ${jsonPath([...at, keys[0]!])})`,
    });
  }
  return errors;
}

/**
 * Checks that span several parts of the document. They run on the raw input so
 * they still report when the structural schema also fails.
 */
function crossFieldErrors(input: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];

  const declared = new Set(
    Array.isArray(input.vars)
      ? input.vars.filter(isRecord).map((v) => v.name).filter((n): n is string => typeof n === 'string')
      : [],
  );
  if (typeof input.url === 'string') {
    for (const name of templateVariables(input.url)) {
      if (!declared.has(name)) {
        errors.push({ path: '$.url', message: `template variable "${name}" is not declared under vars` });
      }
    }
  }

  const hasTables = input.tables !== undefined;
  if (hasTables && (input.fields !== undefined || input.item !== undefined)) {
    const both = [input.fields !== undefined ? 'fields' : null, input.item !== undefined ? 'item' : null].filter(Boolean).join(' and ');
    errors.push({ path: '$.tables', message: `a recipe declares either tables or top level item and fields, not both (found tables and ${both})` });
  }
  if (!hasTables && input.fields === undefined) {
    errors.push({ path: '$.fields', message: 'a recipe needs at least one field' });
  }
  if (Array.isArray(input.fields)) errors.push(...fieldErrors(input.fields, input.item !== undefined, ['fields']));
  if (Array.isArray(input.tables)) {
    const names = new Map<string, number>();
    input.tables.forEach((table, index) => {
      if (!isRecord(table)) return;
      if (typeof table.name === 'string') {
        if (names.has(table.name)) {
          errors.push({
            path: jsonPath(['tables', index, 'name']),
            message: `duplicate table name "${table.name}" (first declared at ${jsonPath(['tables', names.get(table.name)!])})`,
          });
        } else {
          names.set(table.name, index);
        }
      }
      if (Array.isArray(table.fields)) {
        const label = typeof table.name === 'string' ? table.name : `#${index}`;
        errors.push(...fieldErrors(table.fields, table.item !== undefined, ['tables', index, 'fields'], label));
      }
    });
  }

  if (Array.isArray(input.steps)) {
    input.steps.forEach((step, index) => {
      if (!isRecord(step) || typeof step.kind !== 'string') return;
      const kind = step.kind;
      if (['click', 'type', 'select'].includes(kind) && step.target === undefined) {
        errors.push({ path: jsonPath(['steps', index, 'target']), message: `step ${index} (${kind}) needs a target` });
      }
      if (['type', 'select', 'press'].includes(kind) && step.value === undefined) {
        errors.push({ path: jsonPath(['steps', index, 'value']), message: `step ${index} (${kind}) needs a value` });
      }
      if (kind === 'wait' && step.target === undefined && !(typeof step.value === 'string' && /^\d+$/.test(step.value))) {
        errors.push({
          path: jsonPath(['steps', index]),
          message: `step ${index} (wait) needs a target or a value in milliseconds`,
        });
      }
      if (kind === 'type' && typeof step.value === 'string') {
        for (const name of templateVariables(step.value)) {
          if (!declared.has(name)) {
            errors.push({ path: jsonPath(['steps', index, 'value']), message: `template variable "${name}" is not declared under vars` });
          }
        }
      }
    });
  }

  return errors;
}

/** Validate a parsed recipe document, collecting every error instead of stopping at the first. */
export function validateRecipe(input: unknown): ValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: '$', message: 'a recipe must be a JSON object' }] };
  }
  const parsed = RecipeSchema.safeParse(input);
  const errors = [...(parsed.success ? [] : zodErrors(parsed.error)), ...crossFieldErrors(input)];
  if (errors.length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, recipe: parsed.data, errors: [] };
}
