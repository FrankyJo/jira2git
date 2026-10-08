import { z } from 'zod';
import type { IssueKey, RepositoryInfo } from '../git/types';

const Sha = z
  .string()
  .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'Expected a full SHA-1 or SHA-256 object id.');

/**
 * An immutable capture of the working tree at report time, including
 * uncommitted and untracked (non-ignored) files. It is written as a Git tree
 * object through a temporary index, so the developer's index and working
 * files are never touched. See docs/git-snapshots.md. Implemented in Phase 1.
 */
export const SnapshotSchema = z.strictObject({
  /** Tree object id representing the captured working tree. */
  tree: Sha,
  /** Commit object id recorded under `ref` so the tree survives garbage collection. */
  commit: Sha,
  /** HEAD at capture time; `null` for an unborn branch. */
  headCommit: Sha.nullable(),
  branch: z.string().min(1),
  /** Private ref holding the snapshot commit, e.g. `refs/git2jira/snapshots/LSND-1234/3`. */
  ref: z.string().startsWith('refs/git2jira/'),
  capturedAt: z.iso.datetime(),
  includesUncommittedChanges: z.boolean(),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;

export interface SnapshotEngine {
  capture(repository: RepositoryInfo, issueKey: IssueKey): Promise<Snapshot>;
  /** Removes snapshot refs that are no longer referenced by any checkpoint. */
  prune(repository: RepositoryInfo, issueKey: IssueKey, keep: readonly Snapshot[]): Promise<void>;
}

export type FileChangeStatus =
  'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed';

export interface FileChange {
  path: string;
  /** Previous path for renames and copies. */
  previousPath?: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface CommitSummary {
  sha: string;
  subject: string;
  authoredAt: string;
}

/** Changes between the previous checkpoint and the current snapshot. */
export interface ChangeSet {
  /** `null` base means this is the first report for the issue. */
  base: { tree: string; label: 'checkpoint' | 'merge-base' } | null;
  target: Snapshot;
  files: FileChange[];
  commits: CommitSummary[];
  /** Unified diff, truncated to the configured budget. Untrusted content. */
  patch: string;
  patchTruncated: boolean;
}

export interface DiffEngineOptions {
  /** Upper bound on the patch text handed to the AI layer. */
  maxPatchBytes: number;
  /** Path globs excluded from analysis (lock files, generated code, secrets). */
  excludePaths: readonly string[];
}

export interface IncrementalDiffEngine {
  /** `base` is the snapshot from the last published checkpoint, if any. */
  diff(
    repository: RepositoryInfo,
    base: Snapshot | undefined,
    target: Snapshot,
    options: DiffEngineOptions,
  ): Promise<ChangeSet>;
}

export function isEmptyChangeSet(changeSet: ChangeSet): boolean {
  return changeSet.files.length === 0;
}
