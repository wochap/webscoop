import { RunEmitter, type AttentionOutcome, type AttentionReason, type FailureReason, type Row, type RunEvents, type RunReport } from './events';
import { RunFailure } from './failure';
import { RunWindows } from './flows/windows';
import type { AttentionLease, AttentionPort } from './guards/attention';
import type { GuardBannerHandler } from './guards/banner';
import { DEFAULT_GUARD_TIMEOUT_MS, GuardBudget } from './guards/budget';
import { enabledDetectors } from './guards/detectors';
import { applyPromotions } from './healing/apply';
import type { Promotion } from './healing/promote';
import { targetName, type HealTarget, type Resolution, type Resolver } from './healing/types';
import { TimeoutError, type BrowserPort, type ElementRef, type FilePort, type LifecyclePort, type NotifyPort, type OpenOptions, type Session } from './ports';
import type { Fingerprint, Recipe, SelectorCandidate } from './recipe/schema';
import { paginationOf } from './recipe/sequence';
import { tablesOf } from './recipe/tables';
import { createStrategy } from './pagination/strategies';
import { DEFAULT_PAGE_CAP, PaginationInputError, type PageStrategy } from './pagination/types';
import { quietly, SequenceRun, type RunStateName } from './sequence';
import { fillText, MissingVariableError } from './template';

export type RunState = RunStateName;

/** Allowed transitions: terminal states end the run, and the run opens and navigates once before anything else. */
function allowed(from: RunState, to: RunState): boolean {
  if (from === 'done' || from === 'failed' || to === 'idle') return false;
  if (to === 'failed') return true;
  if (from === 'idle') return to === 'opening';
  if (from === 'opening') return to === 'navigating';
  return to !== 'opening';
}

export interface HealingOptions {
  /** Go past the first stored candidate. When false, no promotion happens either. */
  enabled: boolean;
  /** Write the promoted recipe through `saveRecipe` after a successful run. */
  writeBack: boolean;
  /** Extra rungs tried after fuzzy matching, before a user re-pick. */
  resolvers?: Resolver[];
}

/** What the user is asked to re-pick. */
export interface RepickRequest {
  page: number;
  target: HealTarget;
  /** Field name. */
  name: string;
  oldSelector: SelectorCandidate;
  fingerprint: Fingerprint | null;
  /** Last known value of the field, from the stored fingerprint's text. */
  sample: string | null;
  session: Session;
  /** The recipe with every promotion made so far in this run applied. */
  recipe: Recipe;
}

export type RepickResult =
  | { kind: 'picked'; selectors: SelectorCandidate[]; fingerprint?: Fingerprint }
  | { kind: 'skip' }
  | { kind: 'abort' };

/** Asks a human for the new location of a required field the ladder could not resolve. */
export type RepickHandler = (request: RepickRequest) => Promise<RepickResult>;

export interface RunOptions {
  recipe: Recipe;
  browser: BrowserPort;
  profileDir: string;
  vars?: Readonly<Record<string, string>>;
  /** Host files for `path` variables. Default: paths used as given, unchecked. */
  files?: FilePort;
  /** Navigation timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  emitter?: RunEmitter;
  signal?: AbortSignal;
  openOptions?: OpenOptions;
  /** Clock, injectable for tests. */
  now?: () => Date;
  /** Default: enabled, with write-back. */
  healing?: HealingOptions;
  /** Write the promoted recipe to where it came from; returns the path written. */
  saveRecipe?: (recipe: Recipe) => Promise<string>;
  /** Last rung of the ladder for required fields, when a human is available. */
  repick?: RepickHandler;
  /** Per-run overrides of the recipe's pagination settings. */
  pagination?: PaginationOverrides;
  /** Guard detection and the pause while a human clears a wall. Default: no guards. */
  guards?: GuardOptions;
  /** Hooks around the browser launch, and the browser's process id for `browser.started`. */
  lifecycle?: LifecyclePort;
  /** Running the recipe's flows. Default: enabled. */
  flows?: FlowOptions;
  /** The user's attention, shared with other runs in the same browser. Default: held at once. */
  attention?: AttentionPort;
}

export interface FlowOptions {
  /** False runs no flow, called or reactive, for debugging a recipe (`--skip-flows`). */
  enabled: boolean;
}

