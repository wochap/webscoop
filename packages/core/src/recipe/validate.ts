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
  const secrets = new Set<string>();
  if (Array.isArray(input.vars)) {
    input.vars.forEach((v, index) => {
      if (!isRecord(v) || v.secret !== true || typeof v.name !== 'string') return;
      secrets.add(v.name);
      if (v.default !== undefined) {
        errors.push({ path: jsonPath(['vars', index, 'default']), message: `secret variable "${v.name}" cannot have a default` });
      }
    });
  }
  if (typeof input.url === 'string') {
    for (const name of templateVariables(input.url)) {
      if (!declared.has(name)) {
        errors.push({ path: '$.url', message: `template variable "${name}" is not declared under vars` });
      } else if (secrets.has(name)) {
        errors.push({ path: '$.url', message: `secret variable "${name}" cannot be used in the url` });
      }
    }
  }

  const hasTables = input.tables !== undefined;
  if (hasTables && (input.fields !== undefined || input.item !== undefined)) {
    const both = [input.fields !== undefined ? 'fields' : null, input.item !== undefined ? 'item' : null].filter(Boolean).join(' and ');
    errors.push({ path: '$.tables', message: `a recipe declares either tables or top level item and fields, not both (found tables and ${both})` });
  }
  if (!hasTables && input.item !== undefined && input.fields === undefined) {
    errors.push({ path: '$.fields', message: 'a recipe with an item block needs at least one field' });
  }
  for (const key of ['steps', 'pagination'] as const) {
    if (input[key] !== undefined) {
      errors.push({
        path: jsonPath([key]),
        message:
          key === 'steps'
            ? 'steps are not a top level key in schema version 2; put them in a flow under flows and place it in sequence'
            : 'pagination is not a top level key in schema version 2; it lives in the sequence as a paginate block',
      });
    }
  }
  const nested = (owner: unknown, at: (string | number)[], what: string) => {
    if (isRecord(owner) && isRecord(owner.frame) && owner.frame.frame !== undefined) {
      errors.push({ path: jsonPath([...at, 'frame', 'frame']), message: `${what} has a frame inside its frame; nested iframes are not supported` });
    }
  };
  if (input.tables === undefined) nested(input, [], 'the recipe');
  if (Array.isArray(input.tables)) {
    input.tables.forEach((table, index) => nested(table, ['tables', index], `table "${isRecord(table) && typeof table.name === 'string' ? table.name : `#${index}`}"`));
  }
  if (Array.isArray(input.flows)) {
    input.flows.forEach((flow, f) => {
      if (!isRecord(flow)) return;
      const name = typeof flow.name === 'string' ? flow.name : `#${f}`;
      if (isRecord(flow.trigger)) nested(flow.trigger.appears, ['flows', f, 'trigger', 'appears'], `the trigger of flow "${name}"`);
      if (Array.isArray(flow.steps)) {
        flow.steps.forEach((step, index) => nested(isRecord(step) ? step.target : undefined, ['flows', f, 'steps', index, 'target'], `flow "${name}" step ${index}`));
      }
    });
  }
  if (Array.isArray(input.sequence)) {
    input.sequence.forEach((block, index) => {
      if (isRecord(block) && isRecord(block.paginate)) nested(block.paginate.target, ['sequence', index, 'paginate', 'target'], 'the paginate target');
    });
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

  errors.push(...flowErrors(input, declared));
  errors.push(...sequenceErrors(input));

  return errors;
}

const flowName = (flow: unknown, index: number): string => (isRecord(flow) && typeof flow.name === 'string' ? flow.name : `#${index}`);

/** Flow checks: unique names, retries only on reactive flows, and the per-kind step rules. */
function flowErrors(input: Record<string, unknown>, declared: ReadonlySet<string>): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!Array.isArray(input.flows)) return errors;
  const names = new Map<string, number>();
  input.flows.forEach((flow, f) => {
    if (!isRecord(flow)) return;
    const name = flowName(flow, f);
    if (typeof flow.name === 'string') {
      if (names.has(flow.name)) {
        errors.push({ path: jsonPath(['flows', f, 'name']), message: `duplicate flow name "${flow.name}" (first declared at ${jsonPath(['flows', names.get(flow.name)!])})` });
      } else {
        names.set(flow.name, f);
      }
    }
    if (flow.trigger === undefined) {
      for (const key of ['maxRetries', 'recover'] as const) {
        if (flow[key] !== undefined) errors.push({ path: jsonPath(['flows', f, key]), message: `flow "${name}" sets ${key} but has no trigger; only reactive flows retry or recover` });
      }
    }
    if (!Array.isArray(flow.steps)) return;
    flow.steps.forEach((step, index) => {
      if (!isRecord(step) || typeof step.kind !== 'string') return;
      const kind = step.kind;
      const at = (...rest: (string | number)[]) => jsonPath(['flows', f, 'steps', index, ...rest]);
      const what = `flow "${name}" step ${index} (${kind})`;
      if (['click', 'fill', 'await-user'].includes(kind) && step.target === undefined) errors.push({ path: at('target'), message: `${what} needs a target` });
      if (['fill', 'press'].includes(kind) && step.value === undefined) errors.push({ path: at('value'), message: `${what} needs a value` });
      if (kind === 'wait' && step.target === undefined && !(typeof step.value === 'string' && /^\d+$/.test(step.value))) {
        errors.push({ path: at(), message: `${what} needs a target or a value in milliseconds` });
      }
      if (kind === 'await-user' && step.until === undefined) errors.push({ path: at('until'), message: `${what} needs until: appears or disappears` });
      if (kind !== 'await-user') {
        for (const key of ['until', 'timeoutMs'] as const) {
          if (step[key] !== undefined) errors.push({ path: at(key), message: `${what} sets ${key}, which only await-user steps take` });
        }
      }
      if (kind === 'fill' && typeof step.value === 'string') {
        for (const variable of templateVariables(step.value)) {
          if (!declared.has(variable)) errors.push({ path: at('value'), message: `template variable "${variable}" is not declared under vars` });
        }
      }
    });
  });
  return errors;
}

