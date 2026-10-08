# Git snapshots and incremental diffs

Status: design. Implementation is Phase 1. Interfaces: `src/snapshots/types.ts`,
`src/checkpoints/types.ts`, `src/git/types.ts`.

## Problem

Report #2 must describe only what changed after report #1, no matter how the developer got there:
new commits, uncommitted edits, amended or rebased commits, squashes, or force-pushes. Commit ranges
(`last..HEAD`) break as soon as history is rewritten, and they miss uncommitted work.

## Approach: compare trees, not commits

A **snapshot** is a Git tree object that captures the working tree at report time. Reports compare the
snapshot recorded in the last checkpoint with a fresh snapshot. Tree comparison depends only on file
contents, so rewritten history does not matter.

### Capturing a snapshot without touching the developer's state

```
tmp=$(mktemp)                                       # private temporary index
GIT_INDEX_FILE=$tmp git read-tree HEAD              # or --empty for an unborn branch
GIT_INDEX_FILE=$tmp git add --all -- .              # tracked + untracked, .gitignore respected
tree=$(GIT_INDEX_FILE=$tmp git write-tree)
commit=$(git commit-tree $tree [-p HEAD] -m "git2jira snapshot LSND-1234 #3")
git update-ref refs/git2jira/snapshots/LSND-1234/3 $commit
rm $tmp
```

(Shown as shell for readability. The implementation calls `git` through `execFile` with argument arrays.)

- The user's index (`.git/index`), working files, branches, and stash are untouched. The only writes are
  new objects in the object database and a private ref.
- The ref keeps the tree from being garbage-collected. `refs/git2jira/*` is not matched by default push
  refspecs, so snapshots stay local.
- Excluded paths (configurable; for example lock files, build output, `.env*`) are filtered out of the
  diff, not the snapshot, so the stored tree stays an exact capture.

### Computing the change set

```
git diff-tree -r -M --numstat --no-ext-diff --no-textconv <base-tree> <target-tree>
git diff-tree -r -M -p --no-ext-diff --no-textconv <base-tree> <target-tree>   # bounded
git log --format=... <base-commit>..HEAD                                       # context only
```

- **Base** is the last checkpoint's snapshot tree. For the first report it is the tree of the merge
  base between `HEAD` and the base branch (`origin/HEAD`, or the configured base branch).
- Identical trees mean an empty change set: **nothing is published** (FR-2).
- The patch is limited to a byte budget. File-level statistics are always complete, even when the patch
  is truncated, and the report says that the patch was truncated.
- Commit subjects are context for the model only. The authoritative "what changed" is the tree diff.

## Checkpoints

A checkpoint (`CheckpointSchema`) records the issue key, sequence number, snapshot, Jira comment id,
language, and a digest of the published report. Checkpoints are stored under
`<git common dir>/git2jira/checkpoints/<ISSUE>.json`, which is shared by all worktrees and never
committed. A checkpoint is appended only after Jira returns the created comment.

## The example, step by step

| Day | Snapshot | Base                   | Change set          | Result                      |
| --- | -------- | ---------------------- | ------------------- | --------------------------- |
| 1   | S1       | merge-base with `main` | A added, B added    | Comment #1, checkpoint → S1 |
| 6   | S2       | S1                     | B modified, C added | Comment #2, checkpoint → S2 |
| 7   | S3 = S2  | S2                     | empty               | Nothing                     |

## Edge cases

| Case                                      | Behavior                                                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rebase, amend, squash                     | No effect; trees are compared.                                                                                                                                                     |
| Work reverted after a report              | Reported as a modification/removal relative to the last report.                                                                                                                    |
| Uncommitted work reported, then discarded | Shows up as reverted in the next report. (Open question: offer a committed-only mode.)                                                                                             |
| Branch renamed to a different issue       | Different issue key → separate checkpoint history.                                                                                                                                 |
| Detached HEAD                             | Issue key must be given explicitly; no guessing.                                                                                                                                   |
| Another machine / fresh clone             | No local checkpoint → `recover` reads the footer of earlier Git2Jira comments (sequence and tree ids). If the tree is not available locally, the user chooses the base explicitly. |
| Huge diffs, binaries                      | Binaries listed by name only; patch bounded by budget.                                                                                                                             |
| Submodules                                | Reported as pointer changes only.                                                                                                                                                  |

## Safety

- `git` runs via `execFile` with argument arrays, `GIT_TERMINAL_PROMPT=0`, `--no-ext-diff`,
  `--no-textconv`, and no pager. Arguments derived from branch names or paths are passed after `--` where
  Git accepts it.
- Clean/smudge filters configured in the user's own Git configuration may run during `git add`. That is
  the same trust level as the user running `git add` themselves; repository content alone cannot
  configure filters.
