import { resolveDocumentTarget, resolveFirst, resolveFrame, type TargetResult } from '../extract';
import type { FrameReport } from '../events';
import { RunFailure } from '../failure';
import { candidatesResolver } from '../healing/ladder';
import type { Promotion } from '../healing/promote';
import { isHealed, type HealOutcome, type HealTarget, type Resolver } from '../healing/types';
import type { ElementRef, PageInfo, Session } from '../ports';
import type { Flow, Recipe, SelectorCandidate, Step, StepKind } from '../recipe/schema';
import { fillText } from '../template';
import { targetPresent, type RunWindows } from './windows';

/** How long a `wait` step sleeps between looks for its target. */
export const WAIT_POLL_MS = 200;

export type StepOutcome = 'ok' | 'healed' | 'skipped' | 'failed';

/** One step as it ran on one page. */
export interface StepReport {
  /** Name of the flow the step belongs to. */
  flow: string;
  /** Index of the step within its flow. */
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
  /** How the target's frame resolved, for a target with `frame`. */
  frame?: FrameReport;
}

/** Selectors steps settled on, for the target and its frame, keyed by `flow:index`, so later runs of a step skip the ladder. */
export type StepCache = Map<string, { selectors: SelectorCandidate[]; frame?: SelectorCandidate[] }>;

/** What an `await-user` step asks of the runner: hold the user's attention until the condition holds. */
export interface AwaitUserRequest {
  flow: string;
  index: number;
  step: Step;
  /** The window the step acts in, where the banner shows. */
  window: Session;
  /** Shown in the banner, the notification, and the hooks. */
  label: string;
  /** Whether the user is still needed: the condition does not hold yet. */
  stillNeeded(): Promise<boolean>;
}

export interface FlowContext {
  /** Page number the flow runs on. */
  page: number;
  /** The run's windows; the flow's `same` window is `origin`, its `popup` window the newest popup opened since it started. */
  windows: RunWindows;
  /** Run variable values for `{name}` in step values. */
  vars?: Readonly<Record<string, string>>;
  /** Bound for settling after each action, for `wait` steps, and for a popup to open. */
  timeoutMs: number;
  /** Healing ladder. Default: the stored candidates only. */
  ladder?: readonly Resolver[];
  /** Generate fresh selectors for targets resolved by a later stored candidate too. */
  promote?: boolean;
  /** Called once per healed step target. */
  onHealed?: (promotion: Promotion) => void;
  /** Called once per step with its final report, before a required failure is thrown. */
  onEvent?: (report: StepReport) => void;
  /** Called after an action navigated the main window, with the settled page; returns the page to go on with (guards may move it). */
  onNavigated?: (info: PageInfo) => Promise<PageInfo>;
  /** Called before each step, where reactive flows may fire. */
  checkpoint?: () => Promise<void>;
  /** Holds the user's attention for an `await-user` step. Default: poll the condition until the timeout. */
  awaitUser?: (request: AwaitUserRequest) => Promise<void>;
  cache: StepCache;
  /** Waits for `wait` steps; injectable so an abort ends them. Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Interval between looks for a `wait` step's target. Default `WAIT_POLL_MS`. */
  pollMs?: number;
}

export interface FlowResult {
  /** The settled main window page after the last step that acted there, or null when none did. */
  info: PageInfo | null;
  steps: StepReport[];
}

/** The heal target of a step, for the ladder and for promotions. */
export function stepTarget(flow: string, step: Step, index: number): HealTarget | null {
  if (!step.target) return null;
  return {
    kind: 'step',
    flow,
    index,
    step: step.kind,
    optional: step.optional,
    ...(step.label ? { label: step.label } : {}),
    selectors: step.target.selectors,
    ...(step.target.fingerprint ? { fingerprint: step.target.fingerprint } : {}),
  };
}

/** The heal target of a step target's frame, or null when the target is in the top document. */
export function stepFrameTarget(flow: string, step: Step, index: number): (HealTarget & { kind: 'frame' }) | null {
  const frame = step.target?.frame;
  if (!frame) return null;
  return {
    kind: 'frame',
    of: 'step',
    flow,
    index,
    ...(step.label ? { label: step.label } : {}),
    selectors: frame.selectors,
    ...(frame.fingerprint ? { fingerprint: frame.fingerprint } : {}),
  };
}

/** Resolve a step's target through the healing ladder against the document or a frame root, like the pagination target. */
export async function resolveStepTarget(
  session: Session,
  recipe: Recipe,
  flow: string,
  step: Step,
  index: number,
  opts: { ladder?: readonly Resolver[]; promote?: boolean; within?: ElementRef },
): Promise<TargetResult> {
  const target = stepTarget(flow, step, index);
  if (!target) return { ref: null, selectors: [], outcome: { kind: 'unresolved' }, promotion: null, notes: [] };
  return resolveDocumentTarget(session, recipe, target, opts);
}

