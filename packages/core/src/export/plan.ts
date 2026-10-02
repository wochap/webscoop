import { defaultAttr } from '../convert';
import { DEFAULT_PAGE_CAP } from '../pagination/types';
import type { Block, FieldScope, FieldType, InnerBlock, PaginationKind, Recipe, SelectorCandidate, StepKind } from '../recipe/schema';
import { drivingTable, paginateOf, paginationOf, walkBlocks } from '../recipe/sequence';
import { primaryTableIndex, tablesOf } from '../recipe/tables';
import { WAIT_POLL_MS } from '../flows/replay';
import { templateVariables } from '../template';

/** A selector as the exported script uses it: strategy and value, without the recorder's stability rating. */
export interface PlanSelector {
  strategy: SelectorCandidate['strategy'];
  value: string;
}

export interface PlanVar {
  name: string;
  /** Recipe default, or null when a value must be given. */
  default: string | null;
  /** Whether the run cannot start without a value: used in the URL template or in a `fill` step. */
  required: boolean;
}

/** What a step does once its target (if any) is found. Defaults are already resolved. */
export type PlanAction =
  | { kind: 'click' }
  /** Type into a text input, or choose the option of a native select by value or label. */
  | { kind: 'fill'; text: string }
  | { kind: 'press'; key: string }
  /** A `wait` with a target: poll for it. */
  | { kind: 'wait-for' }
  /** A `wait` without a target: sleep. */
  | { kind: 'sleep'; ms: number };

/** When a plan step runs: flows before the extracts run on the first page, flows inside the paginate block on every page. */
export type PlanWhen = 'first-page' | 'every-page';

export interface PlanStep {
  /** Position among every step of the plan. */
  index: number;
  /** The flow the step belongs to, and its index there. */
  flow: string;
  step: number;
  kind: StepKind;
  /** The label, else `flow:N`, as the runner names it. */
  name: string;
  when: PlanWhen;
  optional: boolean;
  target: PlanSelector[] | null;
  action: PlanAction;
}

/** How a field's raw string is read from its element. */
export type ReadMode = 'attr' | 'html' | 'text';

export interface PlanField {
  name: string;
  type: FieldType;
  scope: FieldScope;
  optional: boolean;
  /** Per row, walk the settled candidates instead of using only the settled primary. */
  fallback: boolean;
  /** Move the mouse over the element before reading it. */
  hover: boolean;
  selectors: PlanSelector[];
  read: ReadMode;
  /** Attribute read when `read` is `attr`, else null. */
  attr: string | null;
}

export interface PlanPagination {
  kind: PaginationKind;
  /** Page variable for kind `url`, else null. */
  param: { name: string; start: number; step: number } | null;
  /** Whether the URL template holds the page variable; when not, it is set as a query parameter. */
  paramInTemplate: boolean;
  /** Next link or load-more button, for kinds `next` and `more`. */
  target: PlanSelector[] | null;
  limit: number | 'all';
  /** Most pages `all` walks. */
  cap: number;
  stopRules: string[];
  delayMs: number;
}

/** Timing constants copied from the runner and the browser adapter. */
export interface PlanTimings {
  /** Navigation, settle, `wait` step, and growth timeout. */
  navigationMs: number;
  /** Default Playwright action timeout. */
  actionMs: number;
  /** How long settling waits for an action to start a navigation. */
  settleGraceMs: number;
  /** How long settling waits for network idle when nothing navigated. */
  settleIdleMs: number;
  /** Interval between looks for a `wait` step's target. */
  waitPollMs: number;
  /** Interval between item counts while a `more` or `scroll` page grows. */
  growthPollMs: number;
}

/** One table of the recipe: what the script extracts on every page. */
export interface PlanTable {
  name: string;
  /** Item container; `within` is the list parent, present only when the recipe has one. Null for a table that yields one row per page. */
  item: { selectors: PlanSelector[]; within?: PlanSelector[]; exclude: PlanSelector[] } | null;
  fields: PlanField[];
  /** Name of the dedup key field, or null to dedup by all field values. */
  key: string | null;
}

