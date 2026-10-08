import { ExitCode, Git2JiraError } from '../core/errors';

export class CheckpointCorruptedError extends Git2JiraError {
  constructor(location: string, detail: string) {
    super(
      `Report history at ${location} is corrupted (${detail}). Git2Jira will not guess a baseline; ` +
        'run "git2jira recover" to rebuild it from checkpoint refs.',
    );
  }
}

export class CheckpointUnavailableError extends Git2JiraError {
  constructor(sequence: number, detail: string) {
    super(
      `The checkpoint of report #${String(sequence)} cannot be loaded (${detail}). ` +
        'Git2Jira will not fall back to a full report; run "git2jira recover".',
    );
  }
}

export class JournalMissingError extends Git2JiraError {
  constructor(refCount: number) {
    super(
      `Report history is missing, but ${String(refCount)} published checkpoint ref(s) exist. ` +
        'Run "git2jira recover" to rebuild the history instead of producing a full report again.',
    );
  }
}

export class BranchChangedError extends Git2JiraError {
  constructor(previous: string, current: string) {
    super(
      `The last report for this issue was made on branch "${previous}", but you are on "${current}". ` +
        'If this branch continues the same work, rerun with --accept-branch-change.',
      ExitCode.Usage,
    );
  }
}

export class PendingPublicationError extends Git2JiraError {
  constructor(sequence: number, state: string) {
    super(
      `Report #${String(sequence)} is still "${state}" from an earlier run. ` +
        'Run "git2jira recover" so it is not published twice.',
    );
  }
}

export class StaleReportError extends Git2JiraError {
  constructor() {
    super(
      'Another report for this issue was published after this one was prepared. Prepare it again.',
    );
  }
}

export class LockBusyError extends Git2JiraError {
  constructor(file: string) {
    super(`Another Git2Jira process is working on this issue (lock: ${file}). Try again shortly.`);
  }
}

export class MultipleSitesError extends Git2JiraError {
  constructor(sites: readonly string[]) {
    super(
      `This issue has report history for several Jira sites (${sites.join(', ')}). Pass --site to choose one.`,
      ExitCode.Usage,
    );
  }
}

export class UnknownReportError extends Git2JiraError {
  constructor(reportId: string, expected: string) {
    super(`Report ${reportId} is not ${expected}.`);
  }
}

export class InvalidSiteUrlError extends Git2JiraError {
  constructor(url: string) {
    super(
      `"${url}" is not a valid Jira Cloud site URL (expected https://<site>.atlassian.net).`,
      ExitCode.Usage,
    );
  }
}
