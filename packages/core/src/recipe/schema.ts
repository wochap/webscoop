import { z } from 'zod';
import {
  DESCRIPTION_MAX,
  FIELD_SCOPES,
  FIELD_TYPES,
  GUARD_KINDS,
  DEFAULT_MAX_RETRIES,
  PAGINATE_KINDS,
  PAGINATION_KINDS,
  SCHEMA_VERSION,
  STABILITIES,
  STEP_KINDS,
  STEP_UNTILS,
  STEP_WINDOWS,
  STOP_RULES,
  STRATEGIES,
} from './constants';

export {
  DEFAULT_MAX_RETRIES,
  DESCRIPTION_MAX,
  FIELD_SCOPES,
  FIELD_TYPES,
  GUARD_KINDS,
  PAGINATE_KINDS,
  PAGINATION_KINDS,
  SCHEMA_VERSION,
  STABILITIES,
  STEP_KINDS,
  STEP_UNTILS,
  STEP_WINDOWS,
  STOP_RULES,
  STRATEGIES,
};

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

/** Plain text for people and AI models; never changes how a recipe runs. */
export const DescriptionSchema = z.string().min(1, 'a description cannot be empty').max(DESCRIPTION_MAX, `a description is at most ${DESCRIPTION_MAX} characters`);

export const VarSchema = z.object({
  name: z.string().regex(IDENTIFIER, 'variable names must be identifiers'),
  /** `path`: one or more file paths separated by `:`. */
  type: z.enum(['string', 'path']),
  /** Never saved with a default, printed, logged, or passed to hooks. */
  secret: z.boolean().optional(),
  /** Substituted into the URL unchanged, with no encoding. */
  raw: z.boolean().optional(),
  default: z.string().optional(),
  description: DescriptionSchema.refine((value) => !/[\r\n]/.test(value), 'a variable description is one line').optional(),
}).superRefine((v, ctx) => {
  if (v.raw && v.secret) ctx.addIssue({ code: 'custom', path: ['raw'], message: `variable "${v.name}" cannot be both raw and secret` });
  if (v.raw && v.type === 'path') ctx.addIssue({ code: 'custom', path: ['raw'], message: `variable "${v.name}" cannot be both raw and a path` });
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
  /** Walk the settled candidates per row instead of using only the settled primary; omitted on save when false. */
  fallback: z.boolean().default(false),
  /** Move the real mouse over the element before reading it; omitted on save when false. */
  hover: z.boolean().default(false),
  key: z.boolean().optional(),
  fingerprint: FingerprintSchema.optional(),
});

/** An `<iframe>` in the top document whose document holds the elements to resolve. One level only. */
export const FrameSchema = z.object({
  selectors: z.array(SelectorCandidateSchema).min(1),
  fingerprint: FingerprintSchema.optional(),
});

/** An element the runner acts on or waits for: ranked selectors plus a fingerprint for healing. */
export const TargetSchema = z.object({
  selectors: z.array(SelectorCandidateSchema).min(1),
  fingerprint: FingerprintSchema.optional(),
  frame: FrameSchema.optional(),
});

/** Page variable of `url` pagination. */
export const PageParamSchema = z.object({
  name: z.string().regex(IDENTIFIER),
  start: z.number().int(),
  step: z.number().int(),
});

/** Pagination settings, as the runner and the strategies see them; `none` stands for a recipe without a paginate block. */
export const PaginationSchema = z.object({
  kind: oneOf('pagination kind', PAGINATION_KINDS).default('none'),
  target: TargetSchema.optional(),
  param: PageParamSchema.optional(),
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

/** A recorded action a flow replays. Which kinds need a target or value is checked across fields. */
export const StepSchema = z.object({
  kind: oneOf('step kind', STEP_KINDS),
  target: TargetSchema.optional(),
  value: z.string().optional(),
  /** For `await-user`: whether the step waits for its target to appear or to disappear. */
  until: oneOf('step until', STEP_UNTILS).optional(),
  /** For `await-user`: a private wait budget instead of the run's guard timeout. */
  timeoutMs: z.number().int().positive().optional(),
  window: oneOf('step window', STEP_WINDOWS).default('same'),
  optional: z.boolean().default(false),
  label: z.string().min(1).optional(),
});

/** A named, ordered list of steps; with a trigger it is reactive and fires whenever its target appears. */
export const FlowSchema = z.object({
  name: z.string().regex(KEBAB, 'flow names must be kebab-case'),
  description: DescriptionSchema.optional(),
  trigger: z.object({ appears: TargetSchema }).optional(),
  maxRetries: z.number().int().positive().optional(),
  recover: z.boolean().optional(),
  steps: z.array(StepSchema).min(1, 'a flow needs at least one step'),
});

export const FlowBlockSchema = z.object({ flow: z.string().min(1) }).strict();
export const ExtractBlockSchema = z.object({ extract: z.string().min(1) }).strict();
/** A block repeated on every page of a paginate block. */
export const InnerBlockSchema = z.union([FlowBlockSchema, ExtractBlockSchema], { error: 'a block inside do is { "flow": name } or { "extract": table }' });

export const PaginateSchema = z.object({
  kind: oneOf('paginate kind', PAGINATE_KINDS),
  target: TargetSchema.optional(),
  param: PageParamSchema.optional(),
  limit: z.union([z.number().int().positive(), z.literal('all')]).default(1),
  stopRules: z.array(oneOf('stop rule', STOP_RULES)).default([]),
  delayMs: z.number().int().nonnegative().default(0),
  /** The driving table; default: the first table with an item block extracted in `do`. */
  table: z.string().optional(),
  do: z.array(InnerBlockSchema).min(1, 'a paginate block needs at least one block in do'),
});

export const PaginateBlockSchema = z.object({ paginate: PaginateSchema }).strict();

/** One block of the sequence. */
export const BlockSchema = z.union([FlowBlockSchema, ExtractBlockSchema, PaginateBlockSchema], {
  error: 'a block is { "flow": name }, { "extract": table }, or { "paginate": settings }',
});

/** One flat output: one row per item container, or one row per page without an item block. */
export const TableSchema = z.object({
  name: z.string().regex(KEBAB, 'table names must be kebab-case'),
  description: DescriptionSchema.optional(),
  /** The table's item block and fields resolve inside this iframe's document. */
  frame: FrameSchema.optional(),
  item: ItemSchema.optional(),
  fields: z.array(FieldSchema).min(1, 'a table needs at least one field'),
});

/** Proxy URL schemes a browser accepts. */
export const PROXY_SCHEMES = ['http', 'https', 'socks5'] as const;

/** Parse a proxy URL; null when it is not one of the accepted schemes with a host. */
export function parseProxyUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, '');
  if (!(PROXY_SCHEMES as readonly string[]).includes(scheme) || !url.hostname) return null;
  return url;
}

