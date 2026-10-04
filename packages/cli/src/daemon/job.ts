import { resolve } from 'node:path';
import type { AttentionLease, AttentionPort, AttentionSignal, BrowserPort, OpenOptions, RunEmitter, Session } from '@webscoop/core';
import {
  BROWSER_PID_DEADLINE_MS,
  executeRun,
  executeTest,
  infoLog,
  launchKey,
  launchSettings,
  prepare,
  type Prepared,
  type RunCommandOptions,
  type TestCommandOptions,
} from '../commands/run';
import { log, type CliIo, type Output, type SharedBrowserHandle } from '../context';
import { reportError } from '../exit';
import type { HookQueue } from '../hooks';
import { Redactor } from '../redact';
import type { ResolvedVars } from '../vars';
import { acquireProfileLock } from '../lock';
import { writeMarker } from '../profiles';
import type { ClientMessage, DaemonMessage } from './protocol';
import type { AttentionGate, Job, LaunchedBrowser } from './scheduler';

type Submit = Extract<ClientMessage, { type: 'submit' }>;

/** What the daemon shares between its jobs. */
export interface DaemonShared {
  /** The daemon's own I/O: browsers, notifications, the recorder bundle. */
  base: CliIo;
  /** Hooks of every job run one at a time. */
  hookQueue: HookQueue;
  /** The daemon log, for hook output. */
  log: Output;
  /** Write-backs per recipe file, one at a time. */
  writes: Map<string, Promise<unknown>>;
}

