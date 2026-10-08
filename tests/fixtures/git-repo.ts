import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitRefs } from '../../src/checkpoints/refs';
import { jiraSiteFromUrl } from '../../src/checkpoints/site';
import { LineageStore } from '../../src/checkpoints/store';
import type { Checkpoint, JiraSite } from '../../src/checkpoints/types';
import { BaseBranchResolver } from '../../src/git/base';
import { BranchIssueKeyDetector } from '../../src/git/issue-key';
import { GitRepositoryLocatorImpl } from '../../src/git/repository';
import { SpawnGitRunner } from '../../src/git/runner';
import type { GitCommandRunner } from '../../src/git/types';
import {
  PublicationLifecycle,
  type AnalysisRequest,
  type LifecycleDependencies,
  type PreparedReport,
} from '../../src/publication/lifecycle';
import { GitIncrementalDiffEngine } from '../../src/snapshots/diff';
import { GitSnapshotEngine } from '../../src/snapshots/engine';

export const SITE: JiraSite = jiraSiteFromUrl('https://example.atlassian.net');
export const DIGEST = 'a'.repeat(64);

/** Environment isolated from the developer's own Git configuration. */
export async function isolatedGitEnv(dir: string): Promise<Record<string, string>> {
  const globalConfig = path.join(dir, 'gitconfig');
  await writeFile(
    globalConfig,
    '[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n',
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    HOME: dir,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

export interface UserState {
  index: string | null;
  head: string;
  headCommit: string;
  files: Record<string, string>;
}

let tick = 0;

export class GitRepo {
  private constructor(
    readonly root: string,
    readonly env: Record<string, string>,
    readonly sandbox: string,
  ) {}

  static async create(
    options: { branch?: string; initialCommit?: boolean } = {},
  ): Promise<GitRepo> {
    const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), 'git2jira-git-')));
    const env = await isolatedGitEnv(sandbox);
    const root = path.join(sandbox, 'repo');
    await mkdir(root);
    const repo = new GitRepo(root, env, sandbox);
    repo.git('init', '-q', '-b', 'main');
    if (options.initialCommit !== false) {
      await repo.write('README.md', '# Project\n');
      repo.commitAll('initial commit');
    }
    if (options.branch) repo.git('switch', '-q', '-c', options.branch);
    return repo;
  }

  /** Another repository sharing this sandbox's isolated configuration. */
  async sibling(name: string): Promise<GitRepo> {
    const root = path.join(this.sandbox, name);
    await mkdir(root);
    return new GitRepo(root, this.env, this.sandbox);
  }

  at(root: string): GitRepo {
    return new GitRepo(root, this.env, this.sandbox);
  }

  git(...args: string[]): string {
    // Distinct, increasing commit dates keep history ordering deterministic.
    tick += 1;
    const date = new Date(Date.UTC(2026, 0, 1) + tick * 1000).toISOString();
    return execFileSync('git', args, {
      cwd: this.root,
      env: { ...this.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  async write(file: string, content: string | Buffer, mode?: number): Promise<void> {
    const target = path.join(this.root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    if (mode !== undefined) await chmod(target, mode);
  }

  async symlink(file: string, target: string): Promise<void> {
    await symlink(target, path.join(this.root, file));
  }

  async remove(file: string): Promise<void> {
    await rm(path.join(this.root, file), { recursive: true, force: true });
  }

  commitAll(message: string): string {
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.head();
  }

  head(): string {
    return this.git('rev-parse', 'HEAD').trim();
  }

  /** Index bytes, HEAD file, HEAD commit, and every working-tree file (mode + content hash). */
  async userState(): Promise<UserState> {
    const gitDir = path.resolve(this.root, this.git('rev-parse', '--git-dir').trim());
    const index = await readFile(path.join(gitDir, 'index')).then(
      (b) => createHash('sha256').update(b).digest('hex'),
      () => null,
    );
    const files: Record<string, string> = {};
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir)) {
        if (entry === '.git') continue;
        const full = path.join(dir, entry);
        const info = await lstat(full);
        const rel = path.relative(this.root, full);
        if (info.isSymbolicLink()) files[rel] = `link:${await readlink(full)}`;
        else if (info.isDirectory()) await walk(full);
        else {
          const hash = createHash('sha256')
            .update(await readFile(full))
            .digest('hex');
          files[rel] = `${(info.mode & 0o777).toString(8)}:${hash}:${String(info.mtimeMs)}`;
        }
      }
    };
    await walk(this.root);
    const headFile = await readFile(path.join(gitDir, 'HEAD'), 'utf8');
    let headCommit: string;
    try {
      headCommit = this.head();
    } catch {
      headCommit = '(unborn)';
    }
    return { index, head: headFile, headCommit, files };
  }

  async cleanup(): Promise<void> {
    await rm(this.sandbox, { recursive: true, force: true });
  }
}

export interface Engine {
  runner: GitCommandRunner;
  lifecycle: PublicationLifecycle;
  store: LineageStore;
  refs: GitRefs;
}

export function createEngine(
  repo: GitRepo,
  runner?: GitCommandRunner,
  now?: () => Date,
  openCandidates?: LifecycleDependencies['openCandidates'],
): Engine {
  const git = runner ?? new SpawnGitRunner({ env: repo.env });
  const store = new LineageStore({ timeoutMs: 5_000 });
  const refs = new GitRefs(git);
  const lifecycle = new PublicationLifecycle({
    git,
    locator: new GitRepositoryLocatorImpl(git),
    issueKeys: new BranchIssueKeyDetector(),
    baseResolver: new BaseBranchResolver(git),
    snapshots: new GitSnapshotEngine(git),
    diff: new GitIncrementalDiffEngine(git),
    store,
    refs,
    ...(now ? { now } : {}),
    ...(openCandidates ? { openCandidates } : {}),
  });
  return { runner: git, lifecycle, store, refs };
}

let commentCounter = 10000;

/** Runs the full deterministic publication flow, simulating a successful Jira response. */
export async function publish(
  engine: Engine,
  request: Omit<AnalysisRequest, 'site'> & { site?: JiraSite },
): Promise<{ prepared: PreparedReport; checkpoint: Checkpoint }> {
  const site = request.site ?? SITE;
  const result = await engine.lifecycle.prepare({ ...request, site });
  if (result.status !== 'prepared') throw new Error('expected changes to publish');
  const prepared = result.report;
  await engine.lifecycle.beginPublication(prepared, DIGEST);
  const checkpoint = await engine.lifecycle.confirmPublication(
    { repository: prepared.context.repository, site, issueKey: prepared.context.issueKey },
    prepared.reportId,
    { commentId: String(commentCounter++), publishedAt: new Date().toISOString() },
  );
  return { prepared, checkpoint };
}

export function changedPaths(prepared: {
  changeSet: { files: { path: string; status: string }[] };
}): string[] {
  return prepared.changeSet.files.map((f) => `${f.status}:${f.path}`).sort();
}
