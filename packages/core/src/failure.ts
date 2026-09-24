import type { FailureReason } from './events';

/** Why a run stopped early, thrown from the runner and the modules it drives. */
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