/** The job's view of the world: the submitting command's environment and directory, with output sent back to it. */
export function jobIo(base: CliIo, submit: Submit, send: (m: DaemonMessage) => void): CliIo & { interrupt(message?: string): void } {
  const handlers = new Set<() => void>();
  const resolved = (submit.options as { resolvedVars?: ResolvedVars }).resolvedVars;
  const redactor = Redactor.of(resolved?.values, resolved?.secrets);
  const io: CliIo & { interrupt(message?: string): void } = {
    ...base,
    // Rows are page data and pass as they are; everything webscoop says about the run is masked.
    stdout: { write: (data: string) => send({ type: 'stdout', data }) },
    stderr: { write: (data: string) => send({ type: 'stderr', data: redactor.redact(data) }) },
    env: submit.env,
    cwd: submit.cwd,
    terminal: false,
    onInterrupt(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    prompt: async () => null,
    // The notification fallback text belongs on the job's stderr, not in the daemon log.
    createNotify: (env) => base.createNotify(env, io.stderr),
    interrupt(message) {
      if (message) log(io, message);
      for (const handler of [...handlers]) handler();
    },
  };
  delete io.tty;
  delete io.daemon;
  return io;
}

/** Wait for the profile lock until the signal aborts, saying once who holds it. */
async function waitForLock(io: CliIo, profileDir: string, profile: string, signal: AbortSignal, quiet: boolean | undefined) {
  let said = false;
  for (;;) {
    if (signal.aborted) throw new Error('aborted');
    try {
      return await acquireProfileLock(profileDir, { timeoutMs: 0, profileName: profile });
    } catch (error) {
      if (!said) {
        infoLog(io, quiet)(`${(error as Error).message.replace(/; gave up after .*$/, '')}; waiting for it`);
        said = true;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Launch through the I/O's shared browser, or open one `createBrowser` session per tab. */
async function launchShared(io: CliIo, prepared: Prepared, launch: OpenOptions): Promise<SharedBrowserHandle> {
  if (io.launchBrowser) return io.launchBrowser(prepared.config, io.env, prepared.browser, prepared.profileDir, launch);
  const port = await io.createBrowser(prepared.config, io.env, prepared.browser);
  const listeners = new Set<() => void>();
  return {
    newSession: (tab) => port.open(prepared.profileDir, { ...launch, ...tab }),
    close: async () => listeners.forEach((cb) => cb()),
    onClosed: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** A `run` or `test` job in the daemon. */
export class DaemonJob implements Job {
  readonly recipe: string;
  readonly profile: string;
  readonly profileDir: string;
  readonly key: string;
  readonly concurrency: number;
  readonly idleMs: number;
  readonly queueTimeoutMs?: number;
  private readonly signalListeners = new Set<(signal: AttentionSignal) => void>();
  private ended = false;

  private constructor(
    readonly runId: string,
    private readonly shared: DaemonShared,
    private readonly submit: Submit,
    private readonly io: ReturnType<typeof jobIo>,
    private readonly prepared: Prepared,
    private readonly launchOptions: OpenOptions,
    private readonly send: (m: DaemonMessage) => void,
  ) {
    this.recipe = prepared.recipe.name;
    this.profile = prepared.profile.profile;
    this.profileDir = prepared.profileDir;
    this.key = launchKey(prepared, launchOptions);
    this.concurrency = prepared.config.daemon.concurrency;
    this.idleMs = prepared.config.daemon.idleMs;
    if (submit.queueTimeoutMs !== undefined) this.queueTimeoutMs = submit.queueTimeoutMs;
  }

  /** Load the job's config and recipe in its environment; null after reporting an error to the client. */
  static async create(runId: string, shared: DaemonShared, submit: Submit, send: (m: DaemonMessage) => void): Promise<DaemonJob | null> {
    const io = jobIo(shared.base, submit, send);
    try {
      const prepared = await prepare(io, submit.command, submit.recipe, submit.options as unknown as RunCommandOptions, {
        runId,
        queue: shared.hookQueue,
        stderr: shared.log,
      });
      return new DaemonJob(runId, shared, submit, io, prepared, await launchSettings(io, prepared), send);
    } catch (error) {
      send({ type: 'done', exitCode: reportError(io, error) });
      return null;
    }
  }

  private get quiet(): boolean | undefined {
    return (this.submit.options as { quiet?: boolean }).quiet;
  }

  async launch(signal: AbortSignal): Promise<LaunchedBrowser> {
    const { prepared, io } = this;
    const lock = await waitForLock(io, this.profileDir, this.profile, signal, this.quiet);
    try {
      await this.prepared.hooks.fire('browser.starting');
      const handle = await launchShared(io, prepared, this.launchOptions);
      await writeMarker(this.profileDir, prepared.browser, prepared.browser.version).catch(() => {});
      const pid = await io.findBrowserPid(resolve(this.profileDir), BROWSER_PID_DEADLINE_MS).catch(() => null);
      prepared.hooks.setPid(pid ?? undefined);
      void prepared.hooks.fire('browser.started');
      return { handle, pid, release: () => lock.release() };
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  async execute(ctx: { browser: SharedBrowserHandle; attention: AttentionGate }): Promise<number> {
    const browser: BrowserPort = {
      open: (_profileDir, opts): Promise<Session> =>
        ctx.browser.newSession({ ...(opts?.humanize ? { humanize: true } : {}), ...(opts?.bypassCSP ? { bypassCSP: true } : {}), ...(opts?.downloadDir ? { downloadDir: opts.downloadDir } : {}) }),
    };
    const job = { browser, attention: this.attentionPort(ctx.attention), saveRecipe: this.saveRecipe, watch: (emitter: RunEmitter) => this.watch(emitter) };
    try {
      const options = this.submit.options;
      return this.submit.command === 'run'
        ? await executeRun(this.io, this.prepared, options as unknown as RunCommandOptions, job)
        : await executeTest(this.io, this.prepared, options as unknown as TestCommandOptions, job);
    } catch (error) {
      return reportError(this.io, error);
    }
  }

  queued(ahead: number): void {
    infoLog(this.io, this.quiet)(`queued on profile "${this.profile}": ${ahead} job${ahead === 1 ? '' : 's'} ahead`);
    void this.prepared.hooks.fire('run.queued', { ahead });
  }

  started(): void {
    this.send({ type: 'started' });
  }

  finish(code: number, message?: string): void {
    if (this.ended) return;
    this.ended = true;
    if (message) log(this.io, message);
    void this.prepared.hooks.drain().then(() => this.send({ type: 'done', exitCode: code }));
  }

  interrupt(message?: string): void {
    this.io.interrupt(message);
  }

  async browserClosed(pid: number | null): Promise<void> {
    this.prepared.hooks.setPid(pid ?? undefined);
    await this.prepared.hooks.fire('browser.closed');
  }

  /** A continue or abort for this job, from the terminal or `webscoop attention`. False when it does not hold attention. */
  signal(action: AttentionSignal): boolean {
    if (this.signalListeners.size === 0) return false;
    for (const cb of [...this.signalListeners]) cb(action);
    return true;
  }

  /** Whether the job holds attention and listens for signals. */
  get holdsAttention(): boolean {
    return this.signalListeners.size > 0;
  }

  private readonly saveRecipe = (path: string, save: () => Promise<string>): Promise<string> => {
    const writes = this.shared.writes;
    const previous = writes.get(path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(save);
    writes.set(path, next);
    void next.finally(() => writes.get(path) === next && writes.delete(path)).catch(() => {});
    return next;
  };

  private attentionPort(gate: AttentionGate): AttentionPort {
    return {
      acquire: async (signal) => {
        const holder = gate.holder;
        if (holder !== null && holder !== this.runId) {
          infoLog(this.io, this.quiet)(`waiting for run ${holder} to finish with the browser's attention`);
          this.send({ type: 'waiting-attention', holder });
        }
        const lease = await gate.acquire(this.runId, signal);
        const listeners = new Set<(s: AttentionSignal) => void>();
        const out: AttentionLease = {
          waited: lease.waited,
          onSignal: (cb) => {
            listeners.add(cb);
            this.signalListeners.add(cb);
            return () => {
              listeners.delete(cb);
              this.signalListeners.delete(cb);
            };
          },
          stillBlocked: () => this.send({ type: 'still-blocked', runId: this.runId }),
          release: () => {
            for (const cb of listeners) this.signalListeners.delete(cb);
            listeners.clear();
            lease.release();
          },
        };
        return out;
      },
    };
  }

  private watch(emitter: RunEmitter): void {
    emitter.on('attention.needed', (e) =>
      this.send({ type: 'attention', runId: this.runId, reason: e.reason, ...(e.kind ? { kind: e.kind } : {}), ...(e.label ? { label: e.label } : {}), page: e.page, url: e.url }),
    );
    emitter.on('attention.resolved', () => this.send({ type: 'attention-resolved', runId: this.runId }));
  }
}
