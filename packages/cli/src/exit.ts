import type { FailureReason } from '@webscoop/core';

export const ExitCode = {
  /** The command succeeded. */
  Ok: 0,
  /** An error the user must fix, or an unexpected failure. */
  Error: 1,
  /** A run paused for user input and the wait timed out. Retry later. */
  Paused: 2,
  /** A required field could not be resolved. Alert a human. */
  Unresolved: 3,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** An error that ends the command with a message on stderr and a given exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = ExitCode.Error,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function exitCodeFor(reason: FailureReason): ExitCode {
  return reason === 'missing-required' ? ExitCode.Unresolved : ExitCode.Error;
}