export interface GuardOptions {
  /** False disables every guard for the run, whatever the recipe says. */
  enabled: boolean;
  /** Longest total wait across every guard of the run. 0 fails on the first guard. */
  timeoutMs: number;
  /** Told once per guard occurrence. Default: nothing. */
  notify?: NotifyPort;
  /** Banner over the page while the run holds attention for a guard or an `await-user` step. */
  banner?: GuardBannerHandler;
  /** Interval between re-evaluations while paused. Default 1000. */
  pollMs?: number;
}

export interface PaginationOverrides {
  /** Replaces the paginate block's `limit`. */
  limit?: number | 'all';
  /** Most pages a `limit: all` run walks. Default 500. */
  cap?: number;
  /** Replaces the paginate block's `delayMs`. */
  delayMs?: number;
}

export type RunResult =
  | { ok: true; rows: Row[]; report: RunReport }
  | { ok: false; reason: FailureReason; message: string; fields?: string[]; rows: Row[]; report: RunReport };

export { RunFailure };

export class Runner {
  readonly emitter: RunEmitter;
  private currentState: RunState = 'idle';
  private readonly history: RunState[] = ['idle'];
  /** The open `attention.needed`, closed by exactly one `attention.resolved`. */
  private attention: AttentionReason | null = null;

  constructor(private readonly opts: RunOptions) {
    this.emitter = opts.emitter ?? new RunEmitter();
  }

  get state(): RunState {
    return this.currentState;
  }

  /** Every state the run has been in, in order. */
  get states(): readonly RunState[] {
    return this.history;
  }

  private needAttention(payload: RunEvents['attention.needed']): void {
    this.attention = payload.reason;
    this.emitter.emit('attention.needed', payload);
  }

  private resolveAttention(outcome: AttentionOutcome): void {
    const reason = this.attention;
    if (reason === null) return;
    this.attention = null;
    this.emitter.emit('attention.resolved', { reason, outcome });
  }

  /** Wait for the user's attention; a run without an attention port holds it at once. */
  private async acquireAttention(): Promise<AttentionLease> {
    const port = this.opts.attention;
    if (!port) return { waited: false, onSignal: () => () => {}, stillBlocked: () => {}, release: () => {} };
    try {
      return await port.acquire(this.opts.signal);
    } catch (error) {
      if (this.opts.signal?.aborted) throw new RunFailure('aborted', 'run was interrupted');
      throw error;
    }
  }

  private transition(to: RunState): void {
    if (to === this.currentState) return;
    if (!allowed(this.currentState, to)) {
      throw new Error(`invalid run state transition ${this.currentState} -> ${to}`);
    }
    this.currentState = to;
    this.history.push(to);
  }

  /** The user as the last rung: only for required fields, and only while a handler is available. */
  private repickResolver(handler: RepickHandler, page: number, current: () => Recipe): Resolver {
    return {
      name: 'user',
      resolve: async (target, ctx): Promise<Resolution | null> => {
        if (target.kind !== 'field' || target.optional) return null;
        const oldSelector = target.selectors[0]!;
        const fingerprint = target.fingerprint ?? null;
        const table = target.table ?? tablesOf(this.opts.recipe)[0]!.name;
        this.transition('repicking');
        this.emitter.emit('repick.requested', { page, table, target: target.name, oldSelector, fingerprint });
        const lease = await this.acquireAttention();
        let result: RepickResult;
        try {
          await quietly(() => ctx.session.focus());
          const url = await ctx.session.url().catch(() => '');
          this.needAttention({ reason: 'repick', page, url, table, target: target.name });
          result = await handler({
            page,
            target,
            name: target.name,
            oldSelector,
            fingerprint,
            sample: fingerprint?.textSample || null,
            session: ctx.session,
            recipe: current(),
          });
          this.emitter.emit('repick.resolved', { page, table, target: target.name, result: result.kind });
          this.resolveAttention(result.kind);
        } finally {
          lease.release();
        }
        if (result.kind === 'abort') throw new RunFailure('aborted', `the re-pick of ${target.name} was aborted`);
        this.transition('extracting');
        if (result.kind === 'skip') return null;
        const scopes: (ElementRef | undefined)[] = ctx.containers && ctx.containers.length > 0 ? [...ctx.containers] : [ctx.within];
        for (const selector of result.selectors) {
          for (const within of scopes) {
            const refs = await ctx.session.resolve(selector, within);
            if (refs.length > 0) {
              return {
                refs,
                outcome: { kind: 'user' },
                selector,
                ...(within ? { within } : {}),
                selectors: result.selectors,
                ...(result.fingerprint ? { fingerprint: result.fingerprint } : {}),
              };
            }
          }
        }
        return null;
      },
    };
  }