/** A recipe as a language-neutral list of what the exported script does, with every schema default resolved. */
export interface ExportPlan {
  recipe: string;
  url: string;
  vars: PlanVar[];
  steps: PlanStep[];
  /** Every table, in sequence order; the shorthand form is one table named `items`. */
  tables: PlanTable[];
  /** Index of the driving table (the paginate block's, else the first with an item block), which drives item counts and the stop rules; -1 when none has one. */
  primary: number;
  pagination: PlanPagination;
  timings: PlanTimings;
}

/** Runner defaults the export copies (`Runner` navigation timeout, `PlaywrightBrowser` action timeout and settle bounds). */
export const EXPORT_TIMINGS: PlanTimings = {
  navigationMs: 30_000,
  actionMs: 5000,
  settleGraceMs: 500,
  settleIdleMs: 2000,
  waitPollMs: WAIT_POLL_MS,
  growthPollMs: 200,
};

/** Index of the driving table among the plan's tables, else of the first item table; -1 when none has an item block. */
function primary(recipe: Recipe, tables: ReturnType<typeof tablesOf>): number {
  const block = paginateOf(recipe);
  const driving = block ? drivingTable(block, tables) : null;
  return driving !== null ? tables.findIndex((t) => t.name === driving) : primaryTableIndex(tables);
}

const selectors = (candidates: readonly SelectorCandidate[]): PlanSelector[] => candidates.map(({ strategy, value }) => ({ strategy, value }));

function readMode(type: FieldType, attr: string | undefined): ReadMode {
  if (attr) return 'attr';
  return type === 'html' ? 'html' : 'text';
}

/** A recipe uses something the exported script cannot do. */
export class ExportUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportUnsupportedError';
  }
}

/** Where the recipe first uses an iframe target, or null when it uses none. */
function firstFrame(recipe: Recipe): string | null {
  const table = tablesOf(recipe).find((t) => t.frame);
  if (table) return `table "${table.name}"`;
  for (const flow of recipe.flows) {
    const index = flow.steps.findIndex((s) => s.target?.frame);
    if (index >= 0) return `step "${flow.steps[index]!.label ?? `${flow.name}:${index}`}" of flow "${flow.name}"`;
  }
  return paginateOf(recipe)?.target?.frame ? 'the pagination target' : null;
}

/** Flow names before the extracts and inside the paginate block, for a sequence of the classic shape; throws naming the first block that breaks it. */
function classicShape(sequence: readonly Block[]): { before: string[]; every: string[] } {
  const before: string[] = [];
  let index = 0;
  for (; index < sequence.length; index++) {
    const block = sequence[index]!;
    if (!('flow' in block)) break;
    before.push(block.flow);
  }
  const rest = sequence.slice(index);
  const notClassic = (at: string) =>
    new ExportUnsupportedError(`export supports a sequence of flows followed by extracts or by one paginate block; ${at} breaks that shape`);
  const extractsOnly = (blocks: readonly (Block | InnerBlock)[], offset: number, where: string) => {
    blocks.forEach((b, i) => {
      if (!('extract' in b)) throw notClassic(`block ${offset + i}${where}`);
    });
  };
  const first = rest[0];
  if (first && 'paginate' in first) {
    if (rest.length > 1) throw notClassic(`block ${index + 1}`);
    const inner = first.paginate.do;
    const every: string[] = [];
    let i = 0;
    for (; i < inner.length && 'flow' in inner[i]!; i++) every.push((inner[i] as { flow: string }).flow);
    extractsOnly(inner.slice(i), i, ` of the paginate block's do`);
    return { before, every };
  }
  extractsOnly(rest, index, '');
  return { before, every: [] };
}

/** The first flow feature export cannot replay: a reactive flow, an `await-user` step, or a popup step. */
function unsupportedFlow(recipe: Recipe): string | null {
  for (const flow of recipe.flows) {
    if (flow.trigger) return `reactive flow "${flow.name}" is not supported by export`;
    for (const [index, step] of flow.steps.entries()) {
      const name = `step "${step.label ?? `${flow.name}:${index}`}" of flow "${flow.name}"`;
      if (step.kind === 'await-user') return `${name} is an await-user step, which export does not support`;
      if (step.window === 'popup') return `${name} acts in a popup, which export does not support`;
    }
  }
  return null;
}

