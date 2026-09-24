import { RunEmitter, type FailureReason, type Row, type RunReport } from './events';
import { countItems, extractPage, resolveFirst, resolvePaginationTarget, type ResolvedSelectors } from './extract';
import { applyPromotions } from './healing/apply';
import { defaultLadder } from './healing/ladder';
import type { Promotion } from './healing/promote';
import { isHealed, targetName, type HealTarget, type Resolution, type Resolver } from './healing/types';
import { TimeoutError, type BrowserPort, type ElementRef, type OpenOptions, type Session } from './ports';
import type { Fingerprint, Recipe, SelectorCandidate } from './recipe/schema';
import { Dedup, evaluateStop, type PageSummary } from './pagination/dedup';
import { createStrategy } from './pagination/strategies';
import { DEFAULT_PAGE_CAP, PaginationInputError, type PagerContext, type PageStrategy, type StopReason } from './pagination/types';
import { MissingVariableError } from './template';

export type RunState = 'idle' | 'opening' | 'navigating' | 'extracting' | 'repicking' | 'paginating' | 'done' | 'failed';

/** Allowed transitions. Later changes insert states such as `guarded`. */
const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  idle: ['opening', 'failed'],
  opening: ['navigating', 'failed'],
  navigating: ['extracting', 'failed'],
  extracting: ['repicking', 'paginating', 'done', 'failed'],
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

export class RunFailure extends Error {
  constructor(
    readonly reason: FailureReason,
    message: string,
    readonly fields?: string[],
  ) {
    super(message);
    this.name = 'RunFailure';
  }
}

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
    };
    const finish = () => {
      const ended = now();
      report.endedAt = ended.toISOString();
      report.durationMs = ended.getTime() - started.getTime();
    };

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
      const rows: Row[] = [];
      let previous: PageSummary | null = null;
      let fromIndex: number | undefined;
      let reason: StopReason;
      this.transition('navigating');
      let info = await strategy.first(pager);
      for (;;) {
        if (this.currentState === 'navigating') {
          report.finalUrl = info.url;
          this.emitter.emit('page.loaded', { page, url: info.url, title: info.title, status: info.status });
        }
        this.transition('extracting');
        const extraction = await extractPage(live, recipe, {
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
        rows: [],
        report,
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
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
