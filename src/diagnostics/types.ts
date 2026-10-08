/** Checks run by `git2jira doctor` (Phase 5). Checks report; they never repair silently. */
export type DiagnosticStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DiagnosticResult {
  status: DiagnosticStatus;
  message: string;
  /** Concrete next step for the user when status is not `pass`. */
  remedy?: string;
}

export interface DiagnosticCheck {
  readonly id: string;
  readonly title: string;
  run(signal?: AbortSignal): Promise<DiagnosticResult>;
}

export interface DiagnosticsRunner {
  run(
    checks: readonly DiagnosticCheck[],
  ): Promise<{ check: DiagnosticCheck; result: DiagnosticResult }[]>;
}
