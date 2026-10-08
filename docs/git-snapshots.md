# Git snapshots and incremental reports

Status: **implemented in Phase 1.** Code: `src/git`, `src/snapshots`, `src/checkpoints`,
`src/publication/lifecycle.ts`. Tests: `tests/git` (real temporary repositories).

## Goal

Report N+1 must describe exactly what changed after report N was published, regardless of how the
developer got there: new commits, staged or unstaged edits, untracked files, rebases, squashes, resets,
cherry-picks, or force-pushes. If nothing changed, nothing is published.

Commit ranges cannot do this: they break when history is rewritten and miss uncommitted work. Git2Jira
therefore compares **trees**.

```
first report:       MERGE_BASE_TREE          → CURRENT_SNAPSHOT
subsequent reports: LAST_PUBLISHED_SNAPSHOT  → CURRENT_SNAPSHOT
```

## 1. Issue detection

`BranchIssueKeyDetector` (`src/git/issue-key.ts`) finds keys of the form `[A-Z][A-Z0-9_]*-[1-9][0-9]*`
in the branch name. A key must not be glued to a preceding letter, digit, or `_`.

| Branch                      | Result           |
| --------------------------- | ---------------- |
| `feature/LSND-1234-profile` | `LSND-1234`      |
| `hotfix/PROJ-999`           | `PROJ-999`       |
| `feature/LSND-1-and-PROJ-2` | ambiguous: error |
| `feature/lsnd-1234`         | not found: error |

- `--issue LSND-1234` overrides detection. It is validated and never case-corrected.
- `issue.projectKeys` in `.git2jira.json` restricts detection to known projects.
- Detached HEAD is refused even with `--issue`, because history is tracked per branch.
- Repositories in the middle of a merge, rebase, cherry-pick, revert, or bisect are refused.

## 2. First-report baseline

`BaseBranchResolver` (`src/git/base.ts`):

1. `--base <branch>` if given.
2. Otherwise `base.branch` from `.git2jira.json` (`git2jira config set base.branch develop --repo`).
3. Otherwise candidates from Git metadata: the remote's `HEAD`, `init.defaultBranch`, then `main`,
   `master`, `develop`, `development`, `trunk`, both as local and remote-tracking branches. The
   current branch and its upstream are excluded.

An explicit or configured base that does not exist is an error. It never falls back to detection.
A local branch and its remote-tracking branch with the same name count as one candidate; the one
closest to HEAD wins. If candidates with different names lead to **different merge bases**
(for example `develop` and `main` in git-flow), the user must choose. Nothing defaults silently to
`main`.

The baseline tree is the tree of `git merge-base HEAD <base>`. On an unborn branch the baseline is the
empty tree.

## 3. Snapshots

`GitSnapshotEngine` (`src/snapshots/engine.ts`):

```
copy <worktree index> → <common-dir>/git2jira/tmp/index-<pid>-<random>
GIT_INDEX_FILE=<tmp> git add --all -- :/      # staged, unstaged, untracked, deletions
GIT_INDEX_FILE=<tmp> git write-tree            # tree #1
GIT_INDEX_FILE=<tmp> git add --all -- :/
GIT_INDEX_FILE=<tmp> git write-tree            # tree #2
compare tree #1, tree #2, and HEAD before/after → retry (max 3) or stop
git commit-tree --no-gpg-sign [-p HEAD] <tree>  # fixed Git2Jira identity
git update-ref <ref> <commit> 0000…            # create-only
delete temporary index
```

What gets captured:

| Content                                                           | Captured as                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| Committed, staged, unstaged changes                               | the working-tree version of each file                          |
| Untracked, non-ignored files                                      | added files                                                    |
| Deleted and renamed files                                         | deletions; renames detected by the diff                        |
| Executable bit                                                    | mode `100755` (`modeChanged` in the diff)                      |
| Symlinks                                                          | link objects (`kind: "symlink"`)                               |
| Submodules                                                        | the submodule's checked-out commit (`kind: "submodule"`)       |
| Git LFS files                                                     | LFS pointer files (clean filter runs as in a normal `git add`) |
| Binary and large files                                            | blobs; listed as binary, line counts 0                         |
| Ignored files (`.gitignore`, `info/exclude`, `core.excludesFile`) | not captured                                                   |