const timer = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Short name for logs and failures: the label, else `flow:N`. */
export const stepName = (flow: string, step: Step, index: number) => step.label ?? `${flow}:${index}`;

/** The label an `await-user` step shows the user. */
export const awaitUserLabel = (flow: string, step: Step, index: number) => step.label ?? `${flow} step ${index + 1}`;

/**
 * Whether an `await-user` condition holds: the target resolves (`appears`) or
 * resolves nowhere (`disappears`), looked for in every open window of the run,
 * so a login popup can wait for the button of the main window to go away.
 */
export async function awaitUserHolds(windows: RunWindows, step: Step): Promise<boolean> {
  let present = false;
  for (const window of windows.open()) {
    if (await targetPresent(window, step.target!)) {
      present = true;
      break;
    }
  }
  return step.until === 'disappears' ? !present : present;
}

/**
 * Replay a flow's steps in order, in the window each step names: `same` is
 * `origin`, the window the flow started in; `popup` the newest popup opened
 * since the flow started, waited for up to the navigation timeout. Each target
 * goes through the healing ladder the first time (later runs reuse what it
 * settled on until that stops resolving), the action runs, and the window
 * settles before the next step. An optional step whose target or window is not
 * found is skipped; a required one fails the run with `missing-required`
 * naming the flow and the step.
 */
export async function runFlow(recipe: Recipe, flow: Flow, origin: Session, ctx: FlowContext): Promise<FlowResult> {
  const sleep = ctx.sleep ?? timer;
  const reports: StepReport[] = [];
  const mark = ctx.windows.mark();
  let info: PageInfo | null = null;

  for (const [index, step] of flow.steps.entries()) {
    await ctx.checkpoint?.();
    const base = { flow: flow.name, index, kind: step.kind, ...(step.label ? { label: step.label } : {}), page: ctx.page };
    const finish = (report: StepReport): StepReport => {
      reports.push(report);
      ctx.onEvent?.(report);
      return report;
    };
    const fail = (why: string, found: Pick<StepReport, 'heal' | 'candidate' | 'frame'> & { notes?: string[] }): never => {
      const notes = [...(found.notes ?? []), why];
      const frame = found.frame ? { frame: found.frame } : {};
      if (step.optional) {
        finish({ ...base, outcome: 'skipped', heal: found.heal, candidate: found.candidate, notes, ...frame });
        throw SKIPPED;
      }
      finish({ ...base, outcome: 'failed', heal: found.heal, candidate: found.candidate, notes, ...frame });
      throw new RunFailure('missing-required', `required step ${index} (${step.kind}) of flow "${flow.name}" ${why}`, [stepName(flow.name, step, index)]);
    };

    try {
      let window = step.window === 'popup' ? await ctx.windows.waitForPopup(mark, ctx.timeoutMs) : origin;
      // An await-user step only places its banner in its window: once the popup is gone (the user finished
      // there and it closed itself), the condition is checked as usual with the banner in the flow's window.
      if (step.kind === 'await-user' && (!window || window.isClosed()) && ctx.windows.popupOpenedSince(mark)) window = origin;
      if (!window || window.isClosed()) {
        fail(step.window === 'popup' ? `found no popup within ${ctx.timeoutMs} ms` : 'found its window closed', { heal: step.target ? { kind: 'unresolved' } : null, candidate: null });
      }
      const session = window!;

      // A numeric wait needs no target.
      if (step.kind === 'wait' && !step.target) {
        await sleep(Number(step.value ?? 0));
        finish({ ...base, outcome: 'ok', heal: null, candidate: null });
        continue;
      }

      if (step.kind === 'await-user') {
        const request: AwaitUserRequest = {
          flow: flow.name,
          index,
          step,
          window: session,
          label: awaitUserLabel(flow.name, step, index),
          stillNeeded: async () => !(await awaitUserHolds(ctx.windows, step)),
        };
        if (ctx.awaitUser) await ctx.awaitUser(request);
        else await pollUntil(() => awaitUserHolds(ctx.windows, step), step.timeoutMs ?? ctx.timeoutMs, ctx.pollMs ?? WAIT_POLL_MS, sleep, () => fail(`was not satisfied within ${step.timeoutMs ?? ctx.timeoutMs} ms`, { heal: null, candidate: null }));
        finish({ ...base, outcome: 'ok', heal: null, candidate: null });
        continue;
      }

      let found: Found = { ref: null, heal: null, candidate: null, notes: [] };
      if (step.target) {
        found = await locate(session, recipe, flow.name, step, index, ctx, sleep);
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
      if (step.kind !== 'wait' && !session.isClosed()) {
        // A navigation inside a popup is waited for in that popup; only the main window's pages go through the guards.
        const settled = await session.settle({ timeoutMs: ctx.timeoutMs, previousUrl }).catch((error: unknown) => {
          if (session.isClosed()) return null;
          throw error;
        });
        if (settled && session === ctx.windows.main) {
          info = settled;
          if (settled.url !== previousUrl && ctx.onNavigated) info = await ctx.onNavigated(settled);
        }
      }
      finish({
        ...base,
        outcome: isHealed(found.heal) ? 'healed' : 'ok',
        heal: found.heal,
        candidate: found.candidate,
        ...(found.notes.length > 0 ? { notes: found.notes } : {}),
        ...(found.frame ? { frame: found.frame } : {}),
      });
    } catch (error) {
      if (error === SKIPPED) continue;
      throw error;
    }
  }
  return { info, steps: reports };
}

/** Poll a condition until it holds, or call `timedOut` when the time runs out. */
async function pollUntil(holds: () => Promise<boolean>, timeoutMs: number, pollMs: number, sleep: (ms: number) => Promise<void>, timedOut: () => never): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await holds()) return;
    if (Date.now() >= deadline) timedOut();
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/** A step's target as `locate` found it. */
interface Found {
  ref: ElementRef | null;
  heal: HealOutcome | null;
  candidate: SelectorCandidate | null;
  notes: string[];
  frame?: FrameReport;
}

