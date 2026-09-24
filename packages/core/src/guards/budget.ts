/** Default guard timeout: ten minutes across every guard of a run. */
export const DEFAULT_GUARD_TIMEOUT_MS = 600_000;

/** What is left of a run's guard timeout; every wait draws from the same budget. */
export class GuardBudget {
  private left: number;

  constructor(readonly totalMs: number) {
    this.left = Math.max(0, totalMs);
  }

  get remainingMs(): number {
    return this.left;
  }

  get exhausted(): boolean {
    return this.left <= 0;
  }

  /** Spend `ms` of the budget. */
  take(ms: number): void {
    this.left = Math.max(0, this.left - Math.max(0, ms));
  }
}
