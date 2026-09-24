import { resolveDocumentTarget, resolveFirst, type TargetResult } from '../extract';
import { RunFailure } from '../failure';
import { candidatesResolver } from '../healing/ladder';
import type { Promotion } from '../healing/promote';
import { isHealed, type HealOutcome, type HealTarget, type Resolver } from '../healing/types';
import type { ElementRef, PageInfo, Session } from '../ports';
import type { Recipe, SelectorCandidate, Step, StepKind } from '../recipe/schema';
import { fillText } from '../template';

/** How long a `wait` step sleeps between looks for its target. */
export const WAIT_POLL_MS = 200;

export type StepOutcome = 'ok' | 'healed' | 'skipped' | 'failed';

/** One step as it ran on one page. */
export interface StepReport {
  index: number;
  kind: StepKind;
  label?: string;
  /** Page number the step ran on. */
  page: number;
  outcome: StepOutcome;
  /** Which rung resolved the target, or null for a step without one. */
  heal: HealOutcome | null;
  /** Selector the target resolved with, or null when none did or the step has no target. */
  candidate: SelectorCandidate | null;
  /** Why the step was skipped or failed, and why healing rungs declined it. */
  notes?: string[];
}

/** Selectors `every-page` steps settled on, by step index, so later pages skip the ladder. */
export type StepCache = Map<number, SelectorCandidate[]>;

export interface ReplayContext {
  /** Page number of the page the batch runs on; `first-page` steps run only on page 1. */
  page: number;
  /** Run variable values for `{name}` in step values. */
  vars?: Readonly<Record<string, string>>;
  /** Bound for settling after each action and for `wait` steps. */
  timeoutMs: number;
  /** Healing ladder. Default: the stored candidates only. */
  ladder?: readonly Resolver[];
  /** Generate fresh selectors for targets resolved by a later stored candidate too. */
  promote?: boolean;
  /** Called once per healed step target. */
  onHealed?: (promotion: Promotion) => void;
  /** Called once per step with its final report, before a required failure is thrown. */
  onEvent?: (report: StepReport) => void;
  /** Called after an action navigated, with the settled page; returns the page to go on with (guards may move it). */
  onNavigated?: (info: PageInfo) => Promise<PageInfo>;
  cache: StepCache;
  /** Waits for `wait` steps; injectable so an abort ends them. Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Interval between looks for a `wait` step's target. Default `WAIT_POLL_MS`. */
  pollMs?: number;
}

export interface ReplayResult {
  /** The settled page after the last step, or null when no step ran. */
  info: PageInfo | null;
  steps: StepReport[];
}

/** Whether any step runs on the given page. */
export function stepsFor(recipe: Recipe, page: number): { step: Step; index: number }[] {
  return recipe.steps.map((step, index) => ({ step, index })).filter(({ step }) => step.when === 'every-page' || page === 1);
}

/** The heal target of a step, for the ladder and for promotions. */
export function stepTarget(step: Step, index: number): HealTarget | null {
  if (!step.target) return null;
  return {
    kind: 'step',
    index,
    step: step.kind,
    optional: step.optional,
    ...(step.label ? { label: step.label } : {}),
    selectors: step.target.selectors,
    ...(step.target.fingerprint ? { fingerprint: step.target.fingerprint } : {}),
  };
}

/** Resolve a step's target through the healing ladder against the document, like the pagination target. */
export async function resolveStepTarget(
  session: Session,
  recipe: Recipe,
  index: number,
  opts: { ladder?: readonly Resolver[]; promote?: boolean },
): Promise<TargetResult> {
  const step = recipe.steps[index];
  const target = step ? stepTarget(step, index) : null;
  if (!target) return { ref: null, selectors: [], outcome: { kind: 'unresolved' }, promotion: null, notes: [] };
  return resolveDocumentTarget(session, recipe, target, opts);
}

const timer = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Short name for logs and failures: the label, else `step:N`. */
export const stepName = (step: Step, index: number) => step.label ?? `step:${index}`;

/**
 * Replay the recipe's steps that apply to `ctx.page`, in list order. Each
 * target goes through the healing ladder once per batch (`every-page` steps
 * reuse the selectors of an earlier page until they stop resolving), the
 * action runs, and the page settles before the next step. An optional step
 * whose target is not found is skipped; a required one fails the run with
 * `missing-required` naming the step.
 */