/** Sequence checks: blocks name known called flows and tables, each table once, one paginate block at the top level, everything used. */
function sequenceErrors(input: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!Array.isArray(input.sequence)) return errors;
  const flows = new Map<string, Record<string, unknown>>();
  if (Array.isArray(input.flows)) for (const flow of input.flows) if (isRecord(flow) && typeof flow.name === 'string' && !flows.has(flow.name)) flows.set(flow.name, flow);
  const tables = new Map<string, Record<string, unknown>>();
  if (Array.isArray(input.tables)) {
    for (const table of input.tables) if (isRecord(table) && typeof table.name === 'string' && !tables.has(table.name)) tables.set(table.name, table);
  } else if (input.fields !== undefined) {
    tables.set('items', { name: 'items', ...(input.item !== undefined ? { item: input.item } : {}) });
  }
  const extracted = new Map<string, string>();
  const usedFlows = new Set<string>();
  let paginates = 0;

  const visit = (block: unknown, at: (string | number)[], inside: boolean) => {
    if (!isRecord(block)) return;
    const path = jsonPath(at);
    if (typeof block.flow === 'string') {
      const flow = flows.get(block.flow);
      if (!flow) errors.push({ path, message: `block names unknown flow "${block.flow}"` });
      else if (flow.trigger !== undefined) errors.push({ path, message: `flow "${block.flow}" is reactive; it runs when its trigger appears and cannot be placed in the sequence` });
      usedFlows.add(block.flow);
    } else if (typeof block.extract === 'string') {
      if (!tables.has(block.extract)) errors.push({ path, message: `block extracts unknown table "${block.extract}"` });
      const first = extracted.get(block.extract);
      if (first !== undefined) errors.push({ path, message: `table "${block.extract}" is extracted more than once (first at ${first})` });
      else extracted.set(block.extract, path);
    } else if (isRecord(block.paginate)) {
      if (inside) {
        errors.push({ path, message: 'a paginate block cannot be inside another paginate block' });
        return;
      }
      paginates++;
      if (paginates > 1) errors.push({ path, message: 'a sequence has at most one paginate block' });
      const settings = block.paginate;
      if ((settings.kind === 'next' || settings.kind === 'more') && settings.target === undefined) {
        errors.push({ path: jsonPath([...at, 'paginate', 'target']), message: `the paginate block of kind ${settings.kind} needs a target` });
      }
      if (settings.kind === 'url' && settings.param === undefined) {
        errors.push({ path: jsonPath([...at, 'paginate', 'param']), message: 'the paginate block of kind url needs a param' });
      }
      const inner = Array.isArray(settings.do) ? settings.do : [];
      inner.forEach((child, i) => visit(child, [...at, 'paginate', 'do', i], true));
      if (typeof settings.table === 'string') {
        const table = tables.get(settings.table);
        const inDo = inner.some((child) => isRecord(child) && child.extract === settings.table);
        if (!table) errors.push({ path: jsonPath([...at, 'paginate', 'table']), message: `the driving table "${settings.table}" is not a table of the recipe` });
        else if (table.item === undefined) errors.push({ path: jsonPath([...at, 'paginate', 'table']), message: `the driving table "${settings.table}" has no item block` });
        else if (!inDo) errors.push({ path: jsonPath([...at, 'paginate', 'table']), message: `the driving table "${settings.table}" is not extracted in the paginate block's do` });
      }
    }
  };
  input.sequence.forEach((block, index) => visit(block, ['sequence', index], false));

  for (const name of tables.keys()) {
    if (!extracted.has(name)) errors.push({ path: '$.sequence', message: `table "${name}" is never extracted; add an extract block for it` });
  }
  for (const [name, flow] of flows) {
    if (flow.trigger === undefined && !usedFlows.has(name)) errors.push({ path: '$.sequence', message: `called flow "${name}" is never used; add a flow block for it or give it a trigger` });
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
