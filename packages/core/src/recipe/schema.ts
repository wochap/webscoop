import { z } from 'zod';
import {
  FIELD_SCOPES,
  FIELD_TYPES,
  GUARD_KINDS,
  PAGINATION_KINDS,
  SCHEMA_VERSION,
  STABILITIES,
  STEP_KINDS,
  STEP_WHENS,
  STOP_RULES,
  STRATEGIES,
} from './constants';

export { FIELD_SCOPES, FIELD_TYPES, GUARD_KINDS, PAGINATION_KINDS, SCHEMA_VERSION, STABILITIES, STEP_KINDS, STEP_WHENS, STOP_RULES, STRATEGIES };

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function oneOf<T extends readonly [string, ...string[]]>(what: string, values: T) {
  return z.enum(values, {
    error: (issue) => `unknown ${what} ${JSON.stringify(issue.input)}, expected one of ${values.join(', ')}`,
  });
}

export const SelectorCandidateSchema = z.object({
  strategy: oneOf('strategy', STRATEGIES),
  value: z.string().min(1),
  stability: oneOf('stability', STABILITIES),
});

export const FingerprintSchema = z.object({
  tag: z.string().min(1),
  role: z.string().optional(),
  name: z.string().optional(),
  textSample: z.string().max(80),
  attrs: z.record(z.string(), z.string()),
  ancestors: z.array(z.string()).max(6),
  bbox: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  }),
});

export const VarSchema = z.object({
  name: z.string().regex(IDENTIFIER, 'variable names must be identifiers'),
  type: z.literal('string'),
  default: z.string().optional(),
});

export const ItemSchema = z.object({
  selectors: z.array(SelectorCandidateSchema).min(1),
  /** The list parent: containers are resolved inside the first element its first resolving candidate matches. */
  within: z.array(SelectorCandidateSchema).min(1).optional(),
  withinFingerprint: FingerprintSchema.optional(),
  exclude: z.array(SelectorCandidateSchema).optional(),
  fingerprint: FingerprintSchema.optional(),
});

export const FieldSchema = z.object({
  name: z.string().regex(IDENTIFIER, 'field names must be identifiers'),
  type: oneOf('field type', FIELD_TYPES),
  /** Defaults from the table: `item` when it has an item block, else `page`. */
  scope: oneOf('scope', FIELD_SCOPES).optional(),
  selectors: z.array(SelectorCandidateSchema).min(1),
  attr: z.string().min(1).optional(),
  optional: z.boolean().default(false),
  key: z.boolean().optional(),
  fingerprint: FingerprintSchema.optional(),
});

/** An element the runner acts on or waits for: ranked selectors plus a fingerprint for healing. */
export const TargetSchema = z.object({
  selectors: z.array(SelectorCandidateSchema).min(1),
  fingerprint: FingerprintSchema.optional(),
});

export const PaginationSchema = z.object({
  kind: oneOf('pagination kind', PAGINATION_KINDS).default('none'),
  target: TargetSchema.optional(),
  param: z
    .object({
      name: z.string().regex(IDENTIFIER),
      start: z.number().int(),
      step: z.number().int(),
    })
    .optional(),
  limit: z.union([z.number().int().positive(), z.literal('all')]).default(1),
  stopRules: z.array(oneOf('stop rule', STOP_RULES)).default([]),
  delayMs: z.number().int().nonnegative().default(0),
});

export const GuardSchema = z.object({
  kind: oneOf('guard kind', GUARD_KINDS),
  enabled: z.boolean(),
});

export const HealingSchema = z.object({
  fuzzyThreshold: z.number().min(0).max(1).default(0.7),
  llm: z.boolean().default(true),
});

/** A recorded action replayed before extraction. Which kinds need a target or value is checked across fields. */
export const StepSchema = z.object({
  kind: oneOf('step kind', STEP_KINDS),
  target: TargetSchema.optional(),
  value: z.string().optional(),
  when: oneOf('step when', STEP_WHENS).default('first-page'),
  optional: z.boolean().default(false),
  label: z.string().min(1).optional(),
});

/** One flat output: one row per item container, or one row per page without an item block. */
export const TableSchema = z.object({
  name: z.string().regex(KEBAB, 'table names must be kebab-case'),
  item: ItemSchema.optional(),
  fields: z.array(FieldSchema).min(1, 'a table needs at least one field'),
});

const defaultGuards = () => GUARD_KINDS.map((kind) => ({ kind, enabled: true }));

const RecipeObjectSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  name: z.string().regex(KEBAB, 'recipe names must be kebab-case'),
  url: z.string().min(1),
  vars: z.array(VarSchema).default([]),
  /** Shorthand for a single table named `items`; a recipe declares either this pair or `tables`. */
  item: ItemSchema.optional(),
  fields: z.array(FieldSchema).min(1, 'a recipe needs at least one field').optional(),
  tables: z.array(TableSchema).min(1, 'a recipe needs at least one table').optional(),
  steps: z.array(StepSchema).default([]),
  pagination: PaginationSchema.default(() => PaginationSchema.parse({})),
  guards: z.array(GuardSchema).default(defaultGuards),
  healing: HealingSchema.default(() => HealingSchema.parse({})),
});

type ParsedField = z.output<typeof FieldSchema>;
type ParsedRecipe = z.output<typeof RecipeObjectSchema>;

/** Fill each field's scope from its table: `item` when the table has an item block, else `page`. */
function withScopes(fields: readonly ParsedField[], item: unknown): RecipeField[] {
  return fields.map((f) => (f.scope ? (f as RecipeField) : { ...f, scope: item ? 'item' : 'page' }));
}

/** The recipe schema; parsing fills every field's `scope` from its table. */
export const RecipeSchema = RecipeObjectSchema.transform((recipe: ParsedRecipe): Recipe => {
  const { fields, tables, ...rest } = recipe;
  return {
    ...rest,
    ...(fields ? { fields: withScopes(fields, recipe.item) } : {}),
    ...(tables ? { tables: tables.map((t) => ({ ...t, fields: withScopes(t.fields, t.item) })) } : {}),
  } as Recipe;
});

export type SelectorCandidate = z.infer<typeof SelectorCandidateSchema>;
export type Strategy = SelectorCandidate['strategy'];
export type Stability = SelectorCandidate['stability'];
export type Fingerprint = z.infer<typeof FingerprintSchema>;
export type RecipeVar = z.infer<typeof VarSchema>;
export type RecipeItem = z.infer<typeof ItemSchema>;
export type FieldScope = (typeof FIELD_SCOPES)[number];
/** A field after parsing: `scope` is always set. */
export type RecipeField = Omit<ParsedField, 'scope'> & { scope: FieldScope };
export type FieldType = RecipeField['type'];
export type RecipeTable = Omit<z.output<typeof TableSchema>, 'fields'> & { fields: RecipeField[] };
export type Target = z.infer<typeof TargetSchema>;
export type Step = z.infer<typeof StepSchema>;
export type StepKind = Step['kind'];
export type StepWhen = Step['when'];
export type Pagination = z.infer<typeof PaginationSchema>;
export type PaginationKind = Pagination['kind'];
export type Guard = z.infer<typeof GuardSchema>;
export type GuardKind = Guard['kind'];
export type Healing = z.infer<typeof HealingSchema>;
export type Recipe = Omit<ParsedRecipe, 'fields' | 'tables'> & { fields?: RecipeField[]; tables?: RecipeTable[] };
/** Recipe as written on disk, before defaults are filled in. */
export type RecipeInput = z.input<typeof RecipeSchema>;
