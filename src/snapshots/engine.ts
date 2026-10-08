import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { OperationInProgressError } from '../git/errors';
import { operationInProgress } from '../git/repository';
import { gitOptional, gitOutput } from '../git/runner';
import type { GitCommandRunner, RepositoryInfo } from '../git/types';
import { SnapshotCaptureError, SnapshotUnstableError } from './errors';
import type { CaptureOptions, Snapshot, SnapshotEngine } from './types';

/** Identity for snapshot commits, so capture works without user.name/user.email. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Git2Jira',
  GIT_AUTHOR_EMAIL: 'git2jira@localhost',
  GIT_COMMITTER_NAME: 'Git2Jira',
  GIT_COMMITTER_EMAIL: 'git2jira@localhost',
};

const MAX_ATTEMPTS = 3;
const STALE_TEMP_MS = 60 * 60 * 1000;

export function stateDir(repository: RepositoryInfo): string {
  return path.join(repository.commonDir, 'git2jira');
}

export function zeroOid(repository: RepositoryInfo): string {
  return '0'.repeat(repository.objectFormat === 'sha256' ? 64 : 40);
}

/**
 * Captures the working tree into Git objects using a private copy of the
 * index. The real index, HEAD, refs (other than the requested snapshot ref),
 * and working files are never written.
 */
export class GitSnapshotEngine implements SnapshotEngine {
  constructor(
    private readonly git: GitCommandRunner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async capture(repository: RepositoryInfo, options: CaptureOptions): Promise<Snapshot> {
    if (repository.branch === null) throw new SnapshotCaptureError('HEAD is detached.');
    const operation = operationInProgress(repository);
    if (operation) throw new OperationInProgressError(operation);

    const tempDir = path.join(stateDir(repository), 'tmp');
    await mkdir(tempDir, { recursive: true });
    await removeStaleTempFiles(tempDir);
    const tempIndex = path.join(
      tempDir,
      `index-${String(process.pid)}-${randomBytes(6).toString('hex')}`,
    );

    try {
      const { tree, head } = await this.captureStableTree(repository, tempIndex);
      const capturedAt = this.now().toISOString();
      const commit = (
        await gitOutput(
          this.git,
          [
            'commit-tree',
            '--no-gpg-sign',
            ...(head ? ['-p', head] : []),
            '-m',
            options.message,
            tree,
          ],
          {
            cwd: repository.root,
            env: {
              ...SNAPSHOT_IDENTITY,
              GIT_AUTHOR_DATE: capturedAt,
              GIT_COMMITTER_DATE: capturedAt,
            },
          },
        )
      ).trim();

      if (options.ref !== undefined) {
        // Create-only: the old-value of all zeros makes update-ref fail if the ref exists.
        await gitOutput(
          this.git,
          ['update-ref', '-m', 'git2jira: snapshot', options.ref, commit, zeroOid(repository)],
          { cwd: repository.root },
        );
      }

      const headTree = head
        ? await this.treeOf(repository, head)
        : await emptyTree(this.git, repository);
      return {
        tree,
        commit,
        headCommit: head,
        branch: repository.branch,
        capturedAt,
        includesUncommittedChanges: tree !== headTree,
      };
    } finally {
      await rm(tempIndex, { force: true });
      await rm(`${tempIndex}.lock`, { force: true });
    }
  }

  /**
   * Builds the tree twice and also checks HEAD. If anything moved while we
   * were reading the working tree, try again; give up after MAX_ATTEMPTS.
   */
  private async captureStableTree(
    repository: RepositoryInfo,
    tempIndex: string,
  ): Promise<{ tree: string; head: string | null }> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const headBefore = await this.head(repository);
      await this.prepareIndex(repository, tempIndex, headBefore);
      const first = await this.addAllAndWriteTree(repository, tempIndex);
      const second = await this.addAllAndWriteTree(repository, tempIndex);
      const headAfter = await this.head(repository);
      if (first === second && headBefore === headAfter) return { tree: second, head: headAfter };
    }
    throw new SnapshotUnstableError(MAX_ATTEMPTS);
  }

  /**
   * Starts from a byte copy of the user's index: it keeps stat data (so only
   * changed files are re-hashed) and sparse-checkout/skip-worktree bits.
   * A split index cannot be copied safely, so it is rebuilt from HEAD instead.
   */
  private async prepareIndex(
    repository: RepositoryInfo,
    tempIndex: string,
    head: string | null,
  ): Promise<void> {
    await rm(tempIndex, { force: true });
    const env = { GIT_INDEX_FILE: tempIndex };
    const sharedIndex = await gitOptional(this.git, ['rev-parse', '--shared-index-path'], {
      cwd: repository.root,
    });
    if (!sharedIndex && (await fileExists(repository.indexPath))) {
      await copyFile(repository.indexPath, tempIndex);
      return;
    }
    const sparse = await gitOptional(
      this.git,
      ['config', '--type=bool', '--get', 'core.sparseCheckout'],
      {
        cwd: repository.root,
      },
    );
    if (sparse === 'true') {
      throw new SnapshotCaptureError('sparse checkout with a split index is not supported.');
    }
    await gitOutput(this.git, head ? ['read-tree', head] : ['read-tree', '--empty'], {
      cwd: repository.root,
      env,
    });
  }

  private async addAllAndWriteTree(repository: RepositoryInfo, tempIndex: string): Promise<string> {
    const env = { GIT_INDEX_FILE: tempIndex };
    // `add --all` stages new, modified, and deleted files and honours .gitignore.
    const add = await this.git.run(['add', '--all', '--', ':/'], { cwd: repository.root, env });
    if (add.exitCode !== 0) {
      throw new SnapshotCaptureError(
        add.stderr.trim() || `git add exited with ${String(add.exitCode)}`,
      );
    }
    return (await gitOutput(this.git, ['write-tree'], { cwd: repository.root, env })).trim();
  }

  private async head(repository: RepositoryInfo): Promise<string | null> {
    return (
      (await gitOptional(this.git, ['rev-parse', '--quiet', '--verify', 'HEAD^{commit}'], {
        cwd: repository.root,
      })) ?? null
    );
  }

  private async treeOf(repository: RepositoryInfo, commit: string): Promise<string> {
    return (
      await gitOutput(this.git, ['rev-parse', `${commit}^{tree}`], { cwd: repository.root })
    ).trim();
  }
}

/** Writes (if needed) and returns the empty tree for the repository's object format. */
export async function emptyTree(
  git: GitCommandRunner,
  repository: RepositoryInfo,
): Promise<string> {
  return (await gitOutput(git, ['mktree'], { cwd: repository.root, input: '' })).trim();
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Removes temporary indexes left by crashed or killed runs. */
async function removeStaleTempFiles(tempDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(tempDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    const match = /^index-(\d+)-/.exec(entry);
    const file = path.join(tempDir, entry);
    const pid = match ? Number(match[1]) : undefined;
    let stale = pid === undefined || !processAlive(pid);
    if (!stale) {
      try {
        stale = now - (await stat(file)).mtimeMs > STALE_TEMP_MS;
      } catch {
        continue;
      }
    }
    if (stale && pid !== process.pid) await rm(file, { force: true });
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