/** Thrown by `fail` for an optional step, so the loop moves on. */
const SKIPPED = Symbol('skipped');

/**
 * Find a step's target: the selectors an earlier run of the step settled on
 * first, else the healing ladder. A `wait` step looks with its stored
 * candidates until the timeout, then gives the whole ladder one try.
 */
async function locate(session: Session, recipe: Recipe, flow: string, step: Step, index: number, ctx: FlowContext, sleep: (ms: number) => Promise<void>): Promise<Found> {
  const key = `${flow}:${index}`;
  const cached = ctx.cache.get(key);
  // A framed target resolves inside its iframe's document; the frame itself is found first, in the top document.
  const frameTarget = stepFrameTarget(flow, step, index);
  let within: ElementRef | undefined;
  let frameSelectors: SelectorCandidate[] | undefined;
  let frameReport: { frame: FrameReport } | Record<string, never> = {};
  if (frameTarget) {
    const ladder = ctx.ladder ?? [candidatesResolver];
    const frameOpts = { ladder, promote: ctx.promote ?? false, timeoutMs: ctx.timeoutMs };
    let frame = cached?.frame ? await resolveFrame(session, recipe, frameTarget, { ...frameOpts, reuse: cached.frame }) : null;
    if (!frame?.root) frame = await resolveFrame(session, recipe, frameTarget, frameOpts);
    if (frame.promotion) ctx.onHealed?.(frame.promotion);
    frameReport = { frame: frame.report };
    if (!frame.root) return { ref: null, heal: { kind: 'unresolved' }, candidate: null, notes: [...(frame.report.notes ?? []), 'the frame did not resolve'], ...frameReport };
    within = frame.root;
    frameSelectors = frame.selectors;
  }
  if (cached) {
    const hit = await resolveFirst(session, cached.selectors, within);
    if (hit) return { ref: hit.refs[0]!, heal: { kind: 'candidate', index: 0 }, candidate: hit.candidate, notes: [], ...frameReport };
  }
  if (step.kind === 'wait') {
    const deadline = Date.now() + ctx.timeoutMs;
    const selectors = cached?.selectors ?? step.target!.selectors;
    for (;;) {
      const hit = await resolveFirst(session, selectors, within);
      if (hit) return { ref: hit.refs[0]!, heal: { kind: 'candidate', index: hit.index }, candidate: hit.candidate, notes: [], ...frameReport };
      if (Date.now() >= deadline) break;
      await sleep(Math.min(ctx.pollMs ?? WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
    }
  }
  const result = await resolveStepTarget(session, recipe, flow, step, index, { ladder: ctx.ladder ?? [candidatesResolver], promote: ctx.promote ?? false, ...(within ? { within } : {}) });
  if (result.promotion) ctx.onHealed?.(result.promotion);
  if (result.ref) ctx.cache.set(key, { selectors: result.selectors, ...(frameSelectors ? { frame: frameSelectors } : {}) });
  return {
    ref: result.ref,
    heal: result.outcome,
    candidate: result.ref ? (result.selectors[0] ?? null) : null,
    notes: result.notes,
    ...frameReport,
  };
}

/** Whether the element is a native `select`, which `fill` sets by option value or label. */
async function isSelect(session: Session, ref: ElementRef): Promise<boolean> {
  const node = await session.snapshot(ref).catch(() => null);
  return node?.type === 'element' && node.tag === 'select';
}

async function act(session: Session, recipe: Recipe, step: Step, ref: ElementRef | null, vars: Readonly<Record<string, string>> | undefined): Promise<void> {
  switch (step.kind) {
    case 'click':
      return session.click(ref!);
    case 'fill': {
      const value = fillText(step.value ?? '', recipe.vars, vars);
      if (await isSelect(session, ref!)) return session.selectOption(ref!, value);
      return session.fill(ref!, value);
    }
    case 'press':
      return session.press(step.value ?? 'Enter', ref ?? undefined);
    case 'wait':
    case 'await-user':
      return;
  }
}
