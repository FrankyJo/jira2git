import { z } from 'zod';

/**
 * Runs the system `git` binary. Implementations MUST use spawn/execFile with
 * an argument array (never a shell), set `GIT_TERMINAL_PROMPT=0`, disable
 * pagers and external diff drivers, and bound output size.
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
  /** Maximum stdout size in bytes. */
  maxOutputBytes?: number;
  /** Truncate at `maxOutputBytes` instead of failing. */
  truncateOutput?: boolean;
  signal?: AbortSignal;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when output was cut at `maxOutputBytes` (only with `truncateOutput`). */
  truncated: boolean;
}

export interface RepositoryInfo {
  /** Absolute path of the working tree root. */
  root: string;
  /** Per-worktree git directory (`.git`, or `.git/worktrees/<name>` for linked worktrees). */
  gitDir: string;
  /** Common git directory shared by all worktrees; Git2Jira state lives below it. */
  commonDir: string;
  /** Absolute path of this worktree's index file. */
  indexPath: string;
  objectFormat: 'sha1' | 'sha256';
  /** Current branch short name, or `null` when HEAD is detached. */
  branch: string | null;
  /** HEAD commit, or `null` on an unborn branch. */
  headCommit: string | null;
}

export interface GitRepositoryLocator {
  /** Resolves the repository containing `cwd`, or throws when there is none. */
  locate(cwd: string): Promise<RepositoryInfo>;
}

/**
 * A Jira issue key such as `LSND-1234`: project key (uppercase letter, then
 * uppercase letters, digits, or `_`), a dash, and a positive issue number.
 */
export const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;

export const IssueKeySchema = z
  .string()
  .regex(ISSUE_KEY_PATTERN, { message: 'Expected a Jira issue key like ABC-123.' })
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

/** Extracts the issue key from a branch name, e.g. `feature/LSND-1234-user-profile`. */
export interface IssueKeyDetector {
  detect(branch: string, options?: IssueKeyDetectorOptions): IssueKeyDetection;
}