Guarantees:

- **The user's index is never written.** Git2Jira works on a byte copy, so stat data, intent-to-add
  entries, and sparse-checkout bits are kept. Tests compare the index bytes before and after.
- **The working tree and HEAD are never written.** Tests compare every file's content, mode, and mtime,
  as well as HEAD.
- **Split indexes** cannot be copied safely. The temporary index is rebuilt from HEAD instead (slower
  on very large repositories). A split index combined with sparse checkout is refused.
- **Concurrent edits**: the tree is built twice and HEAD is read before and after. If anything moved,
  the capture is retried. After three unstable attempts it stops with `SnapshotUnstableError` and
  writes nothing.
- **Interruption**: temporary indexes are deleted in `finally`. Files left by a killed process (dead
  PID, or older than an hour) are removed on the next run. Objects written before a crash are
  unreferenced and are eventually pruned by Git's own garbage collection.
- **Process safety**: git runs through `spawn` with argument arrays (`shell: false`).
  `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE` and similar inherited variables are stripped.
  `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, and no pager are set. Diffs use `--no-ext-diff
--no-textconv`. Path lists use NUL-delimited output (`-z`). User-supplied refs are passed after
  `--end-of-options`.

## 4. Change sets

`GitIncrementalDiffEngine` (`src/snapshots/diff.ts`) runs `git diff-tree -r -M` between the baseline
tree and the snapshot tree:

- `--raw -z` and `--numstat -z` give status, rename source and similarity, modes, line counts, and
  binary flags, for every path, including names with spaces, tabs, newlines, and non-ASCII characters.
- The patch is capped (256 KiB by default; `patchTruncated` says so). File statistics are always
  complete.
- Lock files, minified bundles, source maps, and common secret files (`.env*`, `*.pem`, `*.key`,
  `id_rsa*`, `.npmrc`, `.netrc`, …) are listed but **excluded from the patch**, so their content never
  reaches the AI layer.
- Commits between the baseline commit and HEAD (up to 200) are included as context only. After a
  rebase they may include rewritten commits; the tree diff is authoritative.
- Identical trees mean **no changes**: nothing is prepared and the candidate ref is deleted.

## 5. Checkpoints and publication state

A **lineage** is (repository, Jira site, issue key). Each lineage has a journal, a lock, and refs:

```
<git-common-dir>/git2jira/
  repository.json                          random repository id (created once)
  lineages/<siteId>/<ISSUE>.json           append-only journal of report records
  locks/<siteId>-<ISSUE>.lock              cross-process lock (O_EXCL)
  tmp/                                     temporary indexes

refs/git2jira/<siteId>/<ISSUE>/candidates/<reportId>   snapshot awaiting publication
refs/git2jira/<siteId>/<ISSUE>/checkpoints/<NNNNNN>    published checkpoint commit
```

`siteId` is the first 16 hex digits of SHA-256 of the normalized `https://` origin. Refs under
`refs/git2jira/` are shared by all worktrees, are not matched by default push or fetch refspecs, and
keep every relevant object reachable, so `git gc --prune=now` never removes them.

Each report record (`ReportRecordSchema`) stores: schema version, report id, sequence, Jira site
identity, issue key, repository id, branch identity, baseline, snapshot (tree, commit, HEAD), snapshot
ref, publication state, comment id, timestamps, report digest, and, once published, the checkpoint
ref and commit. The checkpoint commit's message carries the same record as JSON, so the journal can be
rebuilt from refs alone.

### State machine (`PublicationLifecycle`)

```
analyze()                      read-only; no refs (used by `git2jira status`)
prepare()  → candidate ref     no journal entry yet; "no-changes" deletes the ref
  cancel()                     deletes the candidate; baseline unchanged
beginPublication(digest)       under lock: journal += { state: publishing }
  ── Jira request (Phase 2) ──
confirmPublication(commentId)  state: confirmed → checkpoint commit + ref → state: published
resolvePending(outcome)        settles a `publishing` record: published, failed (retryable;
                               snapshot kept), or cancelled
recover()                      rebuilds journal from refs, promotes `confirmed`,
                               lists `publishing` records, removes stale candidates
```

