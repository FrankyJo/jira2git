import { Git2JiraError } from '../core/errors';

export class SnapshotUnstableError extends Git2JiraError {
  constructor(attempts: number) {
    super(
      `Files kept changing while the working tree was being captured (${String(attempts)} attempts). ` +
        'Wait for builds, formatters, or editors to finish writing and try again.',
    );
  }
}

export class SnapshotCaptureError extends Git2JiraError {
  constructor(message: string, options?: ErrorOptions) {
    super(`Could not capture a consistent snapshot: ${message}`, undefined, options);
  }
}
