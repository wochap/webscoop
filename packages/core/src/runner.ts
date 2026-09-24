import { RunEmitter, type FailureReason, type Row, type RunReport } from './events';
import { RunFailure } from './failure';
import { countItems, extractPage, resolveFirst, resolvePaginationTarget, type PageExtraction, type ResolvedSelectors } from './extract';
import type { GuardBannerHandler, GuardBannerHooks } from './guards/banner';
import { DEFAULT_GUARD_TIMEOUT_MS, GuardBudget } from './guards/budget';
import { detect, enabledDetectors, guardContext, LOGIN_URL_PATTERN, type GuardDetector, type GuardMatch } from './guards/detectors';
import { Recheck, waitForClear } from './guards/wait';
import { applyPromotions } from './healing/apply';
import { defaultLadder } from './healing/ladder';
import type { Promotion } from './healing/promote';
import { isHealed, targetName, type HealTarget, type Resolution, type Resolver } from './healing/types';
import {
  NoopNotify,
  TimeoutError,
  type BrowserPort,
  type ElementRef,
  type NotifyPort,
  type OpenOptions,
  type PageInfo,
  type Session,
  type WindowPort,
} from './ports';
import type { Fingerprint, Recipe, SelectorCandidate } from './recipe/schema';
import { Dedup, evaluateStop, type PageSummary } from './pagination/dedup';
import { createStrategy } from './pagination/strategies';
import { DEFAULT_PAGE_CAP, PaginationInputError, type PagerContext, type PageStrategy, type StopReason } from './pagination/types';
import { replaySteps, stepsFor, type StepCache } from './steps/replay';
import { fillText, MissingVariableError } from './template';

export type RunState = 'idle' | 'opening' | 'navigating' | 'stepping' | 'extracting' | 'guarded' | 'repicking' | 'paginating' | 'done' | 'failed';

/** Allowed transitions. */
const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  idle: ['opening', 'failed'],
  opening: ['navigating', 'failed'],
  navigating: ['stepping', 'extracting', 'guarded', 'failed'],
  stepping: ['extracting', 'guarded', 'failed'],
  extracting: ['repicking', 'guarded', 'paginating', 'done', 'failed'],
  guarded: ['navigating', 'stepping', 'extracting', 'failed'],
  repicking: ['extracting', 'failed'],
  paginating: ['navigating', 'extracting', 'done', 'failed'],
  done: [],
  failed: [],
};

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
  /** Replay of the recipe's steps. Default: enabled. */
  steps?: StepOptions;
}

export interface StepOptions {
  /** False replays no step, for debugging a recipe (`--skip-steps`). */
  enabled: boolean;
}

export interface GuardOptions {
  /** False disables every guard for the run, whatever the recipe says. */
  enabled: boolean;
  /** Longest total wait across every guard of the run. 0 fails on the first guard. */
  timeoutMs: number;
  /** Told once per guard occurrence. Default: nothing. */
  notify?: NotifyPort;
  /** Shown when a guard is raised. */
  window?: WindowPort;
  /** Banner over the page, for interactive runs only. */
  banner?: GuardBannerHandler;
  /** Interval between re-evaluations while paused. Default 1000. */
  pollMs?: number;
}

export interface PaginationOverrides {
  /** Replaces `pagination.limit`. */
  limit?: number | 'all';
  /** Most pages a `limit: all` run walks. Default 500. */
  cap?: number;
  /** Replaces `pagination.delayMs`. */
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

