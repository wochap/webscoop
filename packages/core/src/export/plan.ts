import { defaultAttr } from '../convert';
import { DEFAULT_PAGE_CAP } from '../pagination/types';
import type { FieldScope, FieldType, PaginationKind, Recipe, SelectorCandidate, StepKind, StepWhen } from '../recipe/schema';
import { WAIT_POLL_MS } from '../steps/replay';
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
  /** Whether the run cannot start without a value: used in the URL template or in a `type` step. */
  required: boolean;
}

/** What a step does once its target (if any) is found. Defaults are already resolved. */
export type PlanAction =
  | { kind: 'click' }
  | { kind: 'type'; text: string }
  | { kind: 'select'; value: string }
  | { kind: 'press'; key: string }
  /** A `wait` with a target: poll for it. */
  | { kind: 'wait-for' }
  /** A `wait` without a target: sleep. */
  | { kind: 'sleep'; ms: number };

export interface PlanStep {
  index: number;
  kind: StepKind;
  /** The label, else `step:N`, as the runner names it. */
  name: string;
  when: StepWhen;
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

/** A recipe as a language-neutral list of what the exported script does, with every schema default resolved. */
export interface ExportPlan {
  recipe: string;
  url: string;
  vars: PlanVar[];
  steps: PlanStep[];
  /** Item container; `within` is the list parent, present only when the recipe has one. */
  item: { selectors: PlanSelector[]; within?: PlanSelector[]; exclude: PlanSelector[] } | null;
  fields: PlanField[];
  /** Name of the dedup key field, or null to dedup by all field values. */
  key: string | null;
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

const selectors = (candidates: readonly SelectorCandidate[]): PlanSelector[] => candidates.map(({ strategy, value }) => ({ strategy, value }));

function readMode(type: FieldType, attr: string | undefined): ReadMode {
  if (attr) return 'attr';
  return type === 'html' ? 'html' : 'text';
}

/** Turn a validated recipe into the plan both renderers share. */
export function buildPlan(recipe: Recipe): ExportPlan {
  const { pagination } = recipe;
  const pageParam = pagination.kind === 'url' ? (pagination.param ?? null) : null;

  // Variables the run needs before the browser opens; the page variable has its own start value.
  const needed = new Set(templateVariables(recipe.url));
  for (const step of recipe.steps) if (step.kind === 'type' && step.value) for (const name of templateVariables(step.value)) needed.add(name);
  if (pageParam) needed.delete(pageParam.name);
  const vars: PlanVar[] = recipe.vars.map((v) => ({ name: v.name, default: v.default ?? null, required: needed.has(v.name) }));
  for (const name of needed) if (!recipe.vars.some((v) => v.name === name)) vars.push({ name, default: null, required: true });

  const steps: PlanStep[] = recipe.steps.map((step, index) => {
    const target = step.target ? selectors(step.target.selectors) : null;
    let action: PlanAction;
    switch (step.kind) {
      case 'click':
        action = { kind: 'click' };
        break;
      case 'type':
        action = { kind: 'type', text: step.value ?? '' };
        break;
      case 'select':
        action = { kind: 'select', value: step.value ?? '' };
        break;
      case 'press':
        action = { kind: 'press', key: step.value ?? 'Enter' };
        break;
      case 'wait':
        action = target ? { kind: 'wait-for' } : { kind: 'sleep', ms: Number(step.value ?? 0) };
        break;
    }
    return { index, kind: step.kind, name: step.label ?? `step:${index}`, when: step.when, optional: step.optional, target, action };
  });

  const fields: PlanField[] = recipe.fields.map((field) => {
    const attr = field.attr ?? defaultAttr(field.type);
    return {
      name: field.name,
      type: field.type,
      scope: field.scope,
      optional: field.optional,
      selectors: selectors(field.selectors),
      read: readMode(field.type, attr),
      attr: attr ?? null,
    };
  });

  return {
    recipe: recipe.name,
    url: recipe.url,
    vars,
    steps,
    item: recipe.item
      ? {
          selectors: selectors(recipe.item.selectors),
          ...(recipe.item.within ? { within: selectors(recipe.item.within) } : {}),
          exclude: selectors(recipe.item.exclude ?? []),
        }
      : null,
    fields,
    key: recipe.fields.find((f) => f.key)?.name ?? null,
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
