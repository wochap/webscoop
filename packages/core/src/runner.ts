import { RunEmitter, type FailureReason, type Row, type RunReport } from './events';
import { extractPage } from './extract';
import { TimeoutError, type BrowserPort, type OpenOptions, type Session } from './ports';
import type { Recipe } from './recipe/schema';
import { fillTemplate, MissingVariableError } from './template';

export type RunState = 'idle' | 'opening' | 'navigating' | 'extracting' | 'done' | 'failed';

/** Allowed transitions. Later changes insert states such as `guarded` and `paginating`. */
const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  idle: ['opening', 'failed'],
  opening: ['navigating', 'failed'],
  navigating: ['extracting', 'failed'],
  extracting: ['done', 'failed'],
  done: [],
  failed: [],
};

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
      warnings: [],
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
      let url: string;
      try {
        url = fillTemplate(recipe.url, recipe.vars, this.opts.vars);
      } catch (error) {
        if (error instanceof MissingVariableError) {
          throw new RunFailure('invalid-input', error.message, error.names);
        }
        throw error;
      }
      this.emitter.emit('run.start', { recipe: recipe.name, url, profileDir, at: report.startedAt });

      this.transition('opening');
      session = await browser.open(profileDir, this.opts.openOptions);
      if (signal?.aborted) throw new RunFailure('aborted', 'run was interrupted');

      this.transition('navigating');
      const page = 1;
      const info = await session.goto(url, { timeoutMs: this.opts.timeoutMs ?? 30_000 });
      report.finalUrl = info.url;
      this.emitter.emit('page.loaded', { page, url: info.url, title: info.title, status: info.status });

      this.transition('extracting');
      const extraction = await extractPage(session, recipe, { pageUrl: info.url, page });
      report.item = extraction.item;
      report.fields = extraction.fields;
      report.warnings.push(...extraction.warnings);
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
      for (const row of extraction.rows) this.emitter.emit('row.emitted', { page, row });
      report.pageCount = page;
      report.rowCount = extraction.rows.length;
      this.emitter.emit('page.done', { page, rows: extraction.rows.length });

      await closeSession();
      finish();
      this.transition('done');
      this.emitter.emit('run.done', { report });
      return { ok: true, rows: extraction.rows, report };
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
