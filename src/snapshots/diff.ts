import { gitOutput, splitNul } from '../git/runner';
import type { GitCommandRunner, RepositoryInfo } from '../git/types';
import type {
  ChangeSet,
  CommitSummary,
  DiffOptions,
  DiffRequest,
  FileChange,
  FileChangeStatus,
  GitObjectKind,
  IncrementalDiffEngine,
} from './types';

/**
 * Paths whose content is omitted from the patch handed to the AI layer: lock
 * files and generated output (noise), and common secret files (they must never
 * leave the machine even if someone committed them). They still appear in the
 * file list with statistics.
 */
export const DEFAULT_PATCH_EXCLUSIONS: readonly string[] = [
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
  '**/bun.lockb',
  '**/composer.lock',
  '**/Gemfile.lock',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/go.sum',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.npmrc',
  '**/.netrc',
];

export const DEFAULT_DIFF_OPTIONS: DiffOptions = {
  maxPatchBytes: 256 * 1024,
  excludeFromPatch: DEFAULT_PATCH_EXCLUSIONS,
  maxCommits: 200,
};

/** Common flags: whole tree, rename detection, no external programs, no colour. */
const DIFF_FLAGS = [
  '-r',
  '-M',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--ignore-submodules=none',
];

export class GitIncrementalDiffEngine implements IncrementalDiffEngine {
  constructor(private readonly git: GitCommandRunner) {}

  async diff(
    repository: RepositoryInfo,
    request: DiffRequest,
    overrides: Partial<DiffOptions> = {},
  ): Promise<ChangeSet> {
    const options = { ...DEFAULT_DIFF_OPTIONS, ...overrides };
    const commits = await this.commits(repository, request, options.maxCommits);

    if (request.baseTree === request.targetTree) {
      return {
        baseTree: request.baseTree,
        targetTree: request.targetTree,
        files: [],
        ...commits,
        patch: '',
        patchTruncated: false,
        patchExclusions: options.excludeFromPatch,
      };
    }

    const cwd = repository.root;
    const trees = [request.baseTree, request.targetTree];
    const [raw, numstat] = await Promise.all([
      gitOutput(this.git, ['diff-tree', ...DIFF_FLAGS, '-z', '--raw', ...trees], { cwd }),
      gitOutput(this.git, ['diff-tree', ...DIFF_FLAGS, '-z', '--numstat', ...trees], { cwd }),
    ]);
    const files = mergeStats(parseRaw(raw), parseNumstat(numstat));

    const pathspec = options.excludeFromPatch.map((pattern) => `:(exclude,glob)${pattern}`);
    const patch = await this.git.run(
      [
        'diff-tree',
        ...DIFF_FLAGS,
        '-p',
        '--full-index',
        ...trees,
        '--',
        ...(pathspec.length ? pathspec : []),
      ],
      { cwd, maxOutputBytes: options.maxPatchBytes, truncateOutput: true },
    );
    if (patch.exitCode !== 0) {
      throw new Error(`git diff-tree failed: ${patch.stderr.trim()}`);
    }

    return {
      baseTree: request.baseTree,
      targetTree: request.targetTree,
      files,
      ...commits,
      patch: patch.stdout,
      patchTruncated: patch.truncated,
      patchExclusions: options.excludeFromPatch,
    };
  }

  private async commits(
    repository: RepositoryInfo,
    request: DiffRequest,
    maxCommits: number,
  ): Promise<{ commits: CommitSummary[]; commitsTruncated: boolean }> {
    if (request.toCommit === null) return { commits: [], commitsTruncated: false };
    const range = request.fromCommit
      ? [`^${request.fromCommit}`, request.toCommit]
      : [request.toCommit];
    const output = await gitOutput(
      this.git,
      [
        'log',
        '-z',
        `--max-count=${String(maxCommits + 1)}`,
        '--format=%H%x1f%s%x1f%aI',
        ...range,
        '--',
      ],
      { cwd: repository.root },
    );
    const commits = splitNul(output).map((record) => {
      const [sha = '', subject = '', authoredAt = ''] = record.replace(/^\n/, '').split('\x1f');
      return { sha, subject, authoredAt };
    });
    return { commits: commits.slice(0, maxCommits), commitsTruncated: commits.length > maxCommits };
  }
}

interface RawEntry {
  status: FileChangeStatus;
  similarity?: number;
  path: string;
  previousPath?: string;
  oldMode: string;
  newMode: string;
}

const STATUS: Record<string, FileChangeStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
};

/** Parses `diff-tree --raw -z`: `:old new oldSha newSha STATUS\0path\0[path2\0]`. */
export function parseRaw(output: string): RawEntry[] {
  const parts = splitNul(output);
  const entries: RawEntry[] = [];
  for (let i = 0; i < parts.length;) {
    const header = parts[i++] ?? '';
    const [oldMode = '', newMode = '', , , statusField = ''] = header.replace(/^:/, '').split(' ');
    const letter = statusField.charAt(0);
    const status = STATUS[letter];
    if (!status) throw new Error(`Unexpected diff status "${statusField}"`);
    const score = statusField.slice(1);
    if (letter === 'R' || letter === 'C') {
      const previousPath = parts[i++] ?? '';
      const path = parts[i++] ?? '';
      entries.push({ status, similarity: Number(score), path, previousPath, oldMode, newMode });
    } else {
      entries.push({ status, path: parts[i++] ?? '', oldMode, newMode });
    }
  }
  return entries;
}

/** Parses `diff-tree --numstat -z`; renames use an empty path followed by `old\0new\0`. */
export function parseNumstat(
  output: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const parts = splitNul(output);
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let i = 0; i < parts.length;) {
    const [added = '', deleted = '', inlinePath = ''] = (parts[i++] ?? '').split('\t');
    let path = inlinePath;
    if (inlinePath === '') {
      i++; // previous path
      path = parts[i++] ?? '';
    }
    const binary = added === '-' && deleted === '-';
    stats.set(path, {
      additions: binary ? 0 : Number(added),
      deletions: binary ? 0 : Number(deleted),
      binary,
    });
  }
  return stats;
}

function mergeStats(
  entries: RawEntry[],
  stats: Map<string, { additions: number; deletions: number; binary: boolean }>,
): FileChange[] {
  return entries.map((entry) => {
    const stat = stats.get(entry.path) ?? { additions: 0, deletions: 0, binary: false };
    const deleted = entry.status === 'deleted';
    const kind = kindOf(deleted ? entry.oldMode : entry.newMode);
    const previousKind = entry.status === 'added' ? undefined : kindOf(entry.oldMode);
    const change: FileChange = {
      path: entry.path,
      status: entry.status,
      kind,
      modeChanged: entry.status !== 'added' && !deleted && entry.oldMode !== entry.newMode,
      additions: stat.additions,
      deletions: stat.deletions,
      binary: stat.binary,
    };
    if (entry.previousPath !== undefined) change.previousPath = entry.previousPath;
    if (entry.similarity !== undefined) change.similarity = entry.similarity;
    if (previousKind !== undefined && previousKind !== kind) change.previousKind = previousKind;
    return change;
  });
}

function kindOf(mode: string): GitObjectKind {
  switch (mode) {
    case '100755':
      return 'executable';
    case '120000':
      return 'symlink';
    case '160000':
      return 'submodule';
    default:
      return 'file';
  }
}
