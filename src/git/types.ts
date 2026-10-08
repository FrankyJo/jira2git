import { z } from 'zod';

/**
 * Runs the system `git` binary. Implementations MUST use `execFile` with an
 * argument array (never a shell), set `GIT_TERMINAL_PROMPT=0`, disable
 * external diff/textconv drivers and pagers, and bound output size.
 * Implemented in Phase 1.
 */
export interface GitCommandRunner {
  run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult>;
}

export interface GitCommandOptions {
  cwd: string;
  /** Extra environment, e.g. `GIT_INDEX_FILE` for a temporary index. */
  env?: Readonly<Record<string, string>>;
  /** Data written to stdin. */
  input?: string | Uint8Array;
  /** Maximum stdout size in bytes before the command is aborted. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RepositoryInfo {
  /** Absolute path of the working tree root. */
  root: string;
  /** Common git directory (shared between worktrees); Git2Jira state lives below it. */
  commonDir: string;
  /** Current branch short name, or `null` when HEAD is detached. */
  branch: string | null;
  /** HEAD commit SHA, or `null` in a repository without commits. */
  headCommit: string | null;
}

export interface GitRepositoryLocator {
  /** Resolves the repository containing `cwd`, or throws when there is none. */
  locate(cwd: string): Promise<RepositoryInfo>;
}

/** A Jira issue key such as `LSND-1234`. */
export const IssueKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,9}-[1-9][0-9]*$/, {
    message: 'Expected a Jira issue key like ABC-123.',
  })
  .brand<'IssueKey'>();

export type IssueKey = z.infer<typeof IssueKeySchema>;

export type IssueKeyDetection =
  | { status: 'found'; issueKey: IssueKey }
  | { status: 'ambiguous'; candidates: IssueKey[] }
  | { status: 'not-found' };

export interface IssueKeyDetectorOptions {
  /** When set, only keys from these projects are accepted. */
  projectKeys?: readonly string[];
}

/** Extracts the issue key from a branch name, e.g. `feature/LSND-1234-user-profile`. Phase 1. */
export interface IssueKeyDetector {
  detect(branch: string, options?: IssueKeyDetectorOptions): IssueKeyDetection;
}