  async run(): Promise<RunResult> {
    const { recipe, browser, profileDir, signal } = this.opts;
    const now = this.opts.now ?? (() => new Date());
    const started = now();
    const tables = tablesOf(recipe);
    const report: RunReport = {
      recipe: recipe.name,
      startedAt: started.toISOString(),
      endedAt: started.toISOString(),
      durationMs: 0,
      finalUrl: null,
      pageCount: 0,
      rowCount: 0,
      tables: tables.map((t) => ({ name: t.name, rowCount: 0, duplicateCount: 0, droppedCount: 0, item: null, fields: [] })),
      item: null,
      fields: [],
      pagination: null,
      duplicateCount: 0,
      droppedCount: 0,
      stopReason: null,
      pages: [],
      warnings: [],
      healed: 0,
      savedTo: null,
      guards: [],
      steps: [],
      flows: [],
    };
    const finish = () => {
      const ended = now();
      report.endedAt = ended.toISOString();
      report.durationMs = ended.getTime() - started.getTime();
    };

    const rows: Row[] = [];
    let opened = false;
    let session: Session | undefined;
    let windows: RunWindows | undefined;
    let closing: Promise<void> | undefined;
    const closeSession = (): Promise<void> => {
      if (!session) return Promise.resolve();
      return (closing ??= (async () => {
        await windows?.close();
        await session!.close().catch(() => {});
      })());
    };
    const onAbort = () => void closeSession();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (signal?.aborted) throw new RunFailure('aborted', 'run was interrupted');
      const pagination = paginationOf(recipe);
      let strategy: PageStrategy;
      try {
        strategy = createStrategy(recipe, pagination, this.opts.vars);
        // Fill values need their variables too; a missing one fails before the browser opens.
        for (const flow of recipe.flows) for (const step of flow.steps) if (step.kind === 'fill' && step.value) fillText(step.value, recipe.vars, this.opts.vars);
      } catch (error) {
        if (error instanceof MissingVariableError || error instanceof PaginationInputError) {
          throw new RunFailure('invalid-input', error.message, error.names);
        }
        throw error;
      }

      this.transition('opening');
      const lifecycle = this.opts.lifecycle;
      if (lifecycle?.beforeLaunch) await quietly(() => lifecycle.beforeLaunch!());
      const launchArgs = lifecycle?.extraArgs ?? [];
      const openOptions =
        launchArgs.length > 0 ? { ...this.opts.openOptions, args: [...(this.opts.openOptions?.args ?? []), ...launchArgs] } : this.opts.openOptions;
      session = await browser.open(profileDir, openOptions);
      opened = true;
      const live = session;
      windows = new RunWindows(live);
      const pid = lifecycle?.browserPid ? await lifecycle.browserPid().catch(() => undefined) : undefined;
      this.emitter.emit('browser.started', pid !== undefined ? { pid } : {});
      if (signal?.aborted) throw new RunFailure('aborted', 'run was interrupted');
      // Window manager rules can match the initial title; the first navigation replaces it.
      await quietly(() => live.setTitle(WINDOW_TITLE));
      this.emitter.emit('run.start', { recipe: recipe.name, url: strategy.url, profileDir, at: report.startedAt });

      const healing = this.opts.healing ?? { enabled: true, writeBack: true };
      const promotions: Promotion[] = [];
      const current = () => applyPromotions(recipe, promotions);
      // Rungs such as the model rung run only when the recipe allows them.
      const resolvers = (healing.resolvers ?? []).filter((r) => !r.recipeGated || recipe.healing.llm);
      const guardOpts = this.opts.guards;
      const cap = this.opts.pagination?.cap ?? DEFAULT_PAGE_CAP;

      const program = new SequenceRun({
        recipe,
        emitter: this.emitter,
        report,
        rows,
        windows,
        strategy,
        ...(this.opts.vars ? { vars: this.opts.vars } : {}),
        ...(this.opts.files ? { files: this.opts.files } : {}),
        timeoutMs: this.opts.timeoutMs ?? 30_000,
        limit: this.opts.pagination?.limit ?? pagination.limit,
        cap,
        delayMs: this.opts.pagination?.delayMs ?? pagination.delayMs,
        flowsEnabled: this.opts.flows?.enabled ?? true,
        detectors: guardOpts ? enabledDetectors(recipe, guardOpts.enabled) : [],
        budget: new GuardBudget(guardOpts?.timeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS),
        ...(guardOpts?.banner ? { banner: guardOpts.banner } : {}),
        ...(guardOpts?.notify ? { notify: guardOpts.notify } : {}),
        ...(guardOpts?.pollMs !== undefined ? { pollMs: guardOpts.pollMs } : {}),
        ...(signal ? { signal } : {}),
        healing: { enabled: healing.enabled, resolvers },
        ...(this.opts.repick ? { repick: (page: number) => this.repickResolver(this.opts.repick!, page, current) } : {}),
        onHealed: (page) => (promotion) => {
          promotions.push(promotion);
          const { target } = promotion;
          this.emitter.emit('field.healed', {
            page,
            ...(target.kind === 'field' || target.kind === 'item' || target.kind === 'within' || (target.kind === 'frame' && target.of === 'table')
              ? { table: target.table ?? tables[0]!.name }
              : {}),
            target: targetName(target),
            outcome: promotion.outcome,
            oldPrimary: promotion.oldPrimary,
            newPrimary: promotion.newPrimary,
          });
        },
        transition: (to) => this.transition(to),
        state: () => this.currentState,
        acquireAttention: () => this.acquireAttention(),
        needAttention: (payload) => this.needAttention(payload),
        resolveAttention: (outcome) => this.resolveAttention(outcome),
        sleep: (ms) => delay(ms, signal),
      });

      const reason = await program.run();
      report.stopReason = reason;
      if (reason === 'cap') {
        report.warnings.push(`stopped at the page cap of ${cap} pages; raise it (--max-pages) to go further`);
      }
      this.emitter.emit('pagination.stopped', { page: report.pageCount, reason });

      if (promotions.length > 0 && healing.enabled && healing.writeBack && this.opts.saveRecipe) {
        const path = await this.opts.saveRecipe(applyPromotions(recipe, promotions));
        report.savedTo = path;
        this.emitter.emit('recipe.saved', { path });
      }

      await closeSession();
      finish();
      this.transition('done');
      this.emitter.emit('run.done', { report });
      this.emitter.emit('browser.closed', {});
      return { ok: true, rows, report };
    } catch (error) {
      await closeSession();
      finish();
      this.resolveAttention('ended');
      const failure = toFailure(error, signal);
      if (this.currentState !== 'failed') this.transition('failed');
      this.emitter.emit('run.failed', {
        reason: failure.reason,
        message: failure.message,
        ...(failure.fields ? { fields: failure.fields } : {}),
        report,
      });
      if (opened) this.emitter.emit('browser.closed', {});
      return {
        ok: false,
        reason: failure.reason,
        message: failure.message,
        ...(failure.fields ? { fields: failure.fields } : {}),
        // Rows already emitted stay valid when a wait timed out or the page state was lost on a later page.
        rows: KEEPS_ROWS.includes(failure.reason) ? rows : [],
        report,
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** Failures after which the rows already emitted are still returned. */
const KEEPS_ROWS: readonly FailureReason[] = ['paused', 'pagination-lost'];

/** Title of the blank page the browser opens on, for window manager rules. */
export const WINDOW_TITLE = 'webscoop';

/** Wait between pages; an abort ends the wait early and fails the run. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new RunFailure('aborted', 'run was interrupted'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RunFailure('aborted', 'run was interrupted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toFailure(error: unknown, signal: AbortSignal | undefined): RunFailure {
  if (signal?.aborted) return new RunFailure('aborted', 'run was interrupted');
  if (error instanceof RunFailure) return error;
  if (error instanceof TimeoutError) return new RunFailure('timeout', error.message);
  return new RunFailure('error', error instanceof Error ? error.message : String(error));
}

/** Convenience wrapper: build a runner and execute it. */
export function runRecipe(opts: RunOptions): Promise<RunResult> {
  return new Runner(opts).run();
}
