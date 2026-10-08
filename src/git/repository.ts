import { existsSync } from 'node:fs';
import path from 'node:path';
import { BareRepositoryError, GitVersionError, NotARepositoryError } from './errors';
import { gitOptional, gitOutput } from './runner';
import type { GitCommandRunner, GitRepositoryLocator, RepositoryInfo } from './types';

/** `rev-parse --path-format=absolute` needs 2.31; `--end-of-options` needs 2.24. */
export const MINIMUM_GIT_VERSION = [2, 31, 0] as const;

export class GitRepositoryLocatorImpl implements GitRepositoryLocator {
  private versionChecked = false;

  constructor(private readonly git: GitCommandRunner) {}

  async locate(cwd: string): Promise<RepositoryInfo> {
    await this.checkVersion(cwd);

    const probe = await this.git.run(
      ['rev-parse', '--is-bare-repository', '--is-inside-work-tree'],
      { cwd },
    );
    if (probe.exitCode !== 0) throw new NotARepositoryError(cwd);
    const [isBare, insideWorkTree] = probe.stdout.trim().split('\n');
    if (isBare === 'true') throw new BareRepositoryError(cwd);
    if (insideWorkTree !== 'true') throw new NotARepositoryError(cwd);

    const lines = (
      await gitOutput(
        this.git,
        [
          'rev-parse',
          '--path-format=absolute',
          '--show-toplevel',
          '--git-dir',
          '--git-common-dir',
          '--git-path',
          'index',
          '--show-object-format',
        ],
        { cwd },
      )
    )
      .trim()
      .split('\n');
    const [root, gitDir, commonDir, indexPath, objectFormat] = lines;
    if (!root || !gitDir || !commonDir || !indexPath || !objectFormat) {
      throw new NotARepositoryError(cwd);
    }

    const branch = await gitOptional(this.git, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: root,
    });
    const headCommit = await gitOptional(
      this.git,
      ['rev-parse', '--quiet', '--verify', 'HEAD^{commit}'],
      { cwd: root },
    );

    return {
      root: path.resolve(root),
      gitDir: path.resolve(gitDir),
      commonDir: path.resolve(commonDir),
      indexPath: path.resolve(indexPath),
      objectFormat: objectFormat === 'sha256' ? 'sha256' : 'sha1',
      branch: branch ?? null,
      headCommit: headCommit ?? null,
    };
  }

  private async checkVersion(cwd: string): Promise<void> {
    if (this.versionChecked) return;
    const output = await gitOutput(this.git, ['version'], { cwd });
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
    const found = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
    if (compareVersions(found, MINIMUM_GIT_VERSION) < 0) {
      throw new GitVersionError(found.join('.'), MINIMUM_GIT_VERSION.join('.'));
    }
    this.versionChecked = true;
  }
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Operations that leave the worktree in an intermediate state that must not be reported. */
export function operationInProgress(repository: RepositoryInfo): string | undefined {
  const markers: [string, string][] = [
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase or am'],
    ['BISECT_LOG', 'bisect'],
  ];
  for (const [marker, operation] of markers) {
    if (existsSync(path.join(repository.gitDir, marker))) return operation;
  }
  return undefined;
}
