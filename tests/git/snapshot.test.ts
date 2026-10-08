import { execFileSync } from 'node:child_process';
import { readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitRepositoryLocatorImpl } from '../../src/git/repository';
import { SpawnGitRunner } from '../../src/git/runner';
import type {
  GitCommandOptions,
  GitCommandResult,
  GitCommandRunner,
  RepositoryInfo,
} from '../../src/git/types';
import { GitIncrementalDiffEngine } from '../../src/snapshots/diff';
import { GitSnapshotEngine } from '../../src/snapshots/engine';
import { SnapshotCaptureError, SnapshotUnstableError } from '../../src/snapshots/errors';
import type { ChangeSet, Snapshot } from '../../src/snapshots/types';
import { GitRepo } from '../fixtures/git-repo';

const posix = process.platform !== 'win32';
const hasLfs = (() => {
  try {
    execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const repos: GitRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.cleanup()));
});

async function setup(runnerWrapper?: (inner: GitCommandRunner, repo: GitRepo) => GitCommandRunner) {
  const repo = await GitRepo.create({ branch: 'feature/LSND-1-snap' });
  repos.push(repo);
  const base = new SpawnGitRunner({ env: repo.env });
  const git = runnerWrapper ? runnerWrapper(base, repo) : base;
  const engine = new GitSnapshotEngine(git);
  const diff = new GitIncrementalDiffEngine(git);
  const locate = () => new GitRepositoryLocatorImpl(base).locate(repo.root);
  const capture = async (info?: RepositoryInfo) =>
    engine.capture(info ?? (await locate()), { message: 'test' });
  const changes = async (from: Snapshot | string, to: Snapshot): Promise<ChangeSet> =>
    diff.diff(await locate(), {
      baseTree: typeof from === 'string' ? from : from.tree,
      targetTree: to.tree,
      fromCommit: null,
      toCommit: null,
    });
  const summary = (cs: ChangeSet) => cs.files.map((f) => `${f.status}:${f.path}`).sort();
  return { repo, engine, capture, changes, summary, locate };
}