/** Whether a value is an IANA timezone the runtime knows, canonical or alias. */
export function isTimezone(value: string): boolean {
  if (!value.includes('/') && value !== 'UTC') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Whether a value is a well-formed BCP 47 language tag. */
export function isLocale(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

export const TimezoneSchema = z.string().refine(isTimezone, { error: (issue) => `unknown timezone ${JSON.stringify(issue.input)}, expected an IANA identifier such as Europe/Madrid` });
export const LocaleSchema = z.string().refine(isLocale, { error: (issue) => `invalid locale ${JSON.stringify(issue.input)}, expected a BCP 47 tag such as es-ES` });

/** Network identity for a recipe's browser. Credentials never live in a recipe. */
/** A profile name: a directory name under the profiles directory, never a path. */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const RecipeBrowserSchema = z.object({
  proxy: z
    .object({
      server: z.string().superRefine((value, ctx) => {
        const url = parseProxyUrl(value);
        if (!url) ctx.addIssue({ code: 'custom', message: `invalid proxy URL ${JSON.stringify(value)}, expected ${PROXY_SCHEMES.join(', ')}://host:port` });
        else if (url.username || url.password) ctx.addIssue({ code: 'custom', message: 'credentials are not allowed in recipes; put them in the config or WEBSCOOP_PROXY_USERNAME and WEBSCOOP_PROXY_PASSWORD' });
      }),
      bypass: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  timezone: TimezoneSchema.optional(),
  locale: LocaleSchema.optional(),
  /** Humanized input for runs of this recipe. */
  humanize: z.boolean().optional(),
  /** Profile name the recipe's browser commands use unless `--profile` is given. */
  profile: z.string().regex(PROFILE_NAME, 'invalid profile name: start with a letter or digit, then letters, digits, ., _, or -').optional(),
});

const defaultGuards = () => GUARD_KINDS.map((kind) => ({ kind, enabled: true }));

const RecipeObjectSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  name: z.string().regex(KEBAB, 'recipe names must be kebab-case'),
  description: DescriptionSchema.optional(),
  url: z.string().min(1),
  vars: z.array(VarSchema).default([]),
  /** Shorthand for a single table named `items`; a recipe declares either this pair or `tables`. */
  item: ItemSchema.optional(),
  frame: FrameSchema.optional(),
  fields: z.array(FieldSchema).min(1, 'a recipe needs at least one field').optional(),
  tables: z.array(TableSchema).optional(),
  flows: z.array(FlowSchema).default([]),
  sequence: z.array(BlockSchema).min(1, 'a sequence needs at least one block'),
  guards: z.array(GuardSchema).default(defaultGuards),
  healing: HealingSchema.default(() => HealingSchema.parse({})),
  browser: RecipeBrowserSchema.optional(),
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
export type Frame = z.infer<typeof FrameSchema>;
export type Step = z.infer<typeof StepSchema>;
export type StepKind = Step['kind'];
export type StepWindow = Step['window'];
export type Flow = z.infer<typeof FlowSchema>;
export type FlowBlock = z.infer<typeof FlowBlockSchema>;
export type ExtractBlock = z.infer<typeof ExtractBlockSchema>;
export type InnerBlock = FlowBlock | ExtractBlock;
export type Paginate = z.output<typeof PaginateSchema>;
export type PaginateBlock = z.output<typeof PaginateBlockSchema>;
export type Block = FlowBlock | ExtractBlock | PaginateBlock;
export type Pagination = z.infer<typeof PaginationSchema>;
export type PaginationKind = Pagination['kind'];
export type Guard = z.infer<typeof GuardSchema>;
export type GuardKind = Guard['kind'];
export type Healing = z.infer<typeof HealingSchema>;
export type RecipeBrowser = z.infer<typeof RecipeBrowserSchema>;
export type Recipe = Omit<ParsedRecipe, 'fields' | 'tables'> & { fields?: RecipeField[]; tables?: RecipeTable[] };
/** Recipe as written on disk, before defaults are filled in. */
export type RecipeInput = z.input<typeof RecipeSchema>;