/** Turn a validated recipe into the plan both renderers share. Throws `ExportUnsupportedError` for a recipe export cannot run. */
export function buildPlan(recipe: Recipe): ExportPlan {
  const unsupported = unsupportedFlow(recipe);
  if (unsupported) throw new ExportUnsupportedError(unsupported);
  const framed = firstFrame(recipe);
  if (framed) throw new ExportUnsupportedError(`iframe targets are not supported by export: ${framed} uses frame`);
  const shape = classicShape(recipe.sequence);
  const pagination = paginationOf(recipe);
  const order = walkBlocks(recipe.sequence).flatMap((b) => ('extract' in b ? [b.extract] : []));
  const recipeTables = tablesOf(recipe)
    .slice()
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  const pageParam = pagination.kind === 'url' ? (pagination.param ?? null) : null;

  // Variables the run needs before the browser opens; the page variable has its own start value.
  const needed = new Set(templateVariables(recipe.url));
  for (const flow of recipe.flows) for (const step of flow.steps) if (step.kind === 'fill' && step.value) for (const name of templateVariables(step.value)) needed.add(name);
  if (pageParam) needed.delete(pageParam.name);
  const vars: PlanVar[] = recipe.vars.map((v) => ({ name: v.name, default: v.default ?? null, required: needed.has(v.name) }));
  for (const name of needed) if (!recipe.vars.some((v) => v.name === name)) vars.push({ name, default: null, required: true });

  const steps: PlanStep[] = [];
  const addFlow = (name: string, when: PlanWhen) => {
    const flow = recipe.flows.find((f) => f.name === name)!;
    for (const [index, step] of flow.steps.entries()) {
      const target = step.target ? selectors(step.target.selectors) : null;
      let action: PlanAction;
      switch (step.kind) {
        case 'click':
          action = { kind: 'click' };
          break;
        case 'fill':
          action = { kind: 'fill', text: step.value ?? '' };
          break;
        case 'press':
          action = { kind: 'press', key: step.value ?? 'Enter' };
          break;
        case 'wait':
          action = target ? { kind: 'wait-for' } : { kind: 'sleep', ms: Number(step.value ?? 0) };
          break;
        case 'await-user':
          throw new ExportUnsupportedError(`step ${index} of flow "${flow.name}" is an await-user step, which export does not support`);
      }
      steps.push({ index: steps.length, flow: flow.name, step: index, kind: step.kind, name: step.label ?? `${flow.name}:${index}`, when, optional: step.optional, target, action });
    }
  };
  for (const name of shape.before) addFlow(name, 'first-page');
  for (const name of shape.every) addFlow(name, 'every-page');

  const tables: PlanTable[] = recipeTables.map((table) => ({
    name: table.name,
    item: table.item
      ? {
          selectors: selectors(table.item.selectors),
          ...(table.item.within ? { within: selectors(table.item.within) } : {}),
          exclude: selectors(table.item.exclude ?? []),
        }
      : null,
    fields: table.fields.map((field): PlanField => {
      const attr = field.attr ?? defaultAttr(field.type);
      return {
        name: field.name,
        type: field.type,
        scope: field.scope,
        optional: field.optional,
        fallback: field.fallback,
        hover: field.hover,
        selectors: selectors(field.selectors),
        read: readMode(field.type, attr),
        attr: attr ?? null,
      };
    }),
    key: table.fields.find((f) => f.key)?.name ?? null,
  }));

  return {
    recipe: recipe.name,
    url: recipe.url,
    vars,
    steps,
    tables,
    primary: primary(recipe, recipeTables),
    pagination: {
      kind: pagination.kind,
      param: pageParam ? { name: pageParam.name, start: pageParam.start, step: pageParam.step } : null,
      paramInTemplate: pageParam ? templateVariables(recipe.url).includes(pageParam.name) : false,
      target: pagination.target && (pagination.kind === 'next' || pagination.kind === 'more') ? selectors(pagination.target.selectors) : null,
      limit: pagination.limit,
      cap: DEFAULT_PAGE_CAP,
      stopRules: [...pagination.stopRules],
      delayMs: pagination.delayMs,
    },
    timings: { ...EXPORT_TIMINGS },
  };
}
