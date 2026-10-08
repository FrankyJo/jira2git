import { ExitCode, Git2JiraError } from '../core/errors';

/** A git invocation failed. Carries the arguments (never secrets) and stderr for diagnosis. */
export class GitCommandError extends Git2JiraError {
  constructor(
    readonly args: readonly string[],
    readonly gitExitCode: number,
    readonly stderr: string,
  ) {
    super(
      `git ${args.join(' ')} failed (exit ${String(gitExitCode)}): ${stderr.trim() || 'no output'}`,
    );
  }
}

export class GitNotFoundError extends Git2JiraError {
  constructor(options?: ErrorOptions) {
    super('Git is not installed or not on PATH.', ExitCode.Failure, options);
  }
}

export class GitVersionError extends Git2JiraError {
  constructor(found: string, required: string) {
    super(`Git ${required} or newer is required; found ${found}.`);
  }
}

export class NotARepositoryError extends Git2JiraError {
  constructor(cwd: string) {
    super(`${cwd} is not inside a Git working tree.`);
  }
}

export class BareRepositoryError extends Git2JiraError {
  constructor(path: string) {
    super(`${path} is a bare repository; Git2Jira needs a working tree.`);
  }
}

export class DetachedHeadError extends Git2JiraError {
  constructor() {
    super(
      'HEAD is detached. Reports are tracked per branch, so check out the branch you are working on ' +
        '(for example "git switch feature/ABC-123-…") and try again.',
    );
  }
}

export class OperationInProgressError extends Git2JiraError {
  constructor(operation: string) {
    super(`A ${operation} is in progress. Finish or abort it before generating a report.`);
  }
}

export class IssueKeyNotFoundError extends Git2JiraError {
  constructor(branch: string) {
    super(
      `No Jira issue key found in branch "${branch}". Rename the branch to include one ` +
        '(for example feature/ABC-123-description) or pass --issue ABC-123.',
      ExitCode.Usage,
    );
  }
}

export class AmbiguousIssueKeyError extends Git2JiraError {
  constructor(
    branch: string,
    readonly candidates: readonly string[],
  ) {
    super(
      `Branch "${branch}" contains several issue keys (${candidates.join(', ')}). ` +
        'Pass --issue to choose one.',
      ExitCode.Usage,
    );
  }
}

export class InvalidIssueKeyError extends Git2JiraError {
  constructor(value: string) {
    super(
      `"${value}" is not a valid Jira issue key (expected something like ABC-123).`,
      ExitCode.Usage,
    );
  }
}

export class GitOutputLimitError extends Git2JiraError {
  constructor(args: readonly string[], limit: number) {
    super(`git ${args.join(' ')} produced more than ${String(limit)} bytes of output.`);
  }
}

export class BaseBranchNotFoundError extends Git2JiraError {
  constructor(ref: string, source: 'option' | 'repository configuration') {
    super(
      `Base branch "${ref}" (from ${source}) does not exist in this repository. ` +
        'Fetch it, fix the name, or choose another with --base.',
    );
  }
}

export class BaseBranchUndeterminedError extends Git2JiraError {
  constructor(
    readonly candidates: readonly { ref: string; aheadBy: number }[],
    reason: 'ambiguous' | 'missing',
  ) {
    const hint =
      'Pass --base <branch> or set it for this repository with ' +
      '"git2jira config set base.branch <branch> --repo".';
    super(
      reason === 'missing'
        ? `Could not determine the branch this work started from. ${hint}`
        : 'Several branches could be the base of this work: ' +
            candidates.map((c) => `${c.ref} (${String(c.aheadBy)} commits ahead)`).join(', ') +
            `. ${hint}`,
      ExitCode.Usage,
    );
  }
}

export class NoMergeBaseError extends Git2JiraError {
  constructor(base: string) {
    super(`The current branch has no common history with "${base}".`);
  }
}