describe('working-tree snapshots', () => {
  it('captures committed, staged, unstaged, untracked, deleted, and renamed files without touching user state', async () => {
    const { repo, capture, changes, summary } = await setup();
    await repo.write('keep.txt', 'keep\n');
    await repo.write('delete-me.txt', 'bye\n');
    await repo.write('rename-me.txt', 'some reasonably long content\nthat survives a rename\n');
    repo.commitAll('base files');
    const before = await capture();

    await repo.write('committed.txt', 'c\n');
    repo.commitAll('committed change');
    await repo.write('staged.txt', 's\n');
    repo.git('add', 'staged.txt');
    await repo.write('keep.txt', 'keep\nunstaged edit\n');
    await repo.write('untracked.txt', 'u\n');
    await repo.remove('delete-me.txt');
    repo.git('mv', 'rename-me.txt', 'renamed.txt');
    await repo.write('.gitignore', 'ignored.log\n');
    await repo.write('ignored.log', 'never captured\n');

    const userBefore = await repo.userState();
    const after = await capture();
    expect(await repo.userState()).toEqual(userBefore);
    expect(repo.git('status', '--porcelain').length).toBeGreaterThan(0);

    expect(after.includesUncommittedChanges).toBe(true);
    expect(after.headCommit).toBe(repo.head());
    expect(summary(await changes(before, after))).toEqual([
      'added:.gitignore',
      'added:committed.txt',
      'added:staged.txt',
      'added:untracked.txt',
      'deleted:delete-me.txt',
      'modified:keep.txt',
      'renamed:renamed.txt',
    ]);
    expect(repo.git('for-each-ref', 'refs/git2jira')).toBe('');
  });

  it('is deterministic: an unchanged working tree yields the same tree', async () => {
    const { repo, capture } = await setup();
    await repo.write('x.txt', 'x');
    const a = await capture();
    const b = await capture();
    expect(b.tree).toBe(a.tree);
    expect(a.includesUncommittedChanges).toBe(true);
  });

  it.skipIf(!posix)('records executable mode changes and symlinks', async () => {
    const { repo, capture, changes } = await setup();
    await repo.write('script.sh', '#!/bin/sh\necho hi\n', 0o644);
    await repo.write('target.txt', 't');
    repo.commitAll('add script');
    const before = await capture();
    await repo.write('script.sh', '#!/bin/sh\necho hi\n', 0o755);
    await repo.symlink('link-to-target', 'target.txt');
    const cs = await changes(before, await capture());
    expect(cs.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'script.sh',
          status: 'modified',
          kind: 'executable',
          modeChanged: true,
        }),
        expect.objectContaining({ path: 'link-to-target', status: 'added', kind: 'symlink' }),
      ]),
    );
  });

  it('handles binary files, large files, Unicode names, and special characters', async () => {
    const { repo, capture, changes } = await setup();
    const before = await capture();
    const names = ['звіт ü 日本.md', 'with space.txt', "quote's & (paren) #hash.txt"];
    if (posix) names.push('tab\there.txt', 'new\nline.txt', 'back\\slash.txt');
    for (const name of names) await repo.write(name, `content of ${name}\n`);
    await repo.write('image.bin', Buffer.from([0, 1, 2, 3, 255, 0, 10, 13]));
    await repo.write('large.txt', 'line\n'.repeat(400_000)); // ~2 MB
    const cs = await changes(before, await capture());
    expect(cs.files.map((f) => f.path).sort()).toEqual([...names, 'image.bin', 'large.txt'].sort());
    expect(cs.files.find((f) => f.path === 'image.bin')).toMatchObject({
      binary: true,
      additions: 0,
    });
    expect(cs.files.find((f) => f.path === 'large.txt')).toMatchObject({ additions: 400_000 });
    expect(cs.patchTruncated).toBe(true);
    expect(Buffer.byteLength(cs.patch)).toBeLessThanOrEqual(256 * 1024);
  });

  it('omits secrets and lock files from the patch but still lists them', async () => {
    const { repo, capture, changes } = await setup();
    const before = await capture();
    await repo.write('.env', 'API_TOKEN=super-secret\n');
    await repo.write('config/.env.local', 'PASSWORD=hunter2\n');
    await repo.write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    await repo.write('src/app.ts', 'export const app = 1;\n');
    const cs = await changes(before, await capture());
    expect(cs.files.map((f) => f.path).sort()).toEqual([
      '.env',
      'config/.env.local',
      'pnpm-lock.yaml',
      'src/app.ts',
    ]);
    expect(cs.patch).toContain('export const app = 1;');
    expect(cs.patch).not.toContain('super-secret');
    expect(cs.patch).not.toContain('hunter2');
    expect(cs.patch).not.toContain('lockfileVersion');
  });

  it('records submodule pointer changes', async () => {
    const { repo, capture, changes } = await setup();
    const lib = await repo.sibling('lib');
    lib.git('init', '-q', '-b', 'main');
    await lib.write('lib.txt', 'v1');
    lib.commitAll('lib v1');
    repo.git('submodule', 'add', '-q', lib.root, 'vendor/lib');
    repo.commitAll('add submodule');
    const before = await capture();

    const sub = repo.at(path.join(repo.root, 'vendor/lib'));
    await sub.write('lib.txt', 'v2');
    sub.commitAll('lib v2');
    const cs = await changes(before, await capture());
    expect(cs.files).toEqual([
      expect.objectContaining({ path: 'vendor/lib', status: 'modified', kind: 'submodule' }),
    ]);
  });

  it.skipIf(!hasLfs)('stores Git LFS pointers, not file contents', async () => {
    const { repo, capture, changes } = await setup();
    repo.git('lfs', 'install', '--local');
    await repo.write('.gitattributes', '*.psd filter=lfs diff=lfs merge=lfs -text\n');
    repo.commitAll('track psd');
    const before = await capture();
    await repo.write('design.psd', Buffer.alloc(2048, 7));
    const cs = await changes(before, await capture());
    expect(cs.patch).toContain('version https://git-lfs.github.com/spec/v1');
  });

  it('works with LFS attributes when git-lfs is not installed', async () => {
    const { repo, capture, changes } = await setup();
    await repo.write('.gitattributes', '*.psd filter=lfs-missing -text\n');
    repo.commitAll('attributes');
    const before = await capture();
    await repo.write('design.psd', Buffer.alloc(64, 1));
    expect((await changes(before, await capture())).files.map((f) => f.path)).toEqual([
      'design.psd',
    ]);
  });

  it('captures an unborn branch', async () => {
    const repo = await GitRepo.create({ initialCommit: false });
    repos.push(repo);
    const git = new SpawnGitRunner({ env: repo.env });
    await repo.write('first.txt', 'hello');
    const info = await new GitRepositoryLocatorImpl(git).locate(repo.root);
    const snapshot = await new GitSnapshotEngine(git).capture(info, { message: 'm' });
    expect(snapshot).toMatchObject({
      headCommit: null,
      includesUncommittedChanges: true,
      branch: 'main',
    });
  });

  it('works with a split index', async () => {
    const { repo, capture } = await setup();
    repo.git('update-index', '--split-index');
    await repo.write('after-split.txt', 'x');
    const before = await repo.userState();
    const snapshot = await capture();
    expect(repo.git('ls-tree', '-r', '--name-only', snapshot.tree)).toContain('after-split.txt');
    expect(await repo.userState()).toEqual(before);
  });

  it('works in a linked worktree using that worktree index', async () => {
    const { repo } = await setup();
    const wtPath = path.join(repo.sandbox, 'wt');
    repo.git('worktree', 'add', '-q', '-b', 'feature/LSND-9-wt', wtPath);
    const wt = repo.at(wtPath);
    await wt.write('only-in-worktree.txt', 'x');
    wt.git('add', 'only-in-worktree.txt');
    const git = new SpawnGitRunner({ env: repo.env });
    const info = await new GitRepositoryLocatorImpl(git).locate(wtPath);
    const before = await wt.userState();
    const snapshot = await new GitSnapshotEngine(git).capture(info, { message: 'm' });
    expect(snapshot.branch).toBe('feature/LSND-9-wt');
    expect(repo.git('ls-tree', '-r', '--name-only', snapshot.tree)).toContain(
      'only-in-worktree.txt',
    );
    expect(await wt.userState()).toEqual(before);
  });

  it('refuses to capture during a merge conflict', async () => {
    const { repo, capture } = await setup();
    await repo.write('c.txt', 'feature');
    repo.commitAll('feature side');
    repo.git('switch', '-q', 'main');
    await repo.write('c.txt', 'main');
    repo.commitAll('main side');
    repo.git('switch', '-q', 'feature/LSND-1-snap');
    try {
      repo.git('merge', 'main');
    } catch {
      // conflict expected
    }
    await expect(capture()).rejects.toThrow(/merge is in progress/);
  });
});

