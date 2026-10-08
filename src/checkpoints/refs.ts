import type { IssueKey, RepositoryInfo } from '../git/types';
import { gitOptional, gitOutput, splitNul } from '../git/runner';
import type { GitCommandRunner } from '../git/types';
import { zeroOid } from '../snapshots/engine';

/**
 * Ref namespace (shared by all worktrees, not matched by default push or fetch refspecs):
 *
 *   refs/git2jira/<siteId>/<ISSUE>/candidates/<reportId>   snapshot awaiting publication
 *   refs/git2jira/<siteId>/<ISSUE>/checkpoints/<NNNNNN>    published checkpoint commits
 *
 * Every snapshot that can still become or already is a baseline is reachable
 * from one of these refs, so `git gc` never prunes it.
 */
export function lineageRefPrefix(siteId: string, issueKey: IssueKey): string {
  return `refs/git2jira/${siteId}/${issueKey}`;
}

export function candidateRef(siteId: string, issueKey: IssueKey, reportId: string): string {
  return `${lineageRefPrefix(siteId, issueKey)}/candidates/${reportId}`;
}

export function checkpointRef(siteId: string, issueKey: IssueKey, sequence: number): string {
  return `${lineageRefPrefix(siteId, issueKey)}/checkpoints/${String(sequence).padStart(6, '0')}`;
}

export interface RefEntry {
  ref: string;
  oid: string;
  committerDate: number;
}

export class GitRefs {
  constructor(private readonly git: GitCommandRunner) {}

  async list(repository: RepositoryInfo, prefix: string): Promise<RefEntry[]> {
    const output = await gitOutput(
      this.git,
      ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00', prefix],
      { cwd: repository.root },
    );
    const parts = splitNul(output.replaceAll('\n', ''));
    const entries: RefEntry[] = [];
    for (let i = 0; i + 2 < parts.length; i += 3) {
      entries.push({
        ref: parts[i] ?? '',
        oid: parts[i + 1] ?? '',
        committerDate: Number(parts[i + 2]),
      });
    }
    return entries;
  }

  /** Lists `refs/git2jira/<siteId>/<issue>/...` site ids for an issue. */
  async sitesWithRefs(repository: RepositoryInfo, issueKey: IssueKey): Promise<string[]> {
    const entries = await this.list(repository, 'refs/git2jira/');
    const sites = new Set<string>();
    for (const { ref } of entries) {
      const [, , site, issue] = ref.split('/');
      if (site && issue === issueKey) sites.add(site);
    }
    return [...sites];
  }

  async resolve(repository: RepositoryInfo, ref: string): Promise<string | undefined> {
    return gitOptional(this.git, ['rev-parse', '--quiet', '--verify', `${ref}^{commit}`], {
      cwd: repository.root,
    });
  }

  async objectExists(
    repository: RepositoryInfo,
    oid: string,
    type: 'tree' | 'commit',
  ): Promise<boolean> {
    const result = await this.git.run(['cat-file', '-e', `${oid}^{${type}}`], {
      cwd: repository.root,
    });
    return result.exitCode === 0;
  }

  /** Creates `ref` only if it does not exist yet. */
  async create(
    repository: RepositoryInfo,
    ref: string,
    oid: string,
    reason: string,
  ): Promise<void> {
    await gitOutput(this.git, ['update-ref', '-m', reason, ref, oid, zeroOid(repository)], {
      cwd: repository.root,
    });
  }

  /** Deletes `ref` if it still points at `expected` (or unconditionally when omitted). */
  async delete(repository: RepositoryInfo, ref: string, expected?: string): Promise<void> {
    await gitOutput(this.git, ['update-ref', '-d', ref, ...(expected ? [expected] : [])], {
      cwd: repository.root,
    });
  }

  async commitMessage(repository: RepositoryInfo, commit: string): Promise<string> {
    return gitOutput(this.git, ['show', '-s', '--format=%B', commit, '--'], {
      cwd: repository.root,
    });
  }

  async treeOf(repository: RepositoryInfo, commit: string): Promise<string> {
    return (
      await gitOutput(this.git, ['rev-parse', `${commit}^{tree}`], { cwd: repository.root })
    ).trim();
  }

  /** Writes a commit for `tree` with `parent`, using a fixed identity and timestamp. */
  async commitTree(
    repository: RepositoryInfo,
    tree: string,
    parent: string,
    message: string,
    date: string,
  ): Promise<string> {
    return (
      await gitOutput(this.git, ['commit-tree', '--no-gpg-sign', '-p', parent, '-F', '-', tree], {
        cwd: repository.root,
        input: message,
        env: {
          GIT_AUTHOR_NAME: 'Git2Jira',
          GIT_AUTHOR_EMAIL: 'git2jira@localhost',
          GIT_COMMITTER_NAME: 'Git2Jira',
          GIT_COMMITTER_EMAIL: 'git2jira@localhost',
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      })
    ).trim();
  }

  /** Reflog subjects of a branch, newest first (used to recognise renames). */
  async reflogSubjects(repository: RepositoryInfo, branch: string): Promise<string[]> {
    const result = await this.git.run(
      ['reflog', 'show', '--format=%gs', '--end-of-options', `refs/heads/${branch}`, '--'],
      { cwd: repository.root },
    );
    return result.exitCode === 0 ? result.stdout.split('\n').filter(Boolean) : [];
  }
}