export async function replaySteps(session: Session, recipe: Recipe, ctx: ReplayContext): Promise<ReplayResult> {
  const sleep = ctx.sleep ?? timer;
  const reports: StepReport[] = [];
  let info: PageInfo | null = null;

  for (const { step, index } of stepsFor(recipe, ctx.page)) {
    const base = { index, kind: step.kind, ...(step.label ? { label: step.label } : {}), page: ctx.page };
    const finish = (report: StepReport): StepReport => {
      reports.push(report);
      ctx.onEvent?.(report);
      return report;
    };
    const fail = (why: string, found: Pick<StepReport, 'heal' | 'candidate'> & { notes?: string[] }): never => {
      const notes = [...(found.notes ?? []), why];
      if (step.optional) {
        finish({ ...base, outcome: 'skipped', heal: found.heal, candidate: found.candidate, notes });
        throw SKIPPED;
      }
      finish({ ...base, outcome: 'failed', heal: found.heal, candidate: found.candidate, notes });
      throw new RunFailure('missing-required', `required step ${index} (${step.kind}) ${why}`, [stepName(step, index)]);
    };

    try {
      // A numeric wait needs no target.
      if (step.kind === 'wait' && !step.target) {
        await sleep(Number(step.value ?? 0));
        finish({ ...base, outcome: 'ok', heal: null, candidate: null });
        continue;
      }

      let found: { ref: ElementRef | null; heal: HealOutcome | null; candidate: SelectorCandidate | null; notes: string[] } = {
        ref: null,
        heal: null,
        candidate: null,
        notes: [],
      };
      if (step.target) {
        found = await locate(session, recipe, step, index, ctx, sleep);
        if (!found.ref) {
          fail(step.kind === 'wait' ? `found no element within ${ctx.timeoutMs} ms` : 'found no element', found);
        }
      }

      const previousUrl = await session.url();
      try {
        await act(session, recipe, step, found.ref, ctx.vars);
      } catch (error) {
        if (error instanceof RunFailure) throw error;
        fail(`could not run: ${error instanceof Error ? error.message : String(error)}`, found);
      }
      if (step.kind !== 'wait') {
        info = await session.settle({ timeoutMs: ctx.timeoutMs, previousUrl });
        if (info.url !== previousUrl && ctx.onNavigated) info = await ctx.onNavigated(info);
      }
      finish({
        ...base,
        outcome: isHealed(found.heal) ? 'healed' : 'ok',
        heal: found.heal,
        candidate: found.candidate,
        ...(found.notes.length > 0 ? { notes: found.notes } : {}),
      });
    } catch (error) {
      if (error === SKIPPED) continue;
      throw error;
    }
  }
  return { info, steps: reports };
}

/** Thrown by `fail` for an optional step, so the loop moves on. */
const SKIPPED = Symbol('skipped');

/**
 * Find a step's target: cached selectors first for `every-page` steps, else
 * the healing ladder. A `wait` step looks with its stored candidates until the
 * timeout, then gives the whole ladder one try.
 */
async function locate(
  session: Session,
  recipe: Recipe,
  step: Step,
  index: number,
  ctx: ReplayContext,
  sleep: (ms: number) => Promise<void>,
): Promise<{ ref: ElementRef | null; heal: HealOutcome | null; candidate: SelectorCandidate | null; notes: string[] }> {
  const cached = step.when === 'every-page' ? ctx.cache.get(index) : undefined;
  if (cached) {
    const hit = await resolveFirst(session, cached);
    if (hit) return { ref: hit.refs[0]!, heal: { kind: 'candidate', index: 0 }, candidate: hit.candidate, notes: [] };
  }
  if (step.kind === 'wait') {
    const deadline = Date.now() + ctx.timeoutMs;
    const selectors = cached ?? step.target!.selectors;
    for (;;) {
      const hit = await resolveFirst(session, selectors);
      if (hit) return { ref: hit.refs[0]!, heal: { kind: 'candidate', index: hit.index }, candidate: hit.candidate, notes: [] };
      if (Date.now() >= deadline) break;
      await sleep(Math.min(ctx.pollMs ?? WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
    }
  }
  const result = await resolveStepTarget(session, recipe, index, { ladder: ctx.ladder ?? [candidatesResolver], promote: ctx.promote ?? false });
  if (result.promotion) ctx.onHealed?.(result.promotion);
  if (result.ref && step.when === 'every-page') ctx.cache.set(index, result.selectors);
  return {
    ref: result.ref,
    heal: result.outcome,
    candidate: result.ref ? (result.selectors[0] ?? null) : null,
    notes: result.notes,
  };
}

async function act(session: Session, recipe: Recipe, step: Step, ref: ElementRef | null, vars: Readonly<Record<string, string>> | undefined): Promise<void> {
  switch (step.kind) {
    case 'click':
      return session.click(ref!);
    case 'type':
      return session.fill(ref!, fillText(step.value ?? '', recipe.vars, vars));
    case 'select':
      return session.selectOption(ref!, step.value ?? '');
    case 'press':
      return session.press(step.value ?? 'Enter', ref ?? undefined);
    case 'wait':
      return;
  }
}
