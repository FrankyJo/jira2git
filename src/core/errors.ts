import { PHASES, type Phase } from './phases';

/** Process exit codes used by the CLI. */
export const ExitCode = {
  Success: 0,
  Failure: 1,
  Usage: 2,
  NotImplemented: 3,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Base class for errors that carry a user-facing message and an exit code. */
export class Git2JiraError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = ExitCode.Failure,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigError extends Git2JiraError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.Failure, options);
  }
}

export class UsageError extends Git2JiraError {
  constructor(message: string) {
    super(message, ExitCode.Usage);
  }
}

/** Raised by any capability that a later phase will deliver. Never caught to fake success. */
export class NotImplementedError extends Git2JiraError {
  constructor(
    readonly feature: string,
    readonly phase: Phase,
  ) {
    super(
      `${feature} is not available yet. It is planned for Phase ${phase}: ${PHASES[phase]}.`,
      ExitCode.NotImplemented,
    );
  }
}
