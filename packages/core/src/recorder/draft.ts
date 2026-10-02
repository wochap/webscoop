import { parseNumber } from '../convert';
import { inlineVariable, renameVariable, templateProblem, templateVariables, VARIABLE_NAME } from '../template';
import type { Block, FieldScope, FieldType, Recipe, RecipeInput, SelectorCandidate, StepKind } from '../recipe/schema';
import { defaultSequence, paginateOf } from '../recipe/sequence';
import { SHORTHAND_TABLE, tablesOf } from '../recipe/tables';
import { validateRecipe } from '../recipe/validate';
import type {
  BlockPath,
  DescriptionTarget,
  Draft,
  DraftBlock,
  DraftField,
  DraftFlow,
  DraftInnerBlock,
  DraftItem,
  DraftPagination,
  DraftStep,
  DraftTable,
  FieldPatch,
  FlowPatch,
  FrameTarget,
  PaginationPatch,
  ProtocolCandidate,
  SequenceError,
  StepPatch,
  VarValue,
} from './protocol';
import { currentTable, tableMode } from './protocol';

/** Strip host-only data (match counts) from a candidate. */
export function bare(candidate: ProtocolCandidate): SelectorCandidate {
  return { strategy: candidate.strategy, value: candidate.value, stability: candidate.stability };
}

/** A field name from free text: lowercase identifier, at most 32 characters. */
export function slugName(text: string): string {
  const slug = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .replace(/_+$/, '');
  if (!slug) return 'field';
  return /^[0-9]/.test(slug) ? `f_${slug}` : slug;
}

