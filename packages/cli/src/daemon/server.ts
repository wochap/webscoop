import { randomUUID } from 'node:crypto';
import type { CliIo, Output } from '../context';
import { DaemonJob, type DaemonShared } from './job';
import type { ClientMessage, DaemonMessage, ServerLink } from './protocol';
import { Scheduler } from './scheduler';

export interface DaemonServerOptions {
  /** The daemon's own I/O. */
  base: CliIo;
  version: string;
  programPath: string;
  /** The daemon log. */
  log: Output;
  /** Called once when the daemon has nothing left and should exit. */
  onExit: () => void;
  /** Exit after this long without a job when nothing is open. Default 10000. */
  startupGraceMs?: number;
  /** Replaces every job's `daemon.idleMs`. */
  idleMs?: number;
}

/**
 * The daemon: accepts connections, runs jobs through the scheduler, answers
 * status, stop, attention, and release requests, and exits once it has no
 * browser and no job.
 */
export class DaemonServer {
  readonly scheduler: Scheduler;
  private readonly shared: DaemonShared;
  private readonly jobs = new Map<string, DaemonJob>();
  /** Jobs still loading their config and recipe. */
  private pending = 0;
  private draining = false;
  private exited = false;
  private graceTimer: NodeJS.Timeout | undefined;
  private everSubmitted = false;

  constructor(private readonly opts: DaemonServerOptions) {
    this.scheduler = new Scheduler({ onEmpty: () => this.maybeExit(), ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}) });
    this.shared = { base: opts.base, hookQueue: { chain: Promise.resolve() }, log: opts.log, writes: new Map() };
    this.graceTimer = setTimeout(() => this.maybeExit(true), opts.startupGraceMs ?? 10_000);
    this.graceTimer.unref?.();
  }

  get isExited(): boolean {
    return this.exited;
  }

  private note(line: string): void {
    this.opts.log.write(`${new Date().toISOString()} ${line}\n`);
  }

  accept(link: ServerLink): void {
    let runId: string | null = null;
    let done = false;
    const send = (m: DaemonMessage) => {
      if (m.type === 'done') {
        done = true;
        if (runId) this.jobs.delete(runId);
      }
      link.send(m);
    };
    link.onClose(() => {
      if (runId && !done) this.scheduler.cancel(runId);
    });
    link.onMessage((m: ClientMessage) => {
      switch (m.type) {
        case 'hello': {
          const accepted = m.version === this.opts.version && m.programPath === this.opts.programPath;
          if (!accepted && !this.draining) {
            this.note(`client ${m.version} (${m.programPath}) differs from ${this.opts.version} (${this.opts.programPath}); finishing jobs and exiting`);
            this.drain();
          }
          link.send({ type: 'welcome', version: this.opts.version, pid: process.pid, accepted });
          break;
        }
        case 'submit': {
          if (this.draining) {
            send({ type: 'stderr', data: 'webscoop: the daemon is shutting down; run the command again\n' });
            send({ type: 'done', exitCode: 1 });
            break;
          }
          clearTimeout(this.graceTimer);
          this.everSubmitted = true;
          const id = randomUUID();
          runId = id;
          send({ type: 'accepted', runId: id });
          this.pending++;
          void DaemonJob.create(id, this.shared, m, send).then((job) => {
            this.pending--;
            if (!job) return this.maybeExit();
            if (done) return;
            this.jobs.set(id, job);
            this.note(`job ${id}: ${m.command} ${job.recipe} on profile ${job.profile}`);
            this.scheduler.submit(job);
          });
          break;
        }
        case 'cancel':
          if (runId && !done) this.scheduler.cancel(runId);
          break;
        case 'signal':
          link.send(this.signal(m.runId, m.action));
          break;
        case 'status':
          link.send({ type: 'status', status: { pid: process.pid, version: this.opts.version, browsers: this.scheduler.status() } });
          break;
        case 'stop':
          void this.stop(m.force).then(() => link.send({ type: 'result', ok: true }));
          break;
        case 'release': {
          const usage = this.scheduler.usage(m.profileDir);
          if (!m.force || !usage.open) {
            link.send({ type: 'released', profile: usage.profile ?? '', running: usage.running, queued: usage.queued, open: usage.open });
            break;
          }
          this.note(`releasing ${m.profileDir} for ${m.command}`);
          void this.scheduler.release(m.profileDir, `stopped by \`${m.command}\``).then(() =>
            link.send({ type: 'released', profile: usage.profile ?? '', running: 0, queued: 0, open: false }),
          );
          break;
        }
      }
    });
  }

  /** Refuse new jobs, finish or cancel the others, close every browser, and exit. */
  async stop(force: boolean): Promise<void> {
    this.draining = true;
    await this.scheduler.stop(force);
    this.maybeExit();
  }

  private drain(): void {
    this.draining = true;
    void this.scheduler.stop(false).then(() => this.maybeExit());
  }

  private signal(runId: string | undefined, action: 'continue' | 'abort'): DaemonMessage {
    const holders = this.scheduler.attentionHolders();
    let target: string;
    if (runId !== undefined) {
      if (!this.jobs.has(runId)) return { type: 'result', ok: false, message: `no run ${runId}` };
      if (!holders.some((h) => h.runId === runId)) return { type: 'result', ok: false, message: `run ${runId} does not hold attention` };
      target = runId;
    } else if (holders.length === 1) {
      target = holders[0]!.runId;
    } else if (holders.length === 0) {
      return { type: 'result', ok: false, message: 'no run holds attention' };
    } else {
      return { type: 'result', ok: false, message: `several runs hold attention; pass one of: ${holders.map((h) => `${h.runId} (${h.recipe})`).join(', ')}` };
    }
    const job = this.jobs.get(target);
    if (!job?.signal(action)) return { type: 'result', ok: false, message: `run ${target} is waiting for a re-pick in the browser, not for a guard` };
    return { type: 'result', ok: true, message: target };
  }

  /** Exit once nothing is open and no job is left, after the first job or the startup grace. */
  private maybeExit(grace = false): void {
    if (this.exited || this.pending > 0 || !this.scheduler.empty) return;
    if (!grace && !this.draining && !this.everSubmitted) return;
    this.exited = true;
    clearTimeout(this.graceTimer);
    this.note('exiting');
    this.opts.onExit();
  }
}