/** Runner that lets a test act between git invocations. */
function intercept(
  inner: GitCommandRunner,
  hook: (args: readonly string[], count: number) => Promise<void> | void,
): GitCommandRunner {
  let count = 0;
  return {
    async run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult> {
      await hook(args, ++count);
      return inner.run(args, options);
    },
  };
}

describe('consistency and interruption', () => {
  it('retries when files change during capture and returns the settled state', async () => {
    let writeTrees = 0;
    const { repo, capture } = await setup((inner, r) =>
      intercept(inner, async (args) => {
        if (args[0] === 'write-tree' && ++writeTrees === 1) {
          await r.write('busy.txt', 'changed while capturing');
        }
      }),
    );
    await repo.write('busy.txt', 'original');
    const snapshot = await capture();
    expect(repo.git('show', `${snapshot.tree}:busy.txt`)).toBe('changed while capturing');
    expect(writeTrees).toBeGreaterThan(2);
  });

  it('stops safely when files never settle', async () => {
    let n = 0;
    const { repo, capture } = await setup((inner, r) =>
      intercept(inner, async (args) => {
        if (args[0] === 'write-tree') await r.write('busy.txt', `v${String(++n)}`);
      }),
    );
    const before = await repo.userState();
    await expect(capture()).rejects.toThrow(SnapshotUnstableError);
    const after = await repo.userState();
    expect({ ...after, files: { ...after.files, 'busy.txt': '' } }).toEqual({
      ...before,
      files: { ...before.files, 'busy.txt': '' },
    });
  });

  it('cleans up after an interrupted capture and leaves no partial state', async () => {
    const { repo, capture, locate } = await setup((inner) =>
      intercept(inner, (args) => {
        if (args[0] === 'write-tree') throw new Error('simulated crash');
      }),
    );
    await repo.write('x.txt', 'x');
    const before = await repo.userState();
    await expect(capture()).rejects.toThrow('simulated crash');
    expect(await repo.userState()).toEqual(before);
    const info = await locate();
    expect(await readdir(path.join(info.commonDir, 'git2jira', 'tmp'))).toEqual([]);
    expect(repo.git('for-each-ref', 'refs/git2jira')).toBe('');
  });

  it('removes temporary indexes left behind by a crashed process', async () => {
    const { repo, capture, locate } = await setup();
    const info = await locate();
    const tmp = path.join(info.commonDir, 'git2jira', 'tmp');
    await mkdir(tmp, { recursive: true });
    // PID 2^22+1 is above the default pid_max on Linux and macOS, so it is not running.
    await writeFile(path.join(tmp, 'index-4194305-deadbeef'), 'partial');
    await repo.write('x.txt', 'x');
    await capture();
    expect(await readdir(tmp)).toEqual([]);
  });

  it('fails with a clear error instead of producing a partial snapshot when a file is unreadable', async () => {
    if (!posix || process.getuid?.() === 0) return;
    const { repo, capture } = await setup();
    await repo.write('secret.txt', 'x', 0o000);
    await expect(capture()).rejects.toThrow(SnapshotCaptureError);
  });
});
