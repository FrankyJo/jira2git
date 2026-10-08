import { BaseBranchNotFoundError, BaseBranchUndeterminedError, NoMergeBaseError } from './errors';
import { gitOptional, gitOutput, splitNul } from './runner';
import type { GitCommandRunner, RepositoryInfo } from './types';

export type BaseSource = 'option' | 'repository configuration' | 'detected';

export interface ResolvedBase {
  /** Full ref name, e.g. `refs/remotes/origin/main`. */
  ref: string;
  /** Short display name, e.g. `origin/main`. */
  name: string;
  commit: string;
  /** Merge base of HEAD and `commit`; the first report's baseline. */
  mergeBase: string;
  source: BaseSource;
}

export interface BaseResolutionInput {
  /** `--base` value. */
  explicit?: string | undefined;
  /** `base.branch` from repository configuration. */
  configured?: string | undefined;
}

/** Conventional integration branch names, in order of preference. */
const CONVENTIONAL_NAMES = ['main', 'master', 'develop', 'development', 'trunk'];

interface Candidate {
  ref: string;
  name: string;
  logicalName: string;
  commit: string;
  mergeBase: string;
  aheadBy: number;
}

/**
 * Resolves the branch the current work is based on, for the first report of
 * an issue. Explicit choices are verified and never replaced by a guess. When
 * detecting, candidates are taken from Git metadata (remote HEAD,
 * `init.defaultBranch`, conventional names); if they disagree about the merge
 * base, the user must choose.
 */
export class BaseBranchResolver {
  constructor(private readonly git: GitCommandRunner) {}

  async resolve(repository: RepositoryInfo, input: BaseResolutionInput): Promise<ResolvedBase> {
    if (repository.headCommit === null) {
      throw new NoMergeBaseError('any branch (the current branch has no commits yet)');
    }
    if (input.explicit !== undefined)
      return this.resolveNamed(repository, input.explicit, 'option');
    if (input.configured !== undefined) {
      return this.resolveNamed(repository, input.configured, 'repository configuration');
    }
    return this.detect(repository);
  }

  private async resolveNamed(
    repository: RepositoryInfo,
    name: string,
    source: 'option' | 'repository configuration',
  ): Promise<ResolvedBase> {
    const cwd = repository.root;
    const fullRef = await gitOptional(
      this.git,
      ['rev-parse', '--symbolic-full-name', '--end-of-options', name],
      { cwd },
      [1, 128],
    );
    const commit = await gitOptional(
      this.git,
      ['rev-parse', '--quiet', '--verify', '--end-of-options', `${name}^{commit}`],
      { cwd },
      [1, 128],
    );
    if (!commit) throw new BaseBranchNotFoundError(name, source);
    const mergeBase = await this.mergeBase(repository, commit);
    if (!mergeBase) throw new NoMergeBaseError(name);
    // `--symbolic-full-name` prints an empty line for a raw commit id.
    const ref = fullRef === undefined || fullRef === '' ? name : fullRef;
    return { ref, name, commit, mergeBase, source };
  }

  private async detect(repository: RepositoryInfo): Promise<ResolvedBase> {
    const cwd = repository.root;
    const refs = await this.listRefs(repository);
    const upstreamRemote = repository.branch
      ? await gitOptional(this.git, ['config', '--get', `branch.${repository.branch}.remote`], {
          cwd,
        })
      : undefined;
    // A branch whose upstream is local ('.') has no remote to look at.
    const remote = upstreamRemote && upstreamRemote !== '.' ? upstreamRemote : 'origin';

    const names: string[] = [];
    const remoteHead = await gitOptional(
      this.git,
      ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`],
      { cwd },
      [1, 128],
    );
    if (remoteHead?.startsWith(`refs/remotes/${remote}/`)) {
      names.push(remoteHead.slice(`refs/remotes/${remote}/`.length));
    }
    const defaultBranch = await gitOptional(this.git, ['config', '--get', 'init.defaultBranch'], {
      cwd,
    });
    if (defaultBranch) names.push(defaultBranch);
    names.push(...CONVENTIONAL_NAMES);

    const excluded = new Set<string>();
    if (repository.branch) {
      excluded.add(`refs/heads/${repository.branch}`);
      const upstream = await gitOptional(
        this.git,
        [
          'rev-parse',
          '--symbolic-full-name',
          '--end-of-options',
          `${repository.branch}@{upstream}`,
        ],
        { cwd },
        [1, 128],
      );
      if (upstream) excluded.add(upstream);
    }

    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const logicalName of names) {
      for (const ref of [`refs/remotes/${remote}/${logicalName}`, `refs/heads/${logicalName}`]) {
        const commit = refs.get(ref);
        if (!commit || excluded.has(ref) || seen.has(ref)) continue;
        seen.add(ref);
        const mergeBase = await this.mergeBase(repository, commit);
        if (!mergeBase) continue;
        const aheadBy = Number(
          await gitOutput(this.git, ['rev-list', '--count', `${mergeBase}..HEAD`], { cwd }),
        );
        candidates.push({ ref, name: shortName(ref), logicalName, commit, mergeBase, aheadBy });
      }
    }

    if (candidates.length === 0) throw new BaseBranchUndeterminedError([], 'missing');

    // A local branch and its remote-tracking counterpart are the same logical
    // base; keep the one closest to HEAD (the other is merely out of date).
    const byLogicalName = new Map<string, Candidate>();
    for (const candidate of candidates) {
      const current = byLogicalName.get(candidate.logicalName);
      if (!current || candidate.aheadBy < current.aheadBy)
        byLogicalName.set(candidate.logicalName, candidate);
    }
    const distinct = [...byLogicalName.values()];
    const mergeBases = new Set(distinct.map((c) => c.mergeBase));
    if (mergeBases.size > 1) {
      throw new BaseBranchUndeterminedError(
        distinct
          .sort((a, b) => a.aheadBy - b.aheadBy)
          .map((c) => ({ ref: c.name, aheadBy: c.aheadBy })),
        'ambiguous',
      );
    }
    const [chosen] = distinct;
    if (!chosen) throw new BaseBranchUndeterminedError([], 'missing');
    return {
      ref: chosen.ref,
      name: chosen.name,
      commit: chosen.commit,
      mergeBase: chosen.mergeBase,
      source: 'detected',
    };
  }

  private async listRefs(repository: RepositoryInfo): Promise<Map<string, string>> {
    const output = await gitOutput(
      this.git,
      ['for-each-ref', '--format=%(refname)%00%(objectname)%00', 'refs/heads', 'refs/remotes'],
      { cwd: repository.root },
    );
    const parts = splitNul(output.replaceAll('\n', ''));
    const refs = new Map<string, string>();
    for (let i = 0; i + 1 < parts.length; i += 2) refs.set(parts[i] ?? '', parts[i + 1] ?? '');
    return refs;
  }

  private async mergeBase(repository: RepositoryInfo, commit: string): Promise<string | undefined> {
    return gitOptional(this.git, ['merge-base', 'HEAD', commit], { cwd: repository.root });
  }
}

function shortName(ref: string): string {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('refs/remotes/')) return ref.slice('refs/remotes/'.length);
  return ref;
}
