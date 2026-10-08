import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BaseBranchResolver } from '../../src/git/base';
import {
  BareRepositoryError,
  BaseBranchNotFoundError,
  BaseBranchUndeterminedError,
  NoMergeBaseError,
  NotARepositoryError,
} from '../../src/git/errors';
import { GitRepositoryLocatorImpl } from '../../src/git/repository';
import { SpawnGitRunner } from '../../src/git/runner';
import { GitRepo } from '../fixtures/git-repo';

const repos: GitRepo[] = [];
async function repo(options?: Parameters<typeof GitRepo.create>[0]): Promise<GitRepo> {
  const created = await GitRepo.create(options);
  repos.push(created);
  return created;
}
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.cleanup()));
});

function tools(r: GitRepo) {
  const git = new SpawnGitRunner({ env: r.env });
  return { locator: new GitRepositoryLocatorImpl(git), base: new BaseBranchResolver(git) };
}

describe('repository discovery', () => {
  it('finds the root, branch, and HEAD from a subdirectory', async () => {
    const r = await repo({ branch: 'feature/LSND-1-x' });
    await r.write('src/deep/file.ts', 'x');
    const info = await tools(r).locator.locate(path.join(r.root, 'src', 'deep'));
    expect(info).toMatchObject({
      root: r.root,
      gitDir: path.join(r.root, '.git'),
      commonDir: path.join(r.root, '.git'),
      indexPath: path.join(r.root, '.git', 'index'),
      objectFormat: 'sha1',
      branch: 'feature/LSND-1-x',
      headCommit: r.head(),
    });
  });

  it('reports detached HEAD as a null branch', async () => {
    const r = await repo();
    r.git('switch', '-q', '--detach', 'HEAD');
    expect((await tools(r).locator.locate(r.root)).branch).toBeNull();
  });

  it('reports an unborn branch with a null HEAD commit', async () => {
    const r = await repo({ initialCommit: false });
    expect(await tools(r).locator.locate(r.root)).toMatchObject({
      branch: 'main',
      headCommit: null,
    });
  });

  it('rejects directories outside a repository and bare repositories', async () => {
    const r = await repo();
    const outside = await r.sibling('plain');
    await expect(tools(r).locator.locate(outside.root)).rejects.toThrow(NotARepositoryError);
    const bare = await r.sibling('bare.git');
    bare.git('init', '-q', '--bare');
    await expect(tools(r).locator.locate(bare.root)).rejects.toThrow(BareRepositoryError);
  });

  it('distinguishes per-worktree and common git directories', async () => {
    const r = await repo();
    const wtPath = path.join(r.sandbox, 'wt');
    r.git('worktree', 'add', '-q', '-b', 'feature/LSND-2-wt', wtPath);
    const info = await tools(r).locator.locate(wtPath);
    expect(info.root).toBe(wtPath);
    expect(info.commonDir).toBe(path.join(r.root, '.git'));
    expect(info.gitDir).toBe(path.join(r.root, '.git', 'worktrees', 'wt'));
    expect(info.indexPath).toBe(path.join(info.gitDir, 'index'));
    expect(info.branch).toBe('feature/LSND-2-wt');
  });
});

describe('base branch resolution', () => {
  async function featureRepo(): Promise<GitRepo> {
    const r = await repo();
    await r.write('a.txt', '1');
    r.commitAll('main work');
    r.git('switch', '-q', '-c', 'feature/LSND-1-x');
    await r.write('b.txt', '1');
    r.commitAll('feature work');
    return r;
  }

  it('detects the only plausible base', async () => {
    const r = await featureRepo();
    const info = await tools(r).locator.locate(r.root);
    const base = await tools(r).base.resolve(info, {});
    expect(base).toMatchObject({
      name: 'main',
      source: 'detected',
      mergeBase: r.git('rev-parse', 'main').trim(),
    });
  });

  it('prefers an explicit option over repository configuration, and configuration over detection', async () => {
    const r = await featureRepo();
    r.git('branch', 'develop', 'main');
    const info = await tools(r).locator.locate(r.root);
    expect(
      await tools(r).base.resolve(info, { explicit: 'develop', configured: 'main' }),
    ).toMatchObject({
      name: 'develop',
      source: 'option',
    });
    expect(await tools(r).base.resolve(info, { configured: 'main' })).toMatchObject({
      name: 'main',
      source: 'repository configuration',
    });
  });

  it('never falls back when the configured base does not exist', async () => {
    const r = await featureRepo();
    const info = await tools(r).locator.locate(r.root);
    await expect(tools(r).base.resolve(info, { configured: 'develop' })).rejects.toThrow(
      BaseBranchNotFoundError,
    );
    await expect(tools(r).base.resolve(info, { explicit: '--output=/tmp/x' })).rejects.toThrow(
      BaseBranchNotFoundError,
    );
  });

  it('requires a choice when candidates disagree (git-flow develop vs main)', async () => {
    const r = await repo();
    r.git('switch', '-q', '-c', 'develop');
    await r.write('d.txt', '1');
    r.commitAll('develop work');
    r.git('switch', '-q', '-c', 'feature/LSND-1-x');
    await r.write('f.txt', '1');
    r.commitAll('feature work');
    const info = await tools(r).locator.locate(r.root);
    const error = await tools(r)
      .base.resolve(info, {})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BaseBranchUndeterminedError);
    expect((error as BaseBranchUndeterminedError).candidates.map((c) => c.ref)).toEqual([
      'develop',
      'main',
    ]);
  });

  it('treats a stale local branch and its remote-tracking branch as one candidate', async () => {
    const origin = await repo();
    const clonePath = path.join(origin.sandbox, 'clone');
    origin.git('clone', '-q', origin.root, clonePath);
    await origin.write('more.txt', '1');
    origin.commitAll('upstream work');
    const clone = origin.at(clonePath);
    clone.git('fetch', '-q');
    clone.git('switch', '-q', '-c', 'feature/LSND-3-x', 'origin/main');
    await clone.write('f.txt', '1');
    clone.commitAll('feature');
    const info = await tools(clone).locator.locate(clone.root);
    const base = await tools(clone).base.resolve(info, {});
    expect(base.name).toBe('origin/main');
    expect(base.mergeBase).toBe(clone.git('rev-parse', 'origin/main').trim());
  });

  it('fails clearly when no base can be found or histories are unrelated', async () => {
    const r = await repo();
    r.git('branch', '-m', 'feature/LSND-1-x');
    const info = await tools(r).locator.locate(r.root);
    await expect(tools(r).base.resolve(info, {})).rejects.toThrow(/Could not determine/);

    r.git('switch', '-q', '--orphan', 'unrelated');
    await r.write('u.txt', '1');
    r.commitAll('unrelated root');
    r.git('switch', '-q', 'feature/LSND-1-x');
    await expect(tools(r).base.resolve(info, { explicit: 'unrelated' })).rejects.toThrow(
      NoMergeBaseError,
    );
  });
});
