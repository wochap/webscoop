import type { PageInfo, Session } from '../ports';
import type { GuardBudget } from './budget';
import type { GuardMatch } from './detectors';

/** Default interval between guard re-evaluations. */
export const GUARD_POLL_MS = 1000;
/** Longest `settle` wait per poll, so a busy page does not stall the loop. */
export const GUARD_SETTLE_MS = 2000;

/** Thrown when the wait is aborted through its signal. */
export class GuardWaitAborted extends Error {
  constructor() {
    super('the guard wait was aborted');
    this.name = 'GuardWaitAborted';
  }
}

/** Something outside the loop (the banner's Continue button) asking for an immediate re-evaluation. */
export class Recheck {
  private wake: (() => void) | null = null;
  private pending = false;

  trigger(): void {
    this.pending = true;
    this.wake?.();
  }

  /** Wait `ms`, or less when triggered (also before the call) or aborted. */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new GuardWaitAborted());
      if (this.pending) {
        this.pending = false;
        return resolve();
      }
      const done = (fn: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.wake = null;
        this.pending = false;
        fn();
      };
      const onAbort = () => done(() => reject(new GuardWaitAborted()));
      const timer = setTimeout(() => done(resolve), ms);
      this.wake = () => done(resolve);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export interface WaitOptions {
  budget: GuardBudget;
  /** Default 1000. */
  pollMs?: number;
  /** Default 2000. */
  settleMs?: number;
  signal?: AbortSignal;
  recheck?: Recheck;
  /** Called after each evaluation that still matched, with the budget left. */
  onTick?: (remainingMs: number) => void;
  /** Clock in milliseconds, injectable for tests. */
  now?: () => number;
}

export type WaitResult = { cleared: true; waitedMs: number; info: PageInfo } | { cleared: false; waitedMs: number };

/**
 * Poll until `check` no longer matches on a settled page, or the shared
 * budget runs out. Each poll settles the page (capped), then re-evaluates;
 * time spent is drawn from the budget. Rejects with `GuardWaitAborted` when
 * the signal aborts.
 */
export async function waitForClear(
  check: (info: PageInfo) => Promise<GuardMatch | null>,
  session: Session,
  opts: WaitOptions,
): Promise<WaitResult> {
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? GUARD_POLL_MS;
  const recheck = opts.recheck ?? new Recheck();
  const { budget, signal } = opts;
  const started = now();
  let last = started;
  const charge = () => {
    const t = now();
    budget.take(t - last);
    last = t;
  };

  for (;;) {
    if (signal?.aborted) throw new GuardWaitAborted();
    if (budget.exhausted) return { cleared: false, waitedMs: now() - started };
    await recheck.sleep(Math.min(pollMs, budget.remainingMs), signal);
    charge();
    let info: PageInfo | null = null;
    try {
      const settled = await session.settle({ timeoutMs: opts.settleMs ?? GUARD_SETTLE_MS });
      if ((await check(settled)) === null) info = settled;
    } catch {
      if (signal?.aborted) throw new GuardWaitAborted();
      // The user is mid-navigation; try again on the next poll.
    }
    charge();
    if (info) return { cleared: true, waitedMs: now() - started, info };
    opts.onTick?.(budget.remainingMs);
  }
}
