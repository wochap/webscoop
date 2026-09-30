/** An answer to a run holding the user's attention, from outside the page: a terminal prompt or a command. */
export type AttentionSignal = 'continue' | 'abort';

/** Attention held by one run, until released. */
export interface AttentionLease {
  /** True when another run held attention first, so the page may have changed meanwhile. */
  readonly waited: boolean;
  /** Called with each continue or abort sent to the run while it holds attention. Returns an unsubscribe function. */
  onSignal(cb: (signal: AttentionSignal) => void): () => void;
  /** A continue re-checked the guard and found it still present. */
  stillBlocked(): void;
  release(): void;
}

/**
 * The user's attention, shared by the runs of one browser: at most one run
 * asks the user at a time. Without a port a run holds attention at once.
 */
export interface AttentionPort {
  /** Wait for attention; rejects when the signal aborts first. */
  acquire(signal?: AbortSignal): Promise<AttentionLease>;
}