  private transition(to: RunState): void {
    if (!TRANSITIONS[this.currentState].includes(to)) {
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
        this.transition('repicking');
        this.emitter.emit('repick.requested', { page, target: target.name, oldSelector, fingerprint });
        const result = await handler({
          page,
          target,
          name: target.name,
          oldSelector,
          fingerprint,
          sample: fingerprint?.textSample || null,
          session: ctx.session,
          recipe: current(),
        });
        this.emitter.emit('repick.resolved', { page, target: target.name, result: result.kind });
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
    const report: RunReport = {
      recipe: recipe.name,
      startedAt: started.toISOString(),
      endedAt: started.toISOString(),
      durationMs: 0,
      finalUrl: null,
      pageCount: 0,
      rowCount: 0,
      item: null,
      fields: [],
      pagination: null,
      duplicateCount: 0,
      stopReason: null,
      pages: [],
      warnings: [],
      healed: 0,
      savedTo: null,
      guards: [],
      steps: [],
    };
    const finish = () => {
      const ended = now();
      report.endedAt = ended.toISOString();
      report.durationMs = ended.getTime() - started.getTime();
    };

    const rows: Row[] = [];
    let session: Session | undefined;
    let closing: Promise<void> | undefined;
    const closeSession = (): Promise<void> => {
      if (!session) return Promise.resolve();
      return (closing ??= session.close().catch(() => {}));
    };
    const onAbort = () => void closeSession();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (signal?.aborted) throw new RunFailure('aborted', 'run was interrupted');
      let strategy: PageStrategy;
      try {
        strategy = createStrategy(recipe, this.opts.vars);
        // Step values need their variables too; a missing one fails before the browser opens.
        for (const step of recipe.steps) if (step.kind === 'type' && step.value) fillText(step.value, recipe.vars, this.opts.vars);
      } catch (error) {
        if (error instanceof MissingVariableError || error instanceof PaginationInputError) {
          throw new RunFailure('invalid-input', error.message, error.names);
        }
        throw error;
      }
      this.emitter.emit('run.start', { recipe: recipe.name, url: strategy.url, profileDir, at: report.startedAt });

      this.transition('opening');
      session = await browser.open(profileDir, this.opts.openOptions);
      const live = session;
      if (signal?.aborted) throw new RunFailure('aborted', 'run was interrupted');

      const timeoutMs = this.opts.timeoutMs ?? 30_000;
      const limit = this.opts.pagination?.limit ?? recipe.pagination.limit;
      const cap = this.opts.pagination?.cap ?? DEFAULT_PAGE_CAP;
      const delayMs = this.opts.pagination?.delayMs ?? recipe.pagination.delayMs;
      const healing = this.opts.healing ?? { enabled: true, writeBack: true };
      const promotions: Promotion[] = [];
      const current = () => applyPromotions(recipe, promotions);
      // Rungs such as the model rung run only when the recipe allows them.
      const resolvers = (healing.resolvers ?? []).filter((r) => !r.recipeGated || recipe.healing.llm);
      const onHealed = (page: number) => (promotion: Promotion) => {
        promotions.push(promotion);
        this.emitter.emit('field.healed', {
          page,
          target: targetName(promotion.target),
          outcome: promotion.outcome,
          oldPrimary: promotion.oldPrimary,
          newPrimary: promotion.newPrimary,
        });
      };

      const guardOpts = this.opts.guards;
      const detectors = guardOpts ? enabledDetectors(recipe, guardOpts.enabled) : [];
      const budget = new GuardBudget(guardOpts?.timeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS);

      let page = 1;
      let resolved: ResolvedSelectors | undefined;
      let targetSelectors: SelectorCandidate[] | null = null;
      const pager: PagerContext = {
        session: live,
        recipe,
        timeoutMs,
        target: async () => {
          if (!recipe.pagination.target) return null;
          if (targetSelectors) return (await resolveFirst(live, targetSelectors))?.refs[0] ?? null;
          // First use: the healing ladder, like a field; later pages reuse what it settled on.
          const result = await resolvePaginationTarget(live, recipe, {
            ladder: defaultLadder({ enabled: healing.enabled, extra: resolvers }),
            promote: healing.enabled,
          });
          report.pagination = {
            candidate: result.ref ? (result.selectors[0] ?? null) : null,
            outcome: result.outcome,
            ...(result.notes.length > 0 ? { notes: result.notes } : {}),
          };
          if (isHealed(result.outcome)) report.healed++;
          if (result.promotion) onHealed(page)(result.promotion);
          if (result.ref) targetSelectors = result.selectors;
          return result.ref;
        },
        count: () => (resolved ? countItems(live, recipe, resolved) : Promise.resolve(0)),
        advancing: () => this.emitter.emit('page.advanced', { page: page + 1, kind: strategy.kind }),
        sleep: (ms) => delay(ms, signal),
      };

      const dedup = new Dedup(recipe);
      let previous: PageSummary | null = null;
      let fromIndex: number | undefined;
      let reason: StopReason;
      /** Pause on a guard until it clears, then come back to the page it was raised on. */
      const pause = async (match: GuardMatch, at: PageInfo, intended: string, check: (info: PageInfo) => Promise<GuardMatch | null>): Promise<PageInfo> => {
        const from = this.currentState;
        this.transition('guarded');
        const { kind, reason } = match;
        const url = at.url;
        this.emitter.emit('guard.raised', { kind, page, url, reason });
        await quietly(() => guardOpts?.window?.show());
        await quietly(() => live.focus());
        await quietly(() =>
          (guardOpts?.notify ?? new NoopNotify()).notify({
            title: `webscoop: ${recipe.name} needs you`,
            body: `${kind} guard on page ${page}: ${reason}`,
            urgency: 'critical',
          }),
        );

        const recheck = new Recheck();
        const waitAbort = new AbortController();
        const onRunAbort = () => waitAbort.abort();
        signal?.addEventListener('abort', onRunAbort, { once: true });
        if (signal?.aborted) waitAbort.abort();
        let userAborted = false;
        let hooks: GuardBannerHooks | null = null;
        const banner = guardOpts?.banner;
        let result: Awaited<ReturnType<typeof waitForClear>>;
        try {
          if (banner && !budget.exhausted) {
            // Without a banner the wait still works; polling alone clears the guard.
            hooks = await banner.show(live, { kind, reason, page, url, deadline: Date.now() + budget.remainingMs }).catch(() => null);
            hooks?.onContinue(() => recheck.trigger());
            hooks?.onAbort(() => {
              userAborted = true;
              waitAbort.abort();
            });
          }
          result = await waitForClear(check, live, {
            budget,
            signal: waitAbort.signal,
            recheck,
            ...(guardOpts?.pollMs !== undefined ? { pollMs: guardOpts.pollMs } : {}),
          });
        } catch (error) {
          if (userAborted) throw new RunFailure('aborted', 'the run was aborted from the guard banner');
          throw error;
        } finally {
          signal?.removeEventListener('abort', onRunAbort);
          if (hooks) await quietly(() => banner!.hide());
        }

        report.guards.push({ kind, page, url, waitedMs: result.waitedMs, cleared: result.cleared });
        if (!result.cleared) {
          this.emitter.emit('guard.timeout', { kind, page, url, waitedMs: result.waitedMs });
          throw new RunFailure('paused', `${kind} guard on page ${page} was not cleared within the guard timeout (${reason}): ${url}`);
        }
        this.emitter.emit('guard.cleared', { kind, page, url, waitedMs: result.waitedMs });
        let next = result.info;
        // The user may end up elsewhere, such as the home page after logging in; a login URL is never a page to go back to.
        if (!sameUrl(next.url, intended) && !LOGIN_URL_PATTERN.test(pathOf(intended))) {
          next = await live.goto(intended, { timeoutMs });
        }
        this.transition(from);
        return next;
      };
      const only = (kind: GuardMatch['kind']): GuardDetector[] => detectors.filter((d) => d.kind === kind);
      /** Load-phase guards: pause until none matches; `page.loaded` is emitted again for the resumed page. */
      const guardLoad = async (at: PageInfo, intended: string): Promise<PageInfo> => {
        for (;;) {
          const match = await detect(detectors, 'load', guardContext({ session: live, recipe, info: at, intendedUrl: intended }));
          if (!match) return at;
          at = await pause(match, at, intended, (settled) =>
            detect(only(match.kind), 'load', guardContext({ session: live, recipe, info: settled, intendedUrl: intended })),
          );
          report.finalUrl = at.url;
          this.emitter.emit('page.loaded', { page, url: at.url, title: at.title, status: at.status });
        }
      };

      const stepsEnabled = this.opts.steps?.enabled ?? true;
      const stepCache: StepCache = new Map();
      /** Replay the steps that apply to this page; the page they end on is the one to extract and to come back to. */
      const step = async (): Promise<void> => {
        this.transition('stepping');
        const replay = await replaySteps(live, recipe, {
          page,
          ...(this.opts.vars ? { vars: this.opts.vars } : {}),
          timeoutMs,
          ladder: defaultLadder({ enabled: healing.enabled, extra: resolvers }),
          promote: healing.enabled,
          onHealed: onHealed(page),
          cache: stepCache,
          sleep: (ms) => delay(ms, signal),
          onEvent: (step) => {
            report.steps.push(step);
            if (step.outcome === 'healed') report.healed++;
            if (step.outcome === 'skipped') this.emitter.emit('step.skipped', { page, step });
            else if (step.outcome !== 'failed') this.emitter.emit('step.replayed', { page, step });
          },
          // A step that navigated lands on a new page, which may be walled.
          onNavigated: async (at) => {
            intended = at.url;
            report.finalUrl = at.url;
            return detectors.length > 0 ? guardLoad(at, at.url) : at;
          },
        });
        if (replay.info) {
          info = replay.info;
          intended = info.url;
          report.finalUrl = info.url;
        }
      };

      let intended = strategy.url;
      this.transition('navigating');
      let info = await strategy.first(pager);
      for (;;) {
        if (this.currentState === 'navigating') {
          report.finalUrl = info.url;
          this.emitter.emit('page.loaded', { page, url: info.url, title: info.title, status: info.status });
          if (detectors.length > 0) info = await guardLoad(info, intended);
          if (stepsEnabled && stepsFor(recipe, page).length > 0) await step();
        }
        this.transition('extracting');
        const extract = () =>
          extractPage(live, recipe, {
            pageUrl: info.url,
            page,
            ...(resolved
              ? { resolved }
              : {
                  ladder: defaultLadder({
                    enabled: healing.enabled,
                    extra: [...resolvers, ...(this.opts.repick ? [this.repickResolver(this.opts.repick, page, current)] : [])],
                  }),
                  promote: healing.enabled,
                  onHealed: onHealed(page),
                }),
            ...(fromIndex !== undefined ? { fromIndex } : {}),
          });
        let extraction = await extract();
        // Nothing resolved on a short or errored page: an interstitial, not a redesign.
        for (;;) {
          const laterPage = resolved !== undefined;
          const zeroCtx = (at: PageInfo, found: PageExtraction) =>
            guardContext({ session: live, recipe, info: at, intendedUrl: intended, extraction: found, laterPage });
          const match = await detect(detectors, 'extract', zeroCtx(info, extraction));
          if (!match) break;
          info = await pause(match, info, intended, async (settled) =>
            detect(only(match.kind), 'extract', zeroCtx(settled, await extractPage(live, recipe, { pageUrl: settled.url, page, ...(resolved ? { resolved } : {}) }))),
          );
          extraction = await extract();
        }
        if (!resolved) {
          report.item = extraction.item;
          report.fields = extraction.fields;
          report.healed += extraction.fields.filter((f) => isHealed(f.outcome)).length + (isHealed(extraction.item?.outcome) ? 1 : 0);
          for (const field of extraction.fields) this.emitter.emit('field.resolved', { page, field });
          if (extraction.missingRequired.length > 0) {
            const names = extraction.missingRequired;
            throw new RunFailure(
              'missing-required',
              names.includes('item')
                ? 'the item container matched no element'
                : `required field${names.length > 1 ? 's' : ''} ${names.join(', ')} matched no element`,
              names,
            );
          }
          resolved = extraction.resolved;
        } else {
          // A later page with no items is the end of the list, not a failure; a field gone from every item is.
          const names = extraction.missingRequired.filter((name) => name !== 'item');
          if (names.length > 0) {
            throw new RunFailure(
              'missing-required',
              `required field${names.length > 1 ? 's' : ''} ${names.join(', ')} matched no element on page ${page}`,
              names,
            );
          }
        }
        report.warnings.push(...extraction.warnings);

        const fresh = dedup.preview(extraction.rows, page);
        const summary: PageSummary = {
          page,
          url: info.url,
          firstKey: extraction.rows[0] ? dedup.keyOf(extraction.rows[0]) : null,
          raw: extraction.rows.length,
          kept: fresh.kept.length,
        };
        const verdict = evaluateStop({ current: summary, previous, kind: strategy.kind, stopRules: recipe.pagination.stopRules, limit, cap });
        if (!verdict.discard) {
          fresh.commit();
          fresh.kept.forEach((row, index) => {
            row._index = index;
            rows.push(row);
            this.emitter.emit('row.emitted', { page, row });
          });
          report.pageCount = page;
          report.rowCount = rows.length;
          report.duplicateCount = dedup.duplicates;
          report.pages.push({ page, url: info.url, rows: fresh.kept.length });
          this.emitter.emit('page.done', { page, rows: fresh.kept.length });
        }
        if (verdict.reason) {
          reason = verdict.reason;
          break;
        }

        if (delayMs > 0) await delay(delayMs, signal);
        this.transition('paginating');
        const advance = await strategy.next(pager, page);
        if (advance.kind === 'stop') {
          reason = advance.reason;
          break;
        }
        previous = summary;
        page++;
        if (advance.kind === 'page') {
          info = advance.info;
          intended = advance.url ?? info.url;
          fromIndex = undefined;
          this.transition('navigating');
        } else {
          fromIndex = advance.from;
        }
      }

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
      return { ok: true, rows, report };
    } catch (error) {
      await closeSession();
      finish();
      const failure = toFailure(error, signal);
      if (this.currentState !== 'failed') this.transition('failed');
      this.emitter.emit('run.failed', {
        reason: failure.reason,
        message: failure.message,
        ...(failure.fields ? { fields: failure.fields } : {}),
        report,
      });
      return {
        ok: false,
        reason: failure.reason,
        message: failure.message,
        ...(failure.fields ? { fields: failure.fields } : {}),
        // Rows of completed pages stay valid when a guard timed out.
        rows: failure.reason === 'paused' ? rows : [],
        report,
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** Side effects such as notifications must never fail the run. */
async function quietly(fn: () => Promise<void> | undefined): Promise<void> {
  try {
    await fn();
  } catch {
    // Ignored on purpose.
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

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
