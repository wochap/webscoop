import { defaultAttr } from '../convert';
import { GUARD_POLL_MS } from '../guards/wait';
import { DEFAULT_PAGE_CAP } from '../pagination/types';
import type { Block, FieldScope, FieldType, InnerBlock, PaginationKind, Recipe, SelectorCandidate, Step, StepKind, StepWindow, Target } from '../recipe/schema';

type StepUntil = NonNullable<Step['until']>;
import { drivingTable, maxRetriesOf, paginateOf, paginationOf, walkBlocks } from '../recipe/sequence';
import { primaryTableIndex, tablesOf } from '../recipe/tables';
import { awaitUserLabel, stepName, WAIT_POLL_MS } from '../flows/replay';
import { templateVariables } from '../template';

/** A selector as the exported script uses it: strategy and value, without the recorder's stability rating. */
export interface PlanSelector {
  strategy: SelectorCandidate['strategy'];
  value: string;
}

/** A step, trigger, or pagination target: its candidates, and the iframe they resolve in, if any. */
export interface PlanTarget {
  selectors: PlanSelector[];
  /** Candidates of the `<iframe>` in the top document, or null for a target in the top document. */
  frame: PlanSelector[] | null;
}

export interface PlanVar {
  name: string;
  /** Recipe default, or null when a value must be given. */
  default: string | null;
  /** Whether the run cannot start without a value: used in the URL template or in a `fill` step. */
  required: boolean;
  /** The script never prints the value. */
  secret: boolean;
  /** The value is one or more file paths separated by `:`. */
  path: boolean;
}

/** What a step does once its window and target (if any) are found. Defaults are already resolved. */
export type PlanAction =
  | { kind: 'click' }
  /**
   * Set the element by its fill kind. `path` names the path variable when the
   * value is that variable alone; `vars` are the variables the value uses,
   * named in failures instead of the value.
   */
  | { kind: 'fill'; text: string; path: string | null; vars: string[] }
  | { kind: 'press'; key: string }
  /** A `wait` with a target: poll for it. */
  | { kind: 'wait-for' }
  /** A `wait` without a target: sleep. */
  | { kind: 'sleep'; ms: number }
  /** Wait for the user until the target appears or disappears in any open window. */
  | { kind: 'await-user'; until: StepUntil; timeoutMs: number | null; label: string };

export interface PlanStep {
  /** The flow the step belongs to, and its index there. */
  flow: string;
  index: number;
  kind: StepKind;
  /** The label, else `flow:N`, as the runner names it. */
  name: string;
  optional: boolean;
  /** `popup`: the newest popup opened since the flow started. */
  window: StepWindow;
  target: PlanTarget | null;
  action: PlanAction;
}

export interface PlanFlow {
  name: string;
  /** For a reactive flow, the target whose appearance in any open window fires it; null for a called flow. */
  trigger: PlanTarget | null;
  /** Times a reactive flow may fire between two successful extractions. */
  maxRetries: number;
  /** After a reactive flow, reload the batch URL and replay its called flows. */
  recover: boolean;
  steps: PlanStep[];
}

/** A sequence block: a called flow, an extraction, or the paginate block with its inner blocks. */
export type PlanBlock = { flow: string } | { extract: string } | { paginate: ({ flow: string } | { extract: string })[] };

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
  /** The driving table: its item count drives growth and the stop rules; null when none. */
  table: string | null;
  /** Page variable for kind `url`, else null. */
  param: { name: string; start: number; step: number } | null;
  /** Whether the URL template holds the page variable; when not, it is set as a query parameter. */
  paramInTemplate: boolean;
  /** Next link or load-more button, for kinds `next` and `more`. */
  target: PlanTarget | null;
  limit: number | 'all';
  /** Most pages `all` walks. */
  cap: number;
  stopRules: string[];
  delayMs: number;
}

/** Timing constants copied from the runner and the browser adapter. */
export interface PlanTimings {
  /** Navigation, settle, `wait` step, popup, frame, and growth timeout. */
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
  /** Interval between checks of an `await-user` condition, each one a checkpoint for reactive flows. */
  awaitPollMs: number;
  /** Default `--await-timeout`. */
  awaitTimeoutMs: number;
  /** Longest a `--var-command` may run. */
  varCommandMs: number;
  /** How long a file chooser may take to open. */
  fileChooserMs: number;
}

/** One table of the recipe. */
export interface PlanTable {
  name: string;
  /** Candidates of the `<iframe>` whose document holds the table, or null for the top document. */
  frame: PlanSelector[] | null;
  /** Item container; `within` is the list parent, present only when the recipe has one. Null for a table that yields one row per extraction. */
  item: { selectors: PlanSelector[]; within?: PlanSelector[]; exclude: PlanSelector[] } | null;
  fields: PlanField[];
  /** Name of the dedup key field, or null to dedup by all field values. */
  key: string | null;
}

/**
 * The runtime part of a recipe as both renderers embed it, with every schema
 * default resolved and fingerprints left out: the preludes interpret it the
 * way the runner interprets the recipe.
 */
