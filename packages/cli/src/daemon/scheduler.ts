import type { SharedBrowserHandle } from '../context';
import type { BrowserStatus } from './protocol';

/** A browser the daemon launched for a profile, holding the profile lock. */
export interface LaunchedBrowser {
  handle: SharedBrowserHandle;
  /** Main process id, when found. */
  pid: number | null;
  /** Release the profile lock. */
  release(): void;
}

/** What the scheduler needs from a job. */
export interface Job {
  readonly runId: string;
  readonly recipe: string;
  readonly profile: string;
  readonly profileDir: string;
  /** Canonical launch settings; a job runs only in a browser launched with the same key. */
  readonly key: string;
  /** `daemon.concurrency` and `daemon.idleMs` of the job's config, used when it launches the browser. */
  readonly concurrency: number;
  readonly idleMs: number;
  /** Give up when the job has not started within this many milliseconds. */
  readonly queueTimeoutMs?: number;
  /** Launch the profile's browser; waits for the profile lock until the signal aborts. */
  launch(signal: AbortSignal): Promise<LaunchedBrowser>;
  /** Run in the browser; resolves with the exit code. */
  execute(ctx: { browser: SharedBrowserHandle; attention: AttentionGate }): Promise<number>;
  /** The job waits behind `ahead` jobs. */
  queued(ahead: number): void;
  /** The job left the queue and has its browser. */
  started(): void;
  /** The job ended; `message` explains an end the job did not report itself. */
  finish(code: number, message?: string): void;
  /** Stop a running job. */
  interrupt(message?: string): void;
  /** The browser this job ran in last closed. */
  browserClosed(pid: number | null): Promise<void>;
}

type JobState = 'queued' | 'launching' | 'running';

interface Entry {
  job: Job;
  state: JobState;
  timer?: NodeJS.Timeout;
  /** Set when the job was cancelled before it started. */
  cancelled?: string;
}

/** The user's attention in one browser: one run at a time, in request order. */
export class AttentionGate {
  private current: string | null = null;
  private readonly waiters: { runId: string; grant: () => void }[] = [];

  /** Run id holding attention. */
  get holder(): string | null {
    return this.current;
  }