export function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}_${i}`)) return `${base}_${i}`;
}

/** Text that is a number, possibly with a currency sign or unit, such as `$24.99` or `4.5`. */
export function isNumericText(text: string): boolean {
  const trimmed = text.trim();
  if (!/^[^\dA-Za-z]{0,3}\s?-?\d[\d,]*(?:\.\d+)?\s?[^\dA-Za-z]{0,3}$/.test(trimmed)) return false;
  return parseNumber(trimmed) !== null;
}

export interface PickedElement {
  tag: string;
  attrs: Record<string, string>;
  role?: string;
  name?: string;
  text: string;
}

export interface FieldDefaults {
  name: string;
  type: FieldType;
  attr?: string;
}

/**
 * Defaults for a new field: a unique name from the accessible name or text,
 * type `url` for links, `image` for images, `number` for numeric text, else
 * `text`, with the matching attribute.
 */
export function fieldDefaults(el: PickedElement, taken: readonly string[]): FieldDefaults {
  const name = uniqueName(slugName(el.name || el.text || el.attrs.alt || el.tag), taken);
  if (el.tag === 'a' && 'href' in el.attrs) return { name, type: 'url', attr: 'href' };
  if (el.tag === 'img') return { name, type: 'image', attr: 'src' };
  if (isNumericText(el.text)) return { name, type: 'number' };
  return { name, type: 'text' };
}

/** Variables the draft uses: those of the URL template, then those of `fill` step values, in order of first use. */
export function draftVariables(draft: { url: string; flows: readonly Pick<DraftFlow, 'steps'>[] }): string[] {
  const names = templateVariables(draft.url);
  for (const flow of draft.flows) {
    for (const step of flow.steps) {
      if (step.kind !== 'fill' || !step.value) continue;
      for (const name of templateVariables(step.value)) if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * The draft's variable list after its URL or steps changed: one entry per used
 * variable, keeping entered values, then the added variables nothing uses.
 */
function syncVars(draft: Draft): Draft {
  const names = draftVariables(draft);
  const vars = [
    ...names.map((name) => draft.vars.find((v) => v.name === name) ?? { name, value: '' }),
    ...draft.vars.filter((v) => v.added && !names.includes(v.name)),
  ];
  const same = vars.length === draft.vars.length && vars.every((v, i) => v === draft.vars[i]);
  return same ? draft : { ...draft, vars };
}

export function emptyDraft(opts: { name: string; url: string; vars: VarValue[] }): Draft {
  return validateDraft({
    name: opts.name,
    url: opts.url,
    vars: opts.vars,
    tables: [{ name: SHORTHAND_TABLE, item: null, fields: [], defaultName: true }],
    activeTable: 0,
    form: 'shorthand',
    flows: [],
    activeFlow: null,
    pagination: null,
    sequence: { custom: false, blocks: [] },
    sequenceErrors: [],
    dirty: false,
    errors: [],
  });
}

/** Settings of a freshly marked paginate block. */
export function newPagination(kind: DraftPagination['kind']): DraftPagination {
  return { kind, limit: 1, stopRules: [], delayMs: 0 };
}

/** Whether a table is still empty: no fields and no item container. */
const emptyTable = (t: DraftTable) => t.fields.length === 0 && t.item === null;

/**
 * Whether the draft saves no table: its only table is still empty and it has
 * flows, so the recipe only runs flows.
 */
export function flowsOnly(draft: Pick<Draft, 'tables' | 'flows'>): boolean {
  return draft.flows.length > 0 && draft.tables.length === 1 && emptyTable(draft.tables[0]!);
}

/** Names of the tables the recipe will have, in strip order. */
export function savedTables(draft: Pick<Draft, 'tables' | 'flows'>): string[] {
  return flowsOnly(draft) ? [] : draft.tables.map((t) => t.name);
}

/** The default sequence of the draft: called flows, then each table once, the paginate block around the driving table and those after it. */
export function defaultDraftSequence(draft: Pick<Draft, 'tables' | 'flows' | 'pagination'>): DraftBlock[] {
  const blocks = defaultSequence(
    draft.flows.map((f) => ({ name: f.name, ...(f.trigger ? { trigger: { appears: recipeTarget(f.trigger) } } : {}) })),
    savedTables(draft),
    draft.pagination ? { kind: draft.pagination.kind, limit: draft.pagination.limit, stopRules: draft.pagination.stopRules, delayMs: draft.pagination.delayMs, ...(draft.pagination.table ? { table: draft.pagination.table } : {}) } : null,
  );
  return blocks.map((b) => ('paginate' in b ? { paginate: { do: b.paginate.do } } : b));
}

/** The sequence the draft shows and saves: its own blocks once customized, else the default. */
export function draftSequence(draft: Pick<Draft, 'tables' | 'flows' | 'pagination' | 'sequence'>): DraftBlock[] {
  return draft.sequence.custom ? draft.sequence.blocks : defaultDraftSequence(draft);
}

/** The block at a path, or undefined. */
export function blockAt(blocks: readonly DraftBlock[], path: BlockPath): DraftBlock | DraftInnerBlock | undefined {
  const top = blocks[path[0]!];
  if (path.length === 1) return top;
  return top && 'paginate' in top ? top.paginate.do[path[1]!] : undefined;
}

/**
 * Move a block: take it out of its place and put it at `to`, a top level
 * position or a position inside the paginate block. A paginate block cannot
 * move inside itself; any other move is allowed and checked by validation.
 */
export function moveBlock(blocks: readonly DraftBlock[], from: BlockPath, to: BlockPath): DraftBlock[] {
  const block = blockAt(blocks, from);
  if (!block) return [...blocks];
  if ('paginate' in block && to.length === 2) return [...blocks];
  const out: DraftBlock[] = blocks.map((b) => ('paginate' in b ? { paginate: { do: [...b.paginate.do] } } : b));
  if (from.length === 1) out.splice(from[0]!, 1);
  else (out[from[0]!] as { paginate: { do: DraftInnerBlock[] } }).paginate.do.splice(from[1]!, 1);
  if (to.length === 1) {
    out.splice(Math.max(0, Math.min(to[0]!, out.length)), 0, block as DraftBlock);
  } else {
    // The paginate block's index may have shifted when the block came from above it.
    const paginateAt = out.findIndex((b) => 'paginate' in b);
    if (paginateAt < 0) return [...blocks];
    const inner = (out[paginateAt] as { paginate: { do: DraftInnerBlock[] } }).paginate.do;
    inner.splice(Math.max(0, Math.min(to[1]!, inner.length)), 0, block as DraftInnerBlock);
  }
  return out;
}

/** Rewrite the blocks naming a flow or table: `rename` returns the new name, or null to drop the block. */
function mapBlocks(blocks: readonly DraftBlock[], kind: 'flow' | 'extract', rename: (name: string) => string | null): DraftBlock[] {
  const one = <B extends DraftBlock | DraftInnerBlock>(b: B): B | null => {
    if (kind === 'flow' && 'flow' in b) {
      const name = rename(b.flow);
      return name === null ? null : ({ flow: name } as B);
    }
    if (kind === 'extract' && 'extract' in b) {
      const name = rename(b.extract);
      return name === null ? null : ({ extract: name } as B);
    }
    return b;
  };
  return blocks.flatMap((b): DraftBlock[] => {
    if ('paginate' in b) return [{ paginate: { do: b.paginate.do.flatMap((d) => one(d) ?? []) } }];
    const kept = one(b);
    return kept ? [kept] : [];
  });
}

/** In a custom sequence, the position for a new called flow block: before the first extract or paginate block. */
function flowInsertAt(blocks: readonly DraftBlock[]): number {
  const at = blocks.findIndex((b) => !('flow' in b));
  return at < 0 ? blocks.length : at;
}

/**
 * Whether the draft is written in the shorthand form: one table named
 * `items` that was not loaded from the `tables` form. Any other draft is
 * written with `tables`.
 */
export function isShorthand(draft: Pick<Draft, 'tables' | 'form'>): boolean {
  return draft.form === 'shorthand' && draft.tables.length === 1 && draft.tables[0]!.name === SHORTHAND_TABLE && !draft.tables[0]!.description;
}

function recipeItem(item: DraftItem) {
  return {
    selectors: item.selectors.map(bare),
    ...(item.within && item.within.length > 0 ? { within: item.within.map(bare) } : {}),
    ...(item.within && item.withinFingerprint ? { withinFingerprint: item.withinFingerprint } : {}),
    exclude: item.exclude.map(bare),
    ...(item.fingerprint ? { fingerprint: item.fingerprint } : {}),
  };
}

function recipeFrame(frame: FrameTarget) {
  return { selectors: frame.selectors.map(bare), ...(frame.fingerprint ? { fingerprint: frame.fingerprint } : {}) };
}

/** A step or pagination target as the recipe stores it. */
function recipeTarget(target: { selectors: ProtocolCandidate[]; fingerprint?: DraftField['fingerprint']; frame?: FrameTarget }) {
  return {
    selectors: target.selectors.map(bare),
    ...(target.fingerprint ? { fingerprint: target.fingerprint } : {}),
    ...(target.frame ? { frame: recipeFrame(target.frame) } : {}),
  };
}

/** A recipe frame as the draft holds it, counts unknown. */
function draftFrame(frame: { selectors: SelectorCandidate[]; fingerprint?: DraftField['fingerprint'] }): FrameTarget {
  return { selectors: frame.selectors.map(bare), ...(frame.fingerprint ? { fingerprint: frame.fingerprint } : {}) };
}

/** A recipe step or pagination target as the draft holds it. */
function draftTarget(target: { selectors: SelectorCandidate[]; fingerprint?: DraftField['fingerprint']; frame?: { selectors: SelectorCandidate[]; fingerprint?: DraftField['fingerprint'] } }) {
  return {
    selectors: target.selectors.map(bare),
    ...(target.fingerprint ? { fingerprint: target.fingerprint } : {}),
    ...(target.frame ? { frame: draftFrame(target.frame) } : {}),
  };
}

function recipeField(f: DraftField) {
  return {
    name: f.name,
    type: f.type,
    scope: f.scope,
    selectors: f.selectors.map(bare),
    ...(f.attr ? { attr: f.attr } : {}),
    optional: f.optional,
    ...(f.fallback ? { fallback: true } : {}),
    ...(f.hover ? { hover: true } : {}),
    ...(f.key ? { key: true } : {}),
    ...(f.fingerprint ? { fingerprint: f.fingerprint } : {}),
  };
}

/** Build the recipe document the draft describes, before validation. */
export function draftToRecipe(draft: Draft): RecipeInput {
  const declared = draftVariables(draft);
  const shorthand = isShorthand(draft);
  const first = draft.tables[0]!;
  const none = flowsOnly(draft);
  const recipe: RecipeInput = {
    schemaVersion: 2,
    name: draft.name,
    ...(draft.description ? { description: draft.description } : {}),
    url: draft.url,
    vars: draft.vars
      .filter((v) => declared.includes(v.name))
      .map((v) => ({ name: v.name, type: 'string' as const, ...(v.value !== '' ? { default: v.value } : {}), ...(v.description ? { description: v.description } : {}) })),
    ...(none
      ? {}
      : shorthand
      ? { fields: first.fields.map(recipeField) }
      : {
          tables: draft.tables.map((t) => ({
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            ...(t.frame ? { frame: recipeFrame(t.frame) } : {}),
            ...(t.item ? { item: recipeItem(t.item) } : {}),
            fields: t.fields.map(recipeField),
          })),
        }),
    sequence: [],
  };
  if (draft.flows.length > 0) {
    recipe.flows = draft.flows.map((f) => ({
      name: f.name,
      ...(f.description ? { description: f.description } : {}),
      ...(f.trigger ? { trigger: { appears: recipeTarget(f.trigger) } } : {}),
      ...(f.trigger && f.maxRetries !== undefined ? { maxRetries: f.maxRetries } : {}),
      ...(f.trigger && f.recover !== undefined ? { recover: f.recover } : {}),
      steps: f.steps.map((s) => ({
        kind: s.kind,
        ...(s.target ? { target: recipeTarget(s.target) } : {}),
        ...(s.value !== undefined ? { value: s.value } : {}),
        ...(s.until ? { until: s.until } : {}),
        ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
        ...(s.window === 'popup' ? { window: s.window } : {}),
        ...(s.optional ? { optional: true } : {}),
        ...(s.label ? { label: s.label } : {}),
      })),
    }));
  }
  if (!none && shorthand && first.item) recipe.item = recipeItem(first.item);
  if (!none && shorthand && first.frame) recipe.frame = recipeFrame(first.frame);
  const p = draft.pagination;
  recipe.sequence = draftSequence(draft).map((b): Block => {
    if (!('paginate' in b)) return b;
    return {
      paginate: {
        kind: p?.kind ?? 'next',
        ...(p?.target ? { target: recipeTarget(p.target) } : {}),
        ...(p?.param ? { param: p.param } : {}),
        limit: p?.limit ?? 1,
        stopRules: p?.stopRules ?? [],
        delayMs: p?.delayMs ?? 0,
        ...(p?.table ? { table: p.table } : {}),
        do: b.paginate.do,
      },
    };
  });
  if (draft.guards) recipe.guards = draft.guards;
  if (draft.healing) recipe.healing = draft.healing;
  if (draft.browser) recipe.browser = draft.browser;
  return recipe;
}

/**
 * Where a validation error belongs: `$.tables[t].fields[i]` and, in the
 * shorthand form, `$.fields[i]` name a field of a table; any other path
 * under `$.tables[t]` names the table.
 */
export function errorTarget(path: string): { table: number; index?: number } | null {
  const field = /^\$\.tables\[(\d+)\]\.fields\[(\d+)\]/.exec(path);
  if (field) return { table: Number(field[1]), index: Number(field[2]) };
  const shorthand = /^\$\.fields\[(\d+)\]/.exec(path);
  if (shorthand) return { table: 0, index: Number(shorthand[1]) };
  const table = /^\$\.tables\[(\d+)\]/.exec(path);
  return table ? { table: Number(table[1]) } : null;
}

/** The block a `$.sequence` error path names: `[i]`, `[i, j]` inside the paginate block, or null for the sequence as a whole. */
export function sequenceErrorPath(path: string): BlockPath | null | undefined {
  const inner = /^\$\.sequence\[(\d+)\]\.paginate\.do\[(\d+)\]/.exec(path);
  if (inner) return [Number(inner[1]), Number(inner[2])];
  const top = /^\$\.sequence\[(\d+)\]/.exec(path);
  if (top) return [Number(top[1])];
  return path === '$.sequence' ? null : undefined;
}

/** Recompute per-field, per-table, per-flow, per-step, sequence, name, and global validation errors. */
export function validateDraft(draft: Draft): Draft {
  const result = validateRecipe(draftToRecipe(draft));
  const fieldErrors = new Map<string, string>();
  const tableErrors = new Map<number, string>();
  const stepErrors = new Map<string, string>();
  const flowErrors = new Map<number, string>();
  const sequenceErrors: SequenceError[] = [];
  let nameError: string | undefined;
  const errors: Draft['errors'] = [];
  for (const error of result.errors) {
    const target = errorTarget(error.path);
    const step = /^\$\.flows\[(\d+)\]\.steps\[(\d+)\]/.exec(error.path);
    const flow = /^\$\.flows\[(\d+)\]/.exec(error.path);
    const block = sequenceErrorPath(error.path);
    if (target?.index !== undefined) {
      const key = `${target.table}:${target.index}`;
      if (!fieldErrors.has(key)) fieldErrors.set(key, error.message);
    } else if (target) {
      if (!tableErrors.has(target.table)) tableErrors.set(target.table, error.message);
    } else if (step) {
      const key = `${step[1]}:${step[2]}`;
      if (!stepErrors.has(key)) stepErrors.set(key, error.message);
    } else if (flow) {
      const index = Number(flow[1]);
      if (!flowErrors.has(index)) flowErrors.set(index, error.message);
    } else if (block !== undefined) {
      sequenceErrors.push({ path: block, message: error.message });
    } else if (error.path === '$.name') nameError ??= error.message;
    else errors.push(error);
  }
  const tables = draft.tables.map((table, t) => {
    const { error: _old, ...restTable } = table;
    const fields = table.fields.map((f, i) => {
      const { error: _old, ...rest } = f;
      const error = fieldErrors.get(`${t}:${i}`);
      return error ? { ...rest, error } : rest;
    });
    const error = tableErrors.get(t);
    return { ...restTable, fields, ...(error ? { error } : {}) };
  });
  const flows = draft.flows.map((f, fi) => {
    const { error: _old, ...restFlow } = f;
    const steps = f.steps.map((s, i) => {
      const { error: _old, ...rest } = s;
      const error = stepErrors.get(`${fi}:${i}`);
      return error ? { ...rest, error } : rest;
    });
    const error = flowErrors.get(fi);
    return { ...restFlow, steps, ...(error ? { error } : {}) };
  });
  const { nameError: _oldName, ...rest } = draft;
  const sequence = draft.sequence.custom ? draft.sequence : { custom: false, blocks: defaultDraftSequence(draft) };
  return { ...rest, ...(nameError ? { nameError } : {}), tables, flows, sequence, sequenceErrors, errors };
}

/** A draft for editing an existing recipe; counts are unknown until the page is counted. */
export function draftFromRecipe(recipe: Recipe, values: Readonly<Record<string, string>> = {}): Draft {
  const flows: DraftFlow[] = recipe.flows.map((f) => ({
    name: f.name,
    ...(f.description ? { description: f.description } : {}),
    ...(f.trigger ? { trigger: draftTarget(f.trigger.appears) } : {}),
    ...(f.maxRetries !== undefined ? { maxRetries: f.maxRetries } : {}),
    ...(f.recover !== undefined ? { recover: f.recover } : {}),
    steps: f.steps.map((s) => ({
      kind: s.kind,
      ...(s.target ? { target: draftTarget(s.target) } : {}),
      ...(s.value !== undefined ? { value: s.value } : {}),
      ...(s.until ? { until: s.until } : {}),
      ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
      window: s.window,
      optional: s.optional,
      ...(s.label ? { label: s.label } : {}),
      count: null,
    })),
  }));
  const vars = draftVariables({ url: recipe.url, flows }).map((name) => {
    const declared = recipe.vars.find((v) => v.name === name);
    return {
      name,
      value: values[name] ?? declared?.default ?? '',
      ...(declared?.description ? { description: declared.description } : {}),
    };
  });
  const tables: DraftTable[] = tablesOf(recipe).map((table) => ({
    name: table.name,
    ...(table.description ? { description: table.description } : {}),
    ...(table.frame ? { frame: draftFrame(table.frame) } : {}),
    item: table.item
      ? {
          selectors: table.item.selectors.map(bare),
          ...(table.item.within ? { within: table.item.within.map(bare), withinCount: null } : {}),
          ...(table.item.withinFingerprint ? { withinFingerprint: table.item.withinFingerprint } : {}),
          exclude: (table.item.exclude ?? []).map(bare),
          ...(table.item.fingerprint ? { fingerprint: table.item.fingerprint } : {}),
          count: null,
          total: null,
        }
      : null,
    fields: table.fields.map(
      (f): DraftField => ({
        name: f.name,
        type: f.type,
        scope: f.scope,
        selectors: f.selectors.map(bare),
        ...(f.attr ? { attr: f.attr } : {}),
        optional: f.optional,
        key: f.key ?? false,
        ...(f.fallback ? { fallback: true } : {}),
    ...(f.hover ? { hover: true } : {}),
        ...(f.fingerprint ? { fingerprint: f.fingerprint } : {}),
        count: null,
        sample: null,
      }),
    ),
  }));
  const p = paginateOf(recipe);
  const pagination: DraftPagination | null = p
    ? {
        kind: p.kind,
        ...(p.target ? { target: draftTarget(p.target) } : {}),
        ...(p.param ? { param: p.param } : {}),
        limit: p.limit,
        stopRules: p.stopRules,
        delayMs: p.delayMs,
        ...(p.table ? { table: p.table } : {}),
      }
    : null;
  const blocks: DraftBlock[] = recipe.sequence.map((b) => ('paginate' in b ? { paginate: { do: b.paginate.do } } : b));
  const shape = (list: readonly DraftBlock[]) => JSON.stringify(list);
  return validateDraft({
    name: recipe.name,
    ...(recipe.description ? { description: recipe.description } : {}),
    url: recipe.url,
    vars,
    tables,
    activeTable: 0,
    form: recipe.tables ? 'tables' : 'shorthand',
    flows,
    activeFlow: flows.length > 0 ? 0 : null,
    pagination,
    sequence: { custom: shape(blocks) !== shape(defaultDraftSequence({ tables, flows, pagination })), blocks },
    sequenceErrors: [],
    guards: recipe.guards,
    healing: recipe.healing,
    ...(recipe.browser ? { browser: recipe.browser } : {}),
    dirty: false,
    errors: [],
  });
}

/** Why a variable name cannot be used, or null: it must be an identifier and not taken by another variable. */
export function varNameError(draft: Pick<Draft, 'vars'>, name: string, except?: string): string | null {
  if (!VARIABLE_NAME.test(name)) return 'variable names are a letter or _ followed by letters, digits, or _';
  if (name !== except && draft.vars.some((v) => v.name === name)) return `a variable named "${name}" already exists`;
  return null;
}

/** The draft's flows with `rewrite` applied to every `fill` step value. */
function rewriteSteps(flows: readonly DraftFlow[], rewrite: (value: string) => string): DraftFlow[] {
  return flows.map((f) => ({ ...f, steps: f.steps.map((s) => (s.kind === 'fill' && s.value ? { ...s, value: rewrite(s.value) } : s)) }));
}

const FLOW_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why a flow name cannot be used, or null: it must be kebab-case and unique among the other flows. */
export function flowNameError(draft: Pick<Draft, 'flows'>, name: string, except?: number): string | null {
  if (!FLOW_NAME.test(name)) return 'flow names must be kebab-case';
  if (draft.flows.some((f, i) => i !== except && f.name === name)) return `a flow named "${name}" already exists`;
  return null;
}

/** Name for a new flow: `setup` for the first, else the first free `flow-N`. */
export function defaultFlowName(draft: Pick<Draft, 'flows'>, base?: string): string {
  const taken = draft.flows.map((f) => f.name);
  if (base) {
    if (!taken.includes(base)) return base;
    for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
  }
  if (!taken.includes('setup')) return 'setup';
  for (let n = draft.flows.length + 1; ; n++) if (!taken.includes(`flow-${n}`)) return `flow-${n}`;
}

const TABLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why a table name cannot be used, or null: it must be kebab-case and unique among the other tables. */
export function tableNameError(draft: Pick<Draft, 'tables'>, name: string, except?: number): string | null {
  if (!TABLE_NAME.test(name)) return 'table names must be kebab-case';
  if (draft.tables.some((t, i) => i !== except && t.name === name)) return `a table named "${name}" already exists`;
  return null;
}

/** Name for a new table: `page` when every table has an item container, else the first free `table-N`. */
export function defaultTableName(draft: Pick<Draft, 'tables'>): string {
  const taken = draft.tables.map((t) => t.name);
  if (draft.tables.every((t) => t.item !== null) && !taken.includes('page')) return 'page';
  for (let n = draft.tables.length + 1; ; n++) if (!taken.includes(`table-${n}`)) return `table-${n}`;
}

export interface NewField {
  name: string;
  type: FieldType;
  scope: FieldScope;
  selectors: ProtocolCandidate[];
  attr?: string;
  optional?: boolean;
  key?: boolean;
  fallback?: boolean;
  hover?: boolean;
  fingerprint?: DraftField['fingerprint'];
  count?: number | null;
  coverage?: DraftField['coverage'];
  sample?: string | null;
}

export interface NewDraftStep {
  kind: StepKind;
  target?: { selectors: ProtocolCandidate[]; fingerprint?: DraftField['fingerprint']; frame?: FrameTarget };
  value?: string;
  until?: DraftStep['until'];
  window?: DraftStep['window'];
  optional?: boolean;
  count?: number | null;
}

type DraftTarget = NonNullable<DraftStep['target']>;

/** Field and item actions act on the active table; count actions may name another. */
export type DraftAction =
  /** Add a table and activate it; `defaultName` marks a name the recorder chose. */
  | { type: 'addTable'; name: string; defaultName?: boolean }
  /** Remove the active table's fields and item container; the name and position stay. */
  | { type: 'clearTable' }
  /**
   * Move field `index` of the active table to the first table without an item
   * container, creating one named `page` (or `table-N`) when none exists. The
   * active table stays active.
   */
  | { type: 'moveFieldToPage'; index: number }
  /** Rename the active table; an invalid or taken name leaves the draft unchanged. */
  | { type: 'renameTable'; name: string }
  /** Remove the active table; the last table stays. */
  | { type: 'removeTable' }
  | { type: 'selectTable'; index: number }
  /** Move a table to another position; the active table stays the same table. */
  | { type: 'moveTable'; from: number; to: number }
  | { type: 'addField'; field: NewField }
  | { type: 'updateField'; index: number; patch: FieldPatch }
  /** Replace the field at `index` in place: options, selectors, fingerprint, and counts. */
  | { type: 'replaceField'; index: number; field: NewField }
  | {
      type: 'replaceSelectors';
      index: number;
      selectors: ProtocolCandidate[];
      fingerprint?: DraftField['fingerprint'];
      count: number | null;
      coverage?: DraftField['coverage'];
      sample: string | null;
    }
  | { type: 'removeField'; index: number }
  | { type: 'moveField'; from: number; to: number }
  | { type: 'setItem'; item: DraftItem | null }
  | { type: 'addExclusion'; candidate: ProtocolCandidate }
  | { type: 'removeExclusion'; index: number }
  | { type: 'setItemCounts'; count: number | null; total: number | null; withinCount?: number | null; table?: number }
  /** Set or clear (null) the item container's list parent. */
  | { type: 'setWithin'; within: ProtocolCandidate[] | null; fingerprint?: DraftField['fingerprint']; inferred?: boolean }
  | { type: 'setFieldCounts'; counts: { count: number | null; sample: string | null; coverage?: DraftField['coverage'] }[]; table?: number }
  /** Set or clear (null) the paginate settings; setting them wraps the driving table's extract in a custom sequence. */
  | { type: 'setPagination'; pagination: DraftPagination | null }
  | { type: 'updatePagination'; patch: PaginationPatch }
  /** Add a step to a flow (the active one when absent); without any flow the first step creates a called flow. */
  | { type: 'addStep'; step: NewDraftStep; flow?: number }
  | { type: 'updateStep'; flow: number; index: number; patch: StepPatch }
  | { type: 'replaceStepTarget'; flow: number; index: number; selectors: ProtocolCandidate[]; fingerprint?: DraftField['fingerprint']; frame?: FrameTarget; count: number | null }
  | { type: 'addFlow'; name: string }
  | { type: 'updateFlow'; index: number; patch: FlowPatch }
  /** Make a flow reactive with this trigger. */
  | { type: 'setTrigger'; index: number; trigger: DraftTarget }
  | { type: 'removeFlow'; index: number }
  | { type: 'duplicateFlow'; index: number }
  | { type: 'selectFlow'; index: number }
  | { type: 'moveBlock'; from: BlockPath; to: BlockPath }
  | { type: 'customizeSequence' }
  | { type: 'resetSequence' }
  /** Set or clear (null) the active table's frame. */
  | { type: 'setTableFrame'; frame: FrameTarget | null }
  /** Replace every frame target whose primary candidate is `key` (`strategy=value`): tables, step targets, and the pagination target. */
  | { type: 'replaceFrame'; key: string; frame: FrameTarget }
  | { type: 'removeStep'; flow: number; index: number }
  | { type: 'moveStep'; flow: number; from: number; to: number }
  /** Counts per flow, per step. */
  | { type: 'setStepCounts'; counts: (number | null)[][] }
  | { type: 'setName'; name: string }
  /** Set a description, trimmed; empty removes it. Length is checked by the session. */
  | { type: 'setDescription'; target: DescriptionTarget; text: string }
  /** Set `browser.humanize`, or remove it and drop an empty `browser` block. */
  | { type: 'setHumanize'; on: boolean }
  | { type: 'setVar'; name: string; value: string }
  /** Replace the URL template; an invalid template leaves the draft unchanged. */
  | { type: 'setUrl'; url: string }
  /** Add a variable nothing uses yet; an invalid or taken name leaves the draft unchanged. */
  | { type: 'addVar'; name: string }
  /** Rename a variable and each `{from}` in the template and `fill` step values. */
  | { type: 'renameVar'; from: string; to: string }
  /** Remove a variable; each use becomes its value, encoded in the template and raw in steps. */
  | { type: 'removeVar'; name: string }
  | { type: 'markSaved' };

/** The object with its `description` set to `text`, or removed when `text` is empty. */
function withDescription<T extends { description?: string }>(value: T, text: string): T {
  const { description: _, ...rest } = value;
  return (text ? { ...rest, description: text } : rest) as T;
}

/** Actions that only refresh live data and do not make the draft dirty. */
const CLEAN_ACTIONS = new Set<DraftAction['type']>(['setItemCounts', 'setFieldCounts', 'setStepCounts', 'markSaved', 'selectTable', 'selectFlow']);

/** Primary selector as a key, to tell whether two steps act on the same element. */
const targetKey = (step: { target?: { selectors: ProtocolCandidate[] } }) => {
  const primary = step.target?.selectors[0];
  return primary ? `${primary.strategy}=${primary.value}` : null;
};

function applyStepPatch(step: DraftStep, patch: StepPatch): DraftStep {
  const next: DraftStep = { ...step };
  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.window !== undefined) next.window = patch.window;
  if (patch.optional !== undefined) next.optional = patch.optional;
  if (patch.until === null) delete next.until;
  else if (patch.until !== undefined) next.until = patch.until;
  if (patch.timeoutMs === null) delete next.timeoutMs;
  else if (patch.timeoutMs !== undefined) next.timeoutMs = patch.timeoutMs;
  if (patch.value === null) delete next.value;
  else if (patch.value !== undefined) next.value = patch.value;
  if (patch.label === null || patch.label === '') delete next.label;
  else if (patch.label !== undefined) next.label = patch.label;
  return next;
}

function move<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [entry] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, entry!);
  return out;
}

function applyFieldPatch(field: DraftField, patch: FieldPatch): DraftField {
  const next: DraftField = { ...field };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.type !== undefined) next.type = patch.type;
  if (patch.scope !== undefined) next.scope = patch.scope;
  if (patch.optional !== undefined) next.optional = patch.optional;
  if (patch.key !== undefined) next.key = patch.key;
  if (patch.fallback !== undefined) next.fallback = patch.fallback;
  if (patch.hover !== undefined) next.hover = patch.hover;
  if (patch.attr === null || patch.attr === '') delete next.attr;
  else if (patch.attr !== undefined) next.attr = patch.attr;
  return next;
}

function toDraftField(f: NewField): DraftField {
  return {
    name: f.name,
    type: f.type,
    scope: f.scope,
    selectors: f.selectors,
    ...(f.attr ? { attr: f.attr } : {}),
    optional: f.optional ?? false,
    key: f.key ?? false,
    ...(f.fallback ? { fallback: true } : {}),
    ...(f.hover ? { hover: true } : {}),
    ...(f.fingerprint ? { fingerprint: f.fingerprint } : {}),
    count: f.count ?? null,
    ...(f.coverage !== undefined ? { coverage: f.coverage } : {}),
    sample: f.sample ?? null,
  };
}

/**
 * A table that just got its first field: a name the recorder chose becomes
 * `items` for a list or `page` for a page table, unless one of `others` has it.
 */
export function followMode(table: DraftTable, others: readonly DraftTable[]): DraftTable {
  if (!table.defaultName || table.fields.length === 0) return table;
  const { defaultName: _d, ...rest } = table;
  const name = tableMode(table) === 'list' ? SHORTHAND_TABLE : 'page';
  if (!others.some((t) => t.name === name)) return { ...rest, name };
  // A default name that says the other mode (a list still called `page`) gives way to a free `table-N`.
  const wrong = (name === SHORTHAND_TABLE && rest.name === 'page') || (name === 'page' && rest.name === SHORTHAND_TABLE);
  if (!wrong) return rest;
  const taken = new Set(others.map((t) => t.name));
  for (let n = others.length + 1; ; n++) if (!taken.has(`table-${n}`)) return { ...rest, name: `table-${n}` };
}

/** The draft with a flow's steps replaced. */
function withFlowSteps(draft: Draft, index: number, steps: DraftStep[]): Draft {
  return { ...draft, flows: draft.flows.map((f, i) => (i === index ? { ...f, steps } : f)) };
}

/** In a custom sequence, rename (or drop, with null) the blocks naming a flow or table. */
function withSequenceNames(draft: Draft, kind: 'flow' | 'extract', from: string, to: string | null): Draft {
  if (!draft.sequence.custom) return draft;
  return { ...draft, sequence: { custom: true, blocks: mapBlocks(draft.sequence.blocks, kind, (name) => (name === from ? to : name)) } };
}

/** The draft with table `index` replaced. */
function withTable(draft: Draft, index: number, table: DraftTable): Draft {
  return { ...draft, tables: draft.tables.map((t, i) => (i === index ? table : t)) };
}

/** The pure draft state machine. Every result is re-validated. */
export function reduceDraft(draft: Draft, action: DraftAction): Draft {
  let next: Draft = draft;
  const at = draft.activeTable;
  const table = currentTable(draft);
  const setActive = (patch: Partial<DraftTable>) => withTable(draft, at, { ...table, ...patch });
  switch (action.type) {
    case 'addTable':
      if (tableNameError(draft, action.name)) return draft;
      next = {
        ...draft,
        tables: [...draft.tables, { name: action.name, item: null, fields: [], ...(action.defaultName ? { defaultName: true } : {}) }],
        activeTable: draft.tables.length,
      };
      // A custom sequence extracts the new table at its end, so it stays valid.
      if (draft.sequence.custom) next = { ...next, sequence: { custom: true, blocks: [...draft.sequence.blocks, { extract: action.name }] } };
      break;
    case 'renameTable': {
      if (tableNameError(draft, action.name, at)) return draft;
      if (action.name === table.name) return draft;
      const { defaultName: _d, ...rest } = table;
      next = withSequenceNames(withTable(draft, at, { ...rest, name: action.name }), 'extract', table.name, action.name);
      break;
    }
    case 'clearTable': {
      const { frame: _frame, ...rest } = table;
      next = withTable(draft, at, { ...rest, item: null, fields: [] });
      break;
    }
    case 'setTableFrame': {
      const { frame: _frame, ...rest } = table;
      next = withTable(draft, at, action.frame ? { ...rest, frame: action.frame } : rest);
      break;
    }
    case 'replaceFrame': {
      const swap = <T extends { frame?: FrameTarget }>(owner: T): T => {
        const primary = owner.frame?.selectors[0];
        return primary && `${primary.strategy}=${primary.value}` === action.key ? { ...owner, frame: action.frame } : owner;
      };
      const pagination = draft.pagination;
      next = {
        ...draft,
        tables: draft.tables.map(swap),
        flows: draft.flows.map((f) => ({
          ...f,
          ...(f.trigger ? { trigger: swap(f.trigger) } : {}),
          steps: f.steps.map((st) => (st.target ? { ...st, target: swap(st.target) } : st)),
        })),
        pagination: pagination?.target ? { ...pagination, target: swap(pagination.target) } : pagination,
      };
      break;
    }
    case 'moveFieldToPage': {
      const field = table.fields[action.index];
      if (!field) return draft;
      const { coverage: _c, ...moved } = field;
      let tables = draft.tables.map((t, i) => (i === at ? { ...t, fields: t.fields.filter((_, j) => j !== action.index) } : t));
      let target = tables.findIndex((t) => t.item === null);
      if (target === -1) {
        tables = [...tables, { name: defaultTableName({ tables }), item: null, fields: [], defaultName: true }];
        target = tables.length - 1;
      }
      const into = tables[target]!;
      const name = uniqueName(moved.name, into.fields.map((f) => f.name));
      const fields = [...into.fields, { ...moved, name, scope: 'page' as const, ...(moved.key && into.fields.some((f) => f.key) ? { key: false } : {}) }];
      const others = tables.filter((_, i) => i !== target);
      tables = tables.map((t, i) => (i === target ? followMode({ ...into, fields }, others) : t));
      next = { ...draft, tables };
      break;
    }
    case 'removeTable': {
      if (draft.tables.length < 2) return draft;
      const tables = draft.tables.filter((_, i) => i !== at);
      next = withSequenceNames({ ...draft, tables, activeTable: Math.min(at, tables.length - 1) }, 'extract', table.name, null);
      if (next.pagination?.table === table.name) {
        const { table: _t, ...settings } = next.pagination;
        next = { ...next, pagination: settings };
      }
      break;
    }
    case 'selectTable':
      if (!draft.tables[action.index] || action.index === at) return draft;
      next = { ...draft, activeTable: action.index };
      break;
    case 'moveTable': {
      if (!draft.tables[action.from] || action.from === action.to) return draft;
      const tables = move(draft.tables, action.from, action.to);
      next = { ...draft, tables, activeTable: tables.indexOf(draft.tables[at]!) };
      break;
    }
    case 'addField': {
      const field = toDraftField(action.field);
      let fields = [...table.fields, field];
      if (field.key) fields = fields.map((other, i) => (i === fields.length - 1 ? other : { ...other, key: false }));
      const others = draft.tables.filter((_, i) => i !== at);
      next = withTable(draft, at, followMode({ ...table, fields }, others));
      break;
    }
    case 'replaceField': {
      const prev = table.fields[action.index];
      if (!prev) return draft;
      // The fallback and hover flags are set on the field row, not in the selection form: keep them unless the field says otherwise.
      const field = toDraftField({
        ...action.field,
        fallback: action.field.fallback ?? prev.fallback ?? false,
        hover: action.field.hover ?? prev.hover ?? false,
      });
      const fields = table.fields.map((f, i) => (i === action.index ? field : field.key ? { ...f, key: false } : f));
      next = setActive({ fields });
      break;
    }
    case 'updateField': {
      let fields = table.fields.map((f, i) => (i === action.index ? applyFieldPatch(f, action.patch) : f));
      if (action.patch.key) fields = fields.map((f, i) => (i === action.index ? f : { ...f, key: false }));
      next = setActive({ fields });
      break;
    }
    case 'replaceSelectors':
      next = setActive({
        fields: table.fields.map((f, i) => {
          if (i !== action.index) return f;
          const { fingerprint: _fp, ...rest } = f;
          return {
            ...rest,
            selectors: action.selectors,
            ...(action.fingerprint ? { fingerprint: action.fingerprint } : {}),
            count: action.count,
            ...(action.coverage !== undefined ? { coverage: action.coverage } : {}),
            sample: action.sample,
          };
        }),
      });
      break;
    case 'removeField':
      next = setActive({ fields: table.fields.filter((_, i) => i !== action.index) });
      break;
    case 'moveField':
      next = setActive({ fields: move(table.fields, action.from, action.to) });
      break;
    case 'setItem':
      next = setActive({
        item: action.item,
        fields: action.item ? table.fields : table.fields.map((f) => (f.scope === 'item' ? { ...f, scope: 'page' as const } : f)),
      });
      break;
    case 'addExclusion':
      if (!table.item) return draft;
      next = setActive({ item: { ...table.item, exclude: [...table.item.exclude, action.candidate] } });
      break;
    case 'removeExclusion':
      if (!table.item) return draft;
      next = setActive({ item: { ...table.item, exclude: table.item.exclude.filter((_, i) => i !== action.index) } });
      break;
    case 'setItemCounts': {
      const t = action.table ?? at;
      const target = draft.tables[t];
      if (!target?.item) return draft;
      next = withTable(draft, t, {
        ...target,
        item: { ...target.item, count: action.count, total: action.total, ...(action.withinCount !== undefined && target.item.within ? { withinCount: action.withinCount } : {}) },
      });
      break;
    }
    case 'setWithin': {
      if (!table.item) return draft;
      const { within: _w, withinFingerprint: _f, withinCount: _c, withinInferred: _i, ...rest } = table.item;
      next = setActive({
        item: action.within && action.within.length > 0
          ? {
              ...rest,
              within: action.within,
              ...(action.fingerprint ? { withinFingerprint: action.fingerprint } : {}),
              withinCount: action.within[0]!.count ?? null,
              ...(action.inferred ? { withinInferred: true } : {}),
            }
          : rest,
      });
      break;
    }
    case 'setFieldCounts': {
      const t = action.table ?? at;
      const target = draft.tables[t];
      if (!target) return draft;
      next = withTable(draft, t, { ...target, fields: target.fields.map((f, i) => (action.counts[i] ? { ...f, ...action.counts[i] } : f)) });
      break;
    }
    case 'setPagination': {
      next = { ...draft, pagination: action.pagination };
      const blocks = draft.sequence.blocks;
      if (draft.sequence.custom && action.pagination && !blocks.some((b) => 'paginate' in b)) {
        // Marking pagination wraps the driving table's extract block in a new paginate block, where it stood.
        const driving = action.pagination.table ?? table.name;
        const at = blocks.findIndex((b) => 'extract' in b && b.extract === driving);
        const wrapped: DraftBlock[] = at < 0 ? [...blocks, { paginate: { do: [{ extract: driving }] } }] : blocks.map((b, i) => (i === at ? { paginate: { do: [{ extract: driving }] } } : b));
        next = { ...next, sequence: { custom: true, blocks: wrapped } };
      } else if (draft.sequence.custom && !action.pagination) {
        // Clearing pagination keeps the blocks it repeated, in place.
        next = { ...next, sequence: { custom: true, blocks: blocks.flatMap((b) => ('paginate' in b ? b.paginate.do : [b])) } };
      }
      break;
    }
    case 'updatePagination': {
      if (!draft.pagination) return draft;
      const { table: driving, ...patch } = action.patch;
      const { table: _t, ...settings } = draft.pagination;
      next = { ...draft, pagination: { ...settings, ...patch, ...(driving === null ? {} : driving !== undefined ? { table: driving } : draft.pagination.table ? { table: draft.pagination.table } : {}) } };
      break;
    }
    case 'addFlow': {
      if (flowNameError(draft, action.name)) return draft;
      const flows = [...draft.flows, { name: action.name, steps: [] }];
      next = { ...draft, flows, activeFlow: flows.length - 1 };
      if (draft.sequence.custom) {
        const blocks = [...draft.sequence.blocks];
        blocks.splice(flowInsertAt(blocks), 0, { flow: action.name });
        next = { ...next, sequence: { custom: true, blocks } };
      }
      break;
    }
    case 'updateFlow': {
      const flow = draft.flows[action.index];
      if (!flow) return draft;
      const { patch } = action;
      let updated: DraftFlow = { ...flow };
      if (patch.name !== undefined && patch.name !== flow.name) {
        if (flowNameError(draft, patch.name, action.index)) return draft;
        updated.name = patch.name;
      }
      if (patch.trigger === null) {
        const { trigger: _t, maxRetries: _m, recover: _r, ...rest } = updated;
        updated = rest;
      }
      if (patch.maxRetries === null) delete updated.maxRetries;
      else if (patch.maxRetries !== undefined) updated.maxRetries = patch.maxRetries;
      if (patch.recover === null) delete updated.recover;
      else if (patch.recover !== undefined) updated.recover = patch.recover;
      next = { ...draft, flows: draft.flows.map((f, i) => (i === action.index ? updated : f)) };
      if (updated.name !== flow.name) next = withSequenceNames(next, 'flow', flow.name, updated.name);
      if (flow.trigger && !updated.trigger && next.sequence.custom) {
        // A flow made called again runs where called flows start.
        const blocks = [...next.sequence.blocks];
        blocks.splice(flowInsertAt(blocks), 0, { flow: updated.name });
        next = { ...next, sequence: { custom: true, blocks } };
      }
      break;
    }
    case 'setTrigger': {
      const flow = draft.flows[action.index];
      if (!flow) return draft;
      next = withSequenceNames({ ...draft, flows: draft.flows.map((f, i) => (i === action.index ? { ...f, trigger: action.trigger } : f)) }, 'flow', flow.name, null);
      break;
    }
    case 'removeFlow': {
      const flow = draft.flows[action.index];
      if (!flow) return draft;
      const flows = draft.flows.filter((_, i) => i !== action.index);
      const active = draft.activeFlow;
      const activeFlow = flows.length === 0 ? null : active === null ? 0 : active > action.index ? active - 1 : Math.min(active, flows.length - 1);
      next = withSequenceNames({ ...draft, flows, activeFlow }, 'flow', flow.name, null);
      break;
    }
    case 'duplicateFlow': {
      const flow = draft.flows[action.index];
      if (!flow) return draft;
      const copy: DraftFlow = { ...structuredClone(flow), name: defaultFlowName(draft, `${flow.name}-copy`) };
      const flows = [...draft.flows.slice(0, action.index + 1), copy, ...draft.flows.slice(action.index + 1)];
      next = { ...draft, flows, activeFlow: action.index + 1 };
      if (draft.sequence.custom && !copy.trigger) {
        const blocks = [...draft.sequence.blocks];
        blocks.splice(flowInsertAt(blocks), 0, { flow: copy.name });
        next = { ...next, sequence: { custom: true, blocks } };
      }
      break;
    }
    case 'selectFlow':
      if (!draft.flows[action.index] || action.index === draft.activeFlow) return draft;
      next = { ...draft, activeFlow: action.index };
      break;
    case 'moveBlock':
      next = { ...draft, sequence: { custom: true, blocks: moveBlock(draftSequence(draft), action.from, action.to) } };
      break;
    case 'customizeSequence':
      if (draft.sequence.custom) return draft;
      next = { ...draft, sequence: { custom: true, blocks: draftSequence(draft) } };
      break;
    case 'resetSequence':
      if (!draft.sequence.custom) return draft;
      next = { ...draft, sequence: { custom: false, blocks: defaultDraftSequence(draft) } };
      break;
    case 'addStep': {
      const s = action.step;
      const step: DraftStep = {
        kind: s.kind,
        ...(s.target
          ? { target: { selectors: s.target.selectors, ...(s.target.fingerprint ? { fingerprint: s.target.fingerprint } : {}), ...(s.target.frame ? { frame: s.target.frame } : {}) } }
          : {}),
        ...(s.value !== undefined ? { value: s.value } : {}),
        ...(s.until ? { until: s.until } : {}),
        window: s.window ?? 'same',
        optional: s.optional ?? false,
        count: s.count ?? null,
      };
      let base = draft;
      let index = action.flow ?? draft.activeFlow;
      if (index === null || !draft.flows[index]) {
        // The first recorded step creates a called flow, makes it active, and puts it in the sequence.
        base = reduceDraft(draft, { type: 'addFlow', name: defaultFlowName(draft) });
        index = base.flows.length - 1;
      }
      const flow = base.flows[index]!;
      const last = flow.steps.at(-1);
      // Typing into the same input again replaces the value instead of adding a step.
      const replaces = step.kind === 'fill' && last?.kind === 'fill' && targetKey(last) !== null && targetKey(last) === targetKey(step) && last.window === step.window;
      const steps = replaces ? [...flow.steps.slice(0, -1), { ...last, value: step.value ?? '' }] : [...flow.steps, step];
      next = withFlowSteps(base, index, steps);
      break;
    }
    case 'updateStep': {
      const flow = draft.flows[action.flow];
      if (!flow) return draft;
      next = withFlowSteps(draft, action.flow, flow.steps.map((s, i) => (i === action.index ? applyStepPatch(s, action.patch) : s)));
      break;
    }
    case 'replaceStepTarget': {
      const flow = draft.flows[action.flow];
      if (!flow) return draft;
      next = withFlowSteps(
        draft,
        action.flow,
        flow.steps.map((s, i) =>
          i === action.index
            ? { ...s, target: { selectors: action.selectors, ...(action.fingerprint ? { fingerprint: action.fingerprint } : {}), ...(action.frame ? { frame: action.frame } : {}) }, count: action.count }
            : s,
        ),
      );
      break;
    }
    case 'removeStep': {
      const flow = draft.flows[action.flow];
      if (!flow) return draft;
      next = withFlowSteps(draft, action.flow, flow.steps.filter((_, i) => i !== action.index));
      break;
    }
    case 'moveStep': {
      const flow = draft.flows[action.flow];
      if (!flow) return draft;
      next = withFlowSteps(draft, action.flow, move(flow.steps, action.from, action.to));
      break;
    }
    case 'setStepCounts':
      next = {
        ...draft,
        flows: draft.flows.map((f, fi) => ({ ...f, steps: f.steps.map((s, i) => (action.counts[fi]?.[i] !== undefined ? { ...s, count: action.counts[fi]![i]! } : s)) })),
      };
      break;
    case 'setName':
      next = { ...draft, name: action.name };
      break;
    case 'setDescription': {
      const text = action.text.trim();
      const target = action.target;
      if (target.kind === 'recipe') next = withDescription(draft, text);
      else if (target.kind === 'table') {
        if (!draft.tables[target.index]) return draft;
        next = { ...draft, tables: draft.tables.map((t, i) => (i === target.index ? withDescription(t, text) : t)) };
      } else {
        if (!draft.vars.some((v) => v.name === target.name)) return draft;
        next = { ...draft, vars: draft.vars.map((v) => (v.name === target.name ? withDescription(v, text.replace(/\s*[\r\n]+\s*/g, ' ')) : v)) };
      }
      break;
    }
    case 'setHumanize': {
      const { humanize: _, ...rest } = draft.browser ?? {};
      const browser = action.on ? { ...rest, humanize: true } : rest;
      const { browser: __, ...others } = draft;
      next = Object.keys(browser).length > 0 ? { ...others, browser } : others;
      break;
    }
    case 'setVar':
      next = { ...draft, vars: draft.vars.map((v) => (v.name === action.name ? { ...v, value: action.value } : v)) };
      break;
    case 'setUrl':
      if (action.url === draft.url || templateProblem(action.url)) return draft;
      next = { ...draft, url: action.url };
      break;
    case 'addVar':
      if (varNameError(draft, action.name)) return draft;
      next = { ...draft, vars: [...draft.vars, { name: action.name, value: '', added: true }] };
      break;
    case 'renameVar': {
      const { from, to } = action;
      if (from === to || !draft.vars.some((v) => v.name === from) || varNameError(draft, to)) return draft;
      next = {
        ...draft,
        url: renameVariable(draft.url, from, to),
        flows: rewriteSteps(draft.flows, (value) => renameVariable(value, from, to)),
        vars: draft.vars.map((v) => (v.name === from ? { ...v, name: to } : v)),
      };
      break;
    }
    case 'removeVar': {
      const variable = draft.vars.find((v) => v.name === action.name);
      if (!variable) return draft;
      next = {
        ...draft,
        url: inlineVariable(draft.url, variable.name, variable.value, true),
        flows: rewriteSteps(draft.flows, (value) => inlineVariable(value, variable.name, variable.value, false)),
        vars: draft.vars.filter((v) => v !== variable),
      };
      break;
    }
    case 'markSaved':
      next = { ...draft, dirty: false };
      break;
  }
  if (!CLEAN_ACTIONS.has(action.type)) next = { ...next, dirty: true };
  return validateDraft(syncVars(next));
}

/** Whether the draft can be saved: it validates with the recipe schema. Errors under a table name it, and the field when there is one. */
export function draftErrors(draft: Draft): { path: string; message: string; table?: number; index?: number }[] {
  const result = validateRecipe(draftToRecipe(draft));
  return result.errors.map((e) => {
    const target = errorTarget(e.path);
    return target ? { ...e, table: target.table, ...(target.index !== undefined ? { index: target.index } : {}) } : e;
  });
}

export interface PaginationTarget {
  tag: string;
  attrs: Record<string, string>;
  role?: string;
}

export type DetectedPagination = Pick<DraftPagination, 'kind' | 'param'>;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function numericParamChange(current: URL, target: URL): DraftPagination['param'] | null {
  const keys = new Set([...current.searchParams.keys(), ...target.searchParams.keys()]);
  let found: DraftPagination['param'] | null = null;
  for (const key of keys) {
    const a = current.searchParams.get(key);
    const b = target.searchParams.get(key);
    if (a === b) continue;
    if (found || b === null || !/^\d+$/.test(b) || (a !== null && !/^\d+$/.test(a)) || !IDENT.test(key)) return null;
    const start = a === null ? 1 : Number(a);
    const step = Number(b) - start;
    if (step === 0) return null;
    found = { name: key, start, step };
  }
  return found;
}

function numericSegmentChange(current: URL, target: URL): DraftPagination['param'] | null {
  const a = current.pathname.split('/');
  const b = target.pathname.split('/');
  if (current.search !== target.search) return null;
  let found: DraftPagination['param'] | null = null;
  if (a.length === b.length) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (found || !/^\d+$/.test(a[i]!) || !/^\d+$/.test(b[i]!)) return null;
      const previous = b[i - 1] ?? '';
      const start = Number(a[i]);
      found = { name: IDENT.test(previous) ? previous : 'page', start, step: Number(b[i]) - start };
    }
  }
  return found && found.step !== 0 ? found : null;
}

/**
 * Guess the pagination kind from the element marked as the target: `url` for
 * a link that differs from the current URL only by a numeric query parameter
 * or path segment, `next` for any other link, `more` for a button.
 */
export function detectPagination(target: PaginationTarget, currentUrl: string): DetectedPagination {
  const isButton =
    target.tag === 'button' ||
    target.role === 'button' ||
    (target.tag === 'input' && ['button', 'submit'].includes(target.attrs.type ?? ''));
  if (isButton) return { kind: 'more' };
  const href = target.attrs.href;
  if (target.tag === 'a' && href !== undefined) {
    try {
      const current = new URL(currentUrl);
      const next = new URL(href, currentUrl);
      if (current.origin === next.origin) {
        const param =
          current.pathname === next.pathname ? numericParamChange(current, next) : numericSegmentChange(current, next);
        if (param) return { kind: 'url', param };
      }
    } catch {
      // Not a URL we can compare; fall through to `next`.
    }
    return { kind: 'next' };
  }
  return { kind: 'more' };
}