- A report counts as done only when it is `published`, which requires a Jira comment id. AI
  generation or preparation alone never advances the baseline.
- While a record is `publishing` or `confirmed`, `prepare` refuses (`PendingPublicationError`). This
  prevents a crash between "comment created" and "checkpoint saved" from causing a duplicate comment.
- `beginPublication` checks under the lock that the baseline it was prepared against is still the
  latest checkpoint (`StaleReportError` otherwise). When several invocations race, exactly one wins.
- Locks held by dead processes (same host) or older than 10 minutes are broken. Busy locks are waited
  on, then reported (`LockBusyError`).

## 6. Special cases

| Situation                                 | Behavior                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| Rebase, squash, amend, force-push         | Tree comparison; only content differences are reported.                                 |
| Cherry-pick                               | The picked change appears once.                                                         |
| Reset / revert of reported work           | Reported as a change (for example a deletion).                                          |
| Revert back to the last reported state    | No changes.                                                                             |
| Branch renamed (`git branch -m`)          | Detected from the reflog; history continues.                                            |
| Same issue on another branch              | `BranchChangedError` unless `--accept-branch-change`.                                   |
| Different issue on another branch         | Separate lineage.                                                                       |
| Same issue key in different repositories  | Separate state (per Git common directory, separate repository id).                      |
| Same issue on different Jira sites        | Separate lineages; without `--site`, ambiguity is an error.                             |
| Missing base branch                       | Error with candidates; `--base` or `base.branch`.                                       |
| Journal missing but checkpoint refs exist | `JournalMissingError`; `recover` rebuilds from refs. **Never a silent full report.**    |
| Corrupted journal                         | `CheckpointCorruptedError`; `recover` quarantines it (`*.corrupt-<time>`) and rebuilds. |
| Checkpoint ref deleted or objects missing | `CheckpointUnavailableError`; no fallback.                                              |
| Journal and refs disagree                 | Treated as corruption.                                                                  |
| Multiple worktrees                        | Shared journal and refs; each worktree's own index is used.                             |
| Concurrent invocations                    | Separate temporary indexes and candidate refs; journal writes under lock.               |
| Interrupted capture or publication        | See sections 3 and 5.                                                                   |

## 7. Known limitations

- **Cross-device history is not supported.** Journals live in the local Git directory and
  `refs/git2jira/*` is not pushed. A fresh clone or another machine starts with no history for the issue;
  continuing from Jira-side metadata is planned for Phase 2 (`recover` + comment footer) but only
  works if the baseline objects exist locally.
- **Uncommitted work is reported.** If you report uncommitted changes and later discard them, the next
  report shows them as removed. There is no committed-only mode yet.
- **Submodules** are reported as pointer changes only; changes inside a dirty submodule are not captured.
- **Git LFS**: only pointer files are compared. Without git-lfs installed, files with LFS attributes are
  captured raw.
- **Large repositories**: the snapshot hashes changed files. Huge untracked files (for example build
  output that is not ignored) are hashed and stored as Git objects; add them to `.gitignore`.
- **Split index**: falls back to rebuilding the temporary index from HEAD, which re-hashes every tracked
  file. Split index plus sparse checkout is refused.
- **Clean/smudge filters** from the user's Git configuration run during capture, as they would for
  `git add`.
- **Unicode normalization**: paths are compared byte-for-byte as Git stores them. On macOS Git's
  `core.precomposeUnicode` default applies.
- **Lock staleness** uses PID checks on the same host. On network file systems shared between hosts,
  a crashed holder's lock is only broken after 10 minutes.
- **Minimum Git version**: 2.31.
- `git2jira recover` (Phase 2) runs this recovery and settles `publishing` records with a Jira lookup;
  see [jira-publication.md](jira-publication.md).