export interface ExportPlan {
  recipe: string;
  url: string;
  vars: PlanVar[];
  flows: PlanFlow[];
  sequence: PlanBlock[];
  /** Every table, in sequence order; the shorthand form is one table named `items`. */
  tables: PlanTable[];
  /** Index of the lead table (the paginate block's driving table, else the first with an item block), whose absence fails the run; -1 when none. */
  primary: number;
  pagination: PlanPagination;
  timings: PlanTimings;
}

/** Runner defaults the export copies (`Runner` navigation timeout, `PlaywrightBrowser` action timeout and settle bounds, guard polling). */
export const EXPORT_TIMINGS: PlanTimings = {
  navigationMs: 30_000,
  actionMs: 5000,
  settleGraceMs: 500,
  settleIdleMs: 2000,
  waitPollMs: WAIT_POLL_MS,
  growthPollMs: 200,
  awaitPollMs: GUARD_POLL_MS,
  awaitTimeoutMs: 600_000,
  varCommandMs: 30_000,
  fileChooserMs: 5000,
};

const selectors = (candidates: readonly SelectorCandidate[]): PlanSelector[] => candidates.map(({ strategy, value }) => ({ strategy, value }));

const target = (t: Target): PlanTarget => ({ selectors: selectors(t.selectors), frame: t.frame ? selectors(t.frame.selectors) : null });

function readMode(type: FieldType, attr: string | undefined): ReadMode {
  if (attr) return 'attr';
  return type === 'html' ? 'html' : 'text';
}

function action(recipe: Recipe, flow: string, step: Step, index: number): PlanAction {
  switch (step.kind) {
    case 'click':
      return { kind: 'click' };
    case 'fill': {
      const text = step.value ?? '';
      const whole = /^\{\+?([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(text.trim());
      const path = whole && recipe.vars.some((v) => v.name === whole[1] && v.type === 'path') ? whole[1]! : null;
      return { kind: 'fill', text, path, vars: templateVariables(text) };
    }
    case 'press':
      return { kind: 'press', key: step.value ?? 'Enter' };
    case 'wait':
      return step.target ? { kind: 'wait-for' } : { kind: 'sleep', ms: Number(step.value ?? 0) };
    case 'await-user':
      return { kind: 'await-user', until: step.until ?? 'appears', timeoutMs: step.timeoutMs ?? null, label: awaitUserLabel(flow, step, index) };
  }
}

const block = (b: Block | InnerBlock): PlanBlock => {
  if ('flow' in b) return { flow: b.flow };
  if ('extract' in b) return { extract: b.extract };
  return { paginate: b.paginate.do.map((inner) => ('flow' in inner ? { flow: inner.flow } : { extract: inner.extract })) };
};

/** Turn a validated recipe into the plan both renderers embed. */
export function buildPlan(recipe: Recipe): ExportPlan {
  const pagination = paginationOf(recipe);
  const paginate = paginateOf(recipe);
  const order = walkBlocks(recipe.sequence).flatMap((b) => ('extract' in b ? [b.extract] : []));
  const recipeTables = tablesOf(recipe)
    .slice()
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  const driving = paginate ? drivingTable(paginate, recipeTables) : null;
  const primary = driving !== null ? recipeTables.findIndex((t) => t.name === driving) : primaryTableIndex(recipeTables);
  const pageParam = pagination.kind === 'url' ? (pagination.param ?? null) : null;

  // Variables the run needs before the browser opens; the page variable has its own start value.
  const needed = new Set(templateVariables(recipe.url));
  for (const flow of recipe.flows) for (const step of flow.steps) if (step.kind === 'fill' && step.value) for (const name of templateVariables(step.value)) needed.add(name);
  if (pageParam) needed.delete(pageParam.name);
  const vars: PlanVar[] = recipe.vars.map((v) => ({ name: v.name, default: v.default ?? null, required: needed.has(v.name), secret: v.secret === true, path: v.type === 'path' }));
  for (const name of needed) if (!recipe.vars.some((v) => v.name === name)) vars.push({ name, default: null, required: true, secret: false, path: false });

  const flows: PlanFlow[] = recipe.flows.map((flow) => ({
    name: flow.name,
    trigger: flow.trigger ? target(flow.trigger.appears) : null,
    maxRetries: maxRetriesOf(flow),
    recover: flow.recover === true,
    steps: flow.steps.map((step, index) => ({
      flow: flow.name,
      index,
      kind: step.kind,
      name: stepName(flow.name, step, index),
      optional: step.optional,
      window: step.window,
      target: step.target ? target(step.target) : null,
      action: action(recipe, flow.name, step, index),
    })),
  }));

  const tables: PlanTable[] = recipeTables.map((table) => ({
    name: table.name,
    frame: table.frame ? selectors(table.frame.selectors) : null,
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
    flows,
    sequence: recipe.sequence.map(block),
    tables,
    primary,
    pagination: {
      kind: pagination.kind,
      table: driving,
      param: pageParam ? { name: pageParam.name, start: pageParam.start, step: pageParam.step } : null,
      paramInTemplate: pageParam ? templateVariables(recipe.url).includes(pageParam.name) : false,
      target: pagination.target && (pagination.kind === 'next' || pagination.kind === 'more') ? target(pagination.target) : null,
      limit: pagination.limit,
      cap: DEFAULT_PAGE_CAP,
      stopRules: [...pagination.stopRules],
      delayMs: pagination.delayMs,
    },
    timings: { ...EXPORT_TIMINGS },
  };
}