  /** Wait for attention; `waited` is true when another run held it first. Rejects when the signal aborts. */
  acquire(runId: string, signal?: AbortSignal): Promise<{ waited: boolean; release: () => void }> {
    let released = false;
    const lease = (waited: boolean) => ({
      waited,
      release: () => {
        if (released) return;
        released = true;
        if (this.current !== runId) return;
        const next = this.waiters.shift();
        this.current = next?.runId ?? null;
        next?.grant();
      },
    });
    if (this.current === null) {
      this.current = runId;
      return Promise.resolve(lease(false));
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'));
      const waiter = {
        runId,
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(lease(true));
        },
      };
      const onAbort = () => {
        const at = this.waiters.indexOf(waiter);
        if (at !== -1) this.waiters.splice(at, 1);
        reject(new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }
}

/** One profile: its browser, its running and queued jobs, and its attention. */
class Slot {
  browser: LaunchedBrowser | null = null;
  launching: Promise<LaunchedBrowser> | null = null;
  launchAbort: AbortController | null = null;
  closing: Promise<void> | null = null;
  key: string | null = null;
  concurrency = 1;
  idleMs = 0;
  readonly running = new Map<string, Entry>();
  readonly queue: Entry[] = [];
  idleTimer: NodeJS.Timeout | undefined;
  pauseTimer: NodeJS.Timeout | undefined;
  pausedUntil = 0;
  lastJob: Job | null = null;
  readonly attention = new AttentionGate();

  constructor(
    readonly profile: string,
    readonly profileDir: string,
  ) {}

  get busy(): boolean {
    return this.running.size > 0 || this.queue.length > 0;
  }

  get open(): boolean {
    return this.browser !== null || this.launching !== null || this.closing !== null;
  }
}

export interface SchedulerOptions {
  /** Called when no browser is open and no job is left. */
  onEmpty?: () => void;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** How long new launches on a profile wait after an exclusive command took its browser. Default 5000. */
  releasePauseMs?: number;
  /** Replaces every job's `daemon.idleMs`. */
  idleMs?: number;
}

/**
 * Per-profile browsers and FIFO queues: each browser runs at most its
 * concurrency of jobs; a job with other launch settings waits until the
 * browser is idle, which is then relaunched.
 */
export class Scheduler {
  private readonly slots = new Map<string, Slot>();
  private readonly now: () => number;

  constructor(private readonly opts: SchedulerOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** No browser open and no job. */
  get empty(): boolean {
    return [...this.slots.values()].every((s) => !s.open && !s.busy);
  }

  submit(job: Job): void {
    let slot = this.slots.get(job.profileDir);
    if (!slot) {
      slot = new Slot(job.profile, job.profileDir);
      this.slots.set(job.profileDir, slot);
    }
    const entry: Entry = { job, state: 'queued' };
    slot.queue.push(entry);
    if (job.queueTimeoutMs !== undefined) {
      const target = slot;
      entry.timer = setTimeout(() => this.timeOut(target, entry), job.queueTimeoutMs);
      entry.timer.unref?.();
    }
    this.pump(slot);
    if (entry.state === 'queued') job.queued(slot.running.size + slot.queue.indexOf(entry));
  }

  /** Cancel a job, queued or running. False when no such job. */
  cancel(runId: string, message?: string): boolean {
    for (const slot of this.slots.values()) {
      const at = slot.queue.findIndex((e) => e.job.runId === runId);
      if (at !== -1) {
        const [entry] = slot.queue.splice(at, 1);
        this.drop(slot, entry!, message ?? 'cancelled while waiting in the queue');
        return true;
      }
      const entry = slot.running.get(runId);
      if (entry) {
        if (entry.state === 'launching') this.dropLaunching(slot, entry, message ?? 'cancelled while waiting for the browser');
        else entry.job.interrupt(message);
        return true;
      }
    }
    return false;
  }

  /** Whether a job is known. */
  has(runId: string): boolean {
    return [...this.slots.values()].some((s) => s.running.has(runId) || s.queue.some((e) => e.job.runId === runId));
  }

  /** Run ids holding attention, with their recipes. */
  attentionHolders(): { runId: string; recipe: string }[] {
    const out: { runId: string; recipe: string }[] = [];
    for (const slot of this.slots.values()) {
      const holder = slot.attention.holder;
      if (holder) out.push({ runId: holder, recipe: slot.running.get(holder)?.job.recipe ?? '' });
    }
    return out;
  }

  status(): BrowserStatus[] {
    return [...this.slots.values()]
      .filter((s) => s.open || s.busy)
      .map((s) => ({
        profile: s.profile,
        profileDir: s.profileDir,
        pid: s.browser?.pid ?? null,
        running: [...s.running.values()].filter((e) => e.state === 'running').map((e) => ({ runId: e.job.runId, recipe: e.job.recipe })),
        queued: [...[...s.running.values()].filter((e) => e.state !== 'running'), ...s.queue].map((e) => ({ runId: e.job.runId, recipe: e.job.recipe })),
        attention: s.attention.holder,
      }));
  }

  /** Jobs on a profile's browser: running and queued, and whether a browser is open. */
  usage(profileDir: string): { profile: string | null; running: number; queued: number; open: boolean } {
    const slot = this.slots.get(profileDir);
    if (!slot) return { profile: null, running: 0, queued: 0, open: false };
    const running = [...slot.running.values()].filter((e) => e.state === 'running').length;
    return { profile: slot.profile, running, queued: slot.running.size - running + slot.queue.length, open: slot.open || slot.busy };
  }

  /**
   * Give a profile to an exclusive command: cancel its jobs with the message,
   * close its browser, and hold new launches back for a moment, so the
   * command takes the profile lock first.
   */
  async release(profileDir: string, message: string): Promise<void> {
    const slot = this.slots.get(profileDir);
    if (!slot) return;
    slot.pausedUntil = this.now() + (this.opts.releasePauseMs ?? 5000);
    for (const entry of slot.queue.splice(0)) this.drop(slot, entry, message);
    for (const entry of [...slot.running.values()]) {
      if (entry.state === 'launching') this.dropLaunching(slot, entry, message);
      else entry.job.interrupt(message);
    }
    await this.settled(slot);
    await this.closeBrowser(slot);
    this.schedulePump(slot);
  }

  /** Stop: cancel every job (with `force`) or let them finish, then close every browser. */
  async stop(force: boolean, message = 'stopped by `webscoop daemon stop --force`'): Promise<void> {
    if (force) {
      for (const slot of this.slots.values()) {
        for (const entry of slot.queue.splice(0)) this.drop(slot, entry, message);
        for (const entry of [...slot.running.values()]) {
          if (entry.state === 'launching') this.dropLaunching(slot, entry, message);
          else entry.job.interrupt(message);
        }
      }
    }
    await Promise.all([...this.slots.values()].map((slot) => this.settled(slot)));
    await Promise.all([...this.slots.values()].map((slot) => this.closeBrowser(slot)));
  }

  /** Wait until a slot has no job. */
  private settled(slot: Slot): Promise<void> {
    return new Promise((resolve) => {
      const check = () => (slot.busy ? setTimeout(check, 20) : resolve());
      check();
    });
  }

  private drop(slot: Slot, entry: Entry, message: string): void {
    clearTimeout(entry.timer);
    entry.job.finish(1, message);
    this.afterJob(slot);
  }

  private dropLaunching(slot: Slot, entry: Entry, message: string): void {
    entry.cancelled = message;
    clearTimeout(entry.timer);
    // The launch goes on for the other jobs waiting on it; alone, it is abandoned.
    const waiting = [...slot.running.values()].filter((e) => e.state === 'launching' && !e.cancelled);
    if (waiting.length === 0) slot.launchAbort?.abort();
  }

  private timeOut(slot: Slot, entry: Entry): void {
    if (entry.state === 'running') return;
    const ahead = entry.state === 'queued' ? slot.running.size + slot.queue.indexOf(entry) : 0;
    const message = `gave up after ${entry.job.queueTimeoutMs} ms waiting for profile "${slot.profile}" (${ahead} job${ahead === 1 ? '' : 's'} ahead${entry.state === 'launching' ? ', waiting for its browser' : ''})`;
    if (entry.state === 'queued') {
      slot.queue.splice(slot.queue.indexOf(entry), 1);
      this.drop(slot, entry, message);
    } else {
      this.dropLaunching(slot, entry, message);
    }
  }

  private schedulePump(slot: Slot): void {
    const wait = slot.pausedUntil - this.now();
    clearTimeout(slot.pauseTimer);
    if (wait > 0) {
      slot.pauseTimer = setTimeout(() => this.pump(slot), wait);
      slot.pauseTimer.unref?.();
    } else {
      this.pump(slot);
    }
  }

  private pump(slot: Slot): void {
    if (slot.closing) return;
    while (slot.queue.length > 0) {
      if (this.now() < slot.pausedUntil) {
        this.schedulePump(slot);
        return;
      }
      const head = slot.queue[0]!;
      const live = slot.browser !== null || slot.launching !== null;
      if (live && slot.key !== head.job.key) {
        // Other launch settings: wait for the browser to be idle, then relaunch.
        if (slot.running.size === 0 && slot.browser) void this.closeBrowser(slot).then(() => this.pump(slot));
        return;
      }
      if (slot.running.size >= (live ? slot.concurrency : head.job.concurrency)) return;
      slot.queue.shift();
      void this.start(slot, head);
    }
  }

  private async start(slot: Slot, entry: Entry): Promise<void> {
    const { job } = entry;
    entry.state = 'launching';
    slot.running.set(job.runId, entry);
    clearTimeout(slot.idleTimer);
    if (!slot.browser && !slot.launching) {
      slot.key = job.key;
      slot.concurrency = job.concurrency;
      slot.idleMs = this.opts.idleMs ?? job.idleMs;
      const abort = new AbortController();
      slot.launchAbort = abort;
      slot.launching = job
        .launch(abort.signal)
        .then((launched) => {
          slot.browser = launched;
          slot.lastJob = job;
          launched.handle.onClosed(() => void this.browserGone(slot, launched));
          return launched;
        })
        .finally(() => {
          slot.launching = null;
          slot.launchAbort = null;
        });
    }
    let launched: LaunchedBrowser;
    try {
      launched = slot.browser ?? (await slot.launching!);
    } catch (error) {
      slot.running.delete(job.runId);
      clearTimeout(entry.timer);
      job.finish(1, entry.cancelled ?? (error instanceof Error ? error.message : String(error)));
      this.afterJob(slot);
      return;
    }
    if (entry.cancelled) {
      slot.running.delete(job.runId);
      job.finish(1, entry.cancelled);
      this.afterJob(slot);
      return;
    }
    clearTimeout(entry.timer);
    entry.state = 'running';
    job.started();
    let code: number;
    let message: string | undefined;
    try {
      code = await job.execute({ browser: launched.handle, attention: slot.attention });
    } catch (error) {
      code = 1;
      message = error instanceof Error ? error.message : String(error);
    }
    slot.running.delete(job.runId);
    slot.lastJob = job;
    // With no idle time the browser closes before the job reports its end, so its hooks come first.
    if (!slot.busy && slot.idleMs <= 0) await this.closeBrowser(slot);
    job.finish(code, message);
    this.afterJob(slot);
  }

  private afterJob(slot: Slot): void {
    this.pump(slot);
    if (slot.busy) return;
    clearTimeout(slot.idleTimer);
    if (slot.browser) {
      if (slot.idleMs <= 0) {
        void this.closeBrowser(slot);
      } else {
        slot.idleTimer = setTimeout(() => void this.closeBrowser(slot), slot.idleMs);
        slot.idleTimer.unref?.();
      }
    } else {
      this.checkEmpty();
    }
  }

  private async closeBrowser(slot: Slot): Promise<void> {
    if (slot.closing) return slot.closing;
    const launched = slot.browser;
    if (!launched) {
      this.checkEmpty();
      return;
    }
    clearTimeout(slot.idleTimer);
    slot.closing = (async () => {
      slot.browser = null;
      slot.key = null;
      await launched.handle.close().catch(() => {});
      launched.release();
      await slot.lastJob?.browserClosed(launched.pid).catch(() => {});
    })();
    try {
      await slot.closing;
    } finally {
      slot.closing = null;
    }
    this.pump(slot);
    this.checkEmpty();
  }

  /** The user closed the window, or the browser crashed. */
  private async browserGone(slot: Slot, launched: LaunchedBrowser): Promise<void> {
    if (slot.browser !== launched) return;
    await this.closeBrowser(slot);
  }

  private checkEmpty(): void {
    for (const [dir, slot] of this.slots) if (!slot.open && !slot.busy) this.slots.delete(dir);
    if (this.empty) this.opts.onEmpty?.();
  }
}
