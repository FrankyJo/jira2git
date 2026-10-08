import { z } from 'zod';
import type { RepositoryInfo } from '../git/types';

export const ObjectIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'Expected a full SHA-1 or SHA-256 object id.');

/**
 * An exact capture of the working tree: committed, staged, unstaged, and
 * untracked non-ignored files, as a Git tree object. It is built in a private
 * temporary index, so the user's index, HEAD, and files are never touched.
 * See docs/git-snapshots.md.
 */
export const SnapshotSchema = z.strictObject({
  /** Tree object of the captured working tree. */
  tree: ObjectIdSchema,
  /** Snapshot commit wrapping `tree` (parent: HEAD at capture time). */
  commit: ObjectIdSchema,
  /** HEAD at capture time; `null` on an unborn branch. */
  headCommit: ObjectIdSchema.nullable(),
  branch: z.string().min(1),
  capturedAt: z.iso.datetime(),
  /** Whether the tree differs from HEAD's tree. */
  includesUncommittedChanges: z.boolean(),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;

export interface CaptureOptions {
  /** Commit message for the snapshot commit. */
  message: string;
  /**
   * Ref to create for the snapshot commit (create-only; fails if it exists).
   * Without a ref the objects are unreferenced and may be garbage-collected,
   * which is acceptable only for read-only analysis.
   */
  ref?: string;
}

export interface SnapshotEngine {
  capture(repository: RepositoryInfo, options: CaptureOptions): Promise<Snapshot>;
}

export type FileChangeStatus =
  'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed';

export type GitObjectKind = 'file' | 'executable' | 'symlink' | 'submodule';

export interface FileChange {
  path: string;
  /** Previous path for renames and copies. */
  previousPath?: string;
  status: FileChangeStatus;
  /** Rename/copy similarity percentage. */
  similarity?: number;
  /** Kind of the new object, or of the old one for deletions. */
  kind: GitObjectKind;
  previousKind?: GitObjectKind;
  /** Mode changed (for example a file became executable). */
  modeChanged: boolean;
  /** Line counts; 0 for binary files and submodules. */
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface CommitSummary {
  sha: string;
  subject: string;
  authoredAt: string;
}

export interface ChangeSet {
  baseTree: string;
  targetTree: string;
  files: FileChange[];
  /** Commits between the baseline commit and HEAD. Context only; may include rewritten history. */
  commits: CommitSummary[];
  commitsTruncated: boolean;
  /** Unified diff limited to `maxPatchBytes`, without excluded paths. Untrusted content. */
  patch: string;
  patchTruncated: boolean;
  /** Patterns whose matches were omitted from `patch` (they still appear in `files`). */
  patchExclusions: readonly string[];
}

export interface DiffOptions {
  maxPatchBytes: number;
  /** Glob patterns (Git pathspec `glob` magic) excluded from the patch. */
  excludeFromPatch: readonly string[];
  maxCommits: number;
}

export interface DiffRequest {
  baseTree: string;
  targetTree: string;
  /** Commit range for context: commits reachable from `toCommit` but not from `fromCommit`. */
  fromCommit: string | null;
  toCommit: string | null;
}

export interface IncrementalDiffEngine {
  diff(
    repository: RepositoryInfo,
    request: DiffRequest,
    options?: Partial<DiffOptions>,
  ): Promise<ChangeSet>;
}

export function isEmptyChangeSet(changeSet: ChangeSet): boolean {
  return changeSet.baseTree === changeSet.targetTree || changeSet.files.length === 0;
}
