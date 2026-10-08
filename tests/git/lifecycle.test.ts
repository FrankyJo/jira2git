import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BranchChangedError,
  CheckpointCorruptedError,
  CheckpointUnavailableError,
  JournalMissingError,
  LockBusyError,
  MultipleSitesError,
  PendingPublicationError,
  StaleReportError,
} from '../../src/checkpoints/errors';
import { jiraSiteFromUrl } from '../../src/checkpoints/site';
import { LineageStore } from '../../src/checkpoints/store';
import {
  AmbiguousIssueKeyError,
  BaseBranchUndeterminedError,
  DetachedHeadError,
  IssueKeyNotFoundError,
} from '../../src/git/errors';
import type { PreparedReport } from '../../src/publication/lifecycle';
import {
  DIGEST,
  GitRepo,
  SITE,
  changedPaths,
  createEngine,
  publish,
  type Engine,
} from '../fixtures/git-repo';

const repos: GitRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.cleanup()));
});

async function setup(branch = 'feature/LSND-1234-user-profile') {
  const repo = await GitRepo.create({ branch });
  repos.push(repo);
  return { repo, engine: createEngine(repo) };
}

async function prepared(
  engine: Engine,
  repo: GitRepo,
  extra: object = {},
): Promise<PreparedReport> {
  const result = await engine.lifecycle.prepare({ cwd: repo.root, site: SITE, ...extra });
  if (result.status !== 'prepared') throw new Error('expected changes');
  return result.report;
}

function key(report: PreparedReport) {
  return {
    repository: report.context.repository,
    site: report.site,
    issueKey: report.context.issueKey,
  };
}

describe('incremental reports', () => {
  it('report 2 contains only what changed after report 1; report 3 without changes publishes nothing', async () => {
    const { repo, engine } = await setup();

    // Day 1
    await repo.write('src/ProfileView.vue', '<template>view</template>\n');
    await repo.write('src/ProfileForm.vue', '<template>form</template>\n');
    await repo.write('src/router.ts', "export const routes = ['/profile'];\n");
    repo.commitAll('profile components');
    const userBefore = await repo.userState();
    const first = await publish(engine, { cwd: repo.root });
    expect(await repo.userState()).toEqual(userBefore);
    expect(first.prepared.baseline).toMatchObject({ kind: 'merge-base', baseName: 'main' });
    expect(changedPaths(first.prepared)).toEqual([
      'added:src/ProfileForm.vue',
      'added:src/ProfileView.vue',
      'added:src/router.ts',
    ]);
    expect(first.checkpoint).toMatchObject({
      sequence: 1,
      state: 'published',
      issueKey: 'LSND-1234',
    });

    // Day 6
    await repo.write('src/ProfileView.vue', '<template>view v2</template>\n');
    await repo.write('src/profileApi.ts', 'export async function load() {}\n');
    repo.commitAll('api integration');
    const second = await publish(engine, { cwd: repo.root });
    expect(second.prepared.baseline).toMatchObject({ kind: 'checkpoint', sequence: 1 });
    expect(changedPaths(second.prepared)).toEqual([
      'added:src/profileApi.ts',
      'modified:src/ProfileView.vue',
    ]);
    expect(second.prepared.changeSet.patch).toContain('+<template>view v2</template>');
    expect(second.prepared.changeSet.patch).not.toContain('ProfileForm');
    expect(second.prepared.changeSet.commits.map((c) => c.subject)).toEqual(['api integration']);
    expect(second.checkpoint.sequence).toBe(2);

    // Day 7
    const third = await engine.lifecycle.prepare({ cwd: repo.root, site: SITE });
    expect(third.status).toBe('no-changes');
    expect(repo.git('for-each-ref', '--format=%(refname)', 'refs/git2jira')).toBe(
      [
        `refs/git2jira/${SITE.id}/LSND-1234/checkpoints/000001`,
        `refs/git2jira/${SITE.id}/LSND-1234/checkpoints/000002`,
        '',
      ].join('\n'),
    );
  });

  it('includes multiple commits plus staged, unstaged, and untracked work', async () => {
    const { repo, engine } = await setup();
    await repo.write('a.ts', '1');
    repo.commitAll('one');
    await repo.write('b.ts', '1');
    repo.commitAll('two');
    await repo.write('staged.ts', '1');
    repo.git('add', 'staged.ts');
    await repo.write('a.ts', '2');
    await repo.write('untracked.ts', '1');
    const report = await prepared(engine, repo);
    expect(changedPaths(report)).toEqual([
      'added:a.ts',
      'added:b.ts',
      'added:staged.ts',
      'added:untracked.ts',
    ]);
    expect(report.changeSet.commits.map((c) => c.subject)).toEqual(['two', 'one']);
    expect(report.snapshot.includesUncommittedChanges).toBe(true);
  });

  it('reports deletions and renames of previously reported files', async () => {
    const { repo, engine } = await setup();
    await repo.write(
      'old-name.ts',
      'export const value = "a long enough body for rename detection";\n',
    );
    await repo.write('gone.ts', 'x\n');
    repo.commitAll('files');
    await publish(engine, { cwd: repo.root });
    repo.git('mv', 'old-name.ts', 'new-name.ts');
    repo.git('rm', '-q', 'gone.ts');
    const report = await prepared(engine, repo);
    expect(changedPaths(report)).toEqual(['deleted:gone.ts', 'renamed:new-name.ts']);
    expect(report.changeSet.files.find((f) => f.status === 'renamed')?.previousPath).toBe(
      'old-name.ts',
    );
  });

  it('treats work reverted back to the last report as no change', async () => {
    const { repo, engine } = await setup();
    await repo.write('a.ts', 'v1\n');
    repo.commitAll('v1');
    await publish(engine, { cwd: repo.root });
    await repo.write('a.ts', 'experiment\n');
    repo.commitAll('experiment');
    repo.git('revert', '--no-edit', 'HEAD');
    expect((await engine.lifecycle.prepare({ cwd: repo.root, site: SITE })).status).toBe(
      'no-changes',
    );
  });

  it('reports a revert of already reported work as a change', async () => {
    const { repo, engine } = await setup();
    await repo.write('a.ts', 'v1\n');
    repo.commitAll('v1');
    await publish(engine, { cwd: repo.root });
    repo.git('revert', '--no-edit', 'HEAD');
    expect(changedPaths(await prepared(engine, repo))).toEqual(['deleted:a.ts']);
  });

  it('is unaffected by rebase, squash, and force-push style rewrites', async () => {
    const { repo, engine } = await setup();
    await repo.write('a.ts', '1\n');
    repo.commitAll('a');
    await repo.write('b.ts', '1\n');
    repo.commitAll('b');
    await publish(engine, { cwd: repo.root });

    // main moves on; the feature branch is rebased onto it and squashed.
    repo.git('switch', '-q', 'main');
    await repo.write('upstream.ts', '1\n');
    repo.commitAll('upstream');
    repo.git('switch', '-q', 'feature/LSND-1234-user-profile');
    repo.git('rebase', '-q', 'main');
    repo.git('reset', '--soft', 'main');
    repo.git('commit', '-q', '-m', 'squashed');
    await repo.write('c.ts', '1\n');
    repo.commitAll('c');
    repo.git('reflog', 'expire', '--expire=now', '--all');
    repo.git('gc', '-q', '--prune=now');

    const report = await prepared(engine, repo);
    // upstream.ts arrived through the rebase, so it is part of the new branch state.
    expect(changedPaths(report)).toEqual(['added:c.ts', 'added:upstream.ts']);
  });

  it('handles reset to an earlier state by reporting the removed work', async () => {
    const { repo, engine } = await setup();
    await repo.write('a.ts', '1\n');
    repo.commitAll('a');
    await repo.write('b.ts', '1\n');
    repo.commitAll('b');
    await publish(engine, { cwd: repo.root });
    repo.git('reset', '-q', '--hard', 'HEAD~1');
    expect(changedPaths(await prepared(engine, repo))).toEqual(['deleted:b.ts']);
  });

  it('includes cherry-picked commits once', async () => {
    const { repo, engine } = await setup();
    await repo.write('a.ts', '1\n');
    repo.commitAll('a');
    await publish(engine, { cwd: repo.root });
    repo.git('switch', '-q', '-c', 'other', 'main');
    await repo.write('fix.ts', 'fix\n');
    const fix = repo.commitAll('fix');
    repo.git('switch', '-q', 'feature/LSND-1234-user-profile');
    repo.git('cherry-pick', fix);
    expect(changedPaths(await prepared(engine, repo))).toEqual(['added:fix.ts']);
  });
});

describe('issue and branch identity', () => {
  it('uses --issue when the branch has no key, and refuses to guess otherwise', async () => {
    const { repo, engine } = await setup('feature/user-profile');
    await repo.write('a.ts', '1');
    await expect(engine.lifecycle.analyze({ cwd: repo.root })).rejects.toThrow(
      IssueKeyNotFoundError,
    );
    const analysis = await engine.lifecycle.analyze({ cwd: repo.root, issue: 'LSND-77' });
    expect(analysis.context).toMatchObject({ issueKey: 'LSND-77', issueSource: 'option' });
  });

  it('rejects ambiguous branch names', async () => {
    const { repo, engine } = await setup('feature/LSND-1-PROJ-2');
    await expect(engine.lifecycle.analyze({ cwd: repo.root })).rejects.toThrow(
      AmbiguousIssueKeyError,
    );
  });

  it('refuses detached HEAD, even with --issue', async () => {
    const { repo, engine } = await setup();
    repo.git('switch', '-q', '--detach');
    await expect(engine.lifecycle.analyze({ cwd: repo.root, issue: 'LSND-1' })).rejects.toThrow(
      DetachedHeadError,
    );
  });

  it('asks for a base when it cannot be determined', async () => {
    const { repo, engine } = await setup();
    repo.git('branch', 'develop', 'main');
    repo.git('switch', '-q', 'develop');
    await repo.write('d.ts', '1');
    repo.commitAll('develop work');
    repo.git('switch', '-q', 'feature/LSND-1234-user-profile');
    repo.git('rebase', '-q', 'develop');
    await expect(engine.lifecycle.analyze({ cwd: repo.root })).rejects.toThrow(
      BaseBranchUndeterminedError,
    );
    const analysis = await engine.lifecycle.analyze({ cwd: repo.root, base: 'develop' });
    expect(analysis.baseline).toMatchObject({ kind: 'merge-base', baseName: 'develop' });
    const configured = await engine.lifecycle.analyze({ cwd: repo.root, configuredBase: 'main' });
    expect(configured.baseline).toMatchObject({ kind: 'merge-base', baseName: 'main' });
  });

  it('keeps separate histories per issue when switching branches', async () => {
    const { repo, engine } = await setup('feature/LSND-1-a');
    await repo.write('a.ts', '1');
    repo.commitAll('a');
    await publish(engine, { cwd: repo.root });
    repo.git('switch', '-q', '-c', 'feature/LSND-2-b', 'main');
    await repo.write('b.ts', '1');
    repo.commitAll('b');
    const report = await prepared(engine, repo);
    expect(report.baseline.kind).toBe('merge-base');
    expect(changedPaths(report)).toEqual(['added:b.ts']);
    repo.git('switch', '-q', 'feature/LSND-1-a');
    expect((await engine.lifecycle.prepare({ cwd: repo.root, site: SITE })).status).toBe(
      'no-changes',
    );
  });

  it('follows a renamed branch automatically', async () => {
    const { repo, engine } = await setup('feature/LSND-5-old');
    await repo.write('a.ts', '1');
    repo.commitAll('a');
    await publish(engine, { cwd: repo.root });
    repo.git('branch', '-m', 'feature/LSND-5-new-name');
    await repo.write('b.ts', '1');
    const report = await prepared(engine, repo);
    expect(report.context.branchChange).toEqual({ from: 'feature/LSND-5-old', renamed: true });
    expect(changedPaths(report)).toEqual(['added:b.ts']);
  });

  it('requires confirmation to continue an issue on a different branch', async () => {
    const { repo, engine } = await setup('feature/LSND-6-first');
    await repo.write('a.ts', '1');
    repo.commitAll('a');
    await publish(engine, { cwd: repo.root });
    repo.git('switch', '-q', '-c', 'bugfix/LSND-6-second');
    await repo.write('b.ts', '1');
    await expect(engine.lifecycle.prepare({ cwd: repo.root, site: SITE })).rejects.toThrow(
      BranchChangedError,
    );
    const report = await prepared(engine, repo, { acceptBranchChange: true });
    expect(report.context.branchChange).toEqual({ from: 'feature/LSND-6-first', renamed: false });
    expect(changedPaths(report)).toEqual(['added:b.ts']);
  });

  it('keeps histories for different Jira sites and different repositories apart', async () => {
    const { repo, engine } = await setup();
    await repo.write('a.ts', '1');
    repo.commitAll('a');
    await publish(engine, { cwd: repo.root });
    const otherSite = jiraSiteFromUrl('https://other.atlassian.net');
    const forOtherSite = await prepared(engine, repo, { site: otherSite });
    expect(forOtherSite.baseline.kind).toBe('merge-base');
    await engine.lifecycle.cancel(forOtherSite);
    // With only one site in history, analysis without --site finds it.
    expect((await engine.lifecycle.analyze({ cwd: repo.root })).context.site).toEqual(SITE);
    await publish(engine, { cwd: repo.root, site: otherSite });
    await expect(engine.lifecycle.analyze({ cwd: repo.root })).rejects.toThrow(MultipleSitesError);

    const other = await setup();
    await other.repo.write('z.ts', '1');
    other.repo.commitAll('z');
    const report = await prepared(other.engine, other.repo);
    expect(report.baseline.kind).toBe('merge-base');
    expect(changedPaths(report)).toEqual(['added:z.ts']);
  });
});

describe('publication state machine', () => {
  it('does not advance the baseline when a prepared report is cancelled', async () => {
    const { repo, engine } = await setup();
    await repo.write('a.ts', '1');
    const report = await prepared(engine, repo);
    await engine.lifecycle.cancel(report);
    expect(repo.git('for-each-ref', 'refs/git2jira')).toBe('');
    const again = await prepared(engine, repo);
    expect(changedPaths(again)).toEqual(['added:a.ts']);
  });

  it('does not treat a finished preparation as published', async () => {
    const { repo, engine } = await setup();
    await repo.write('a.ts', '1');
    await prepared(engine, repo);
    const next = await prepared(engine, repo);
    expect(next.baseline.kind).toBe('merge-base');
    expect(next.nextSequence).toBe(1);
  });

  it('blocks new reports while a publication outcome is unknown, then settles it', async () => {
    const { repo, engine } = await setup();
    await repo.write('a.ts', '1');
    const report = await prepared(engine, repo);
    await engine.lifecycle.beginPublication(report, DIGEST);
    await expect(engine.lifecycle.prepare({ cwd: repo.root, site: SITE })).rejects.toThrow(
      PendingPublicationError,
    );
    await expect(engine.lifecycle.cancel(report)).rejects.toThrow(/publication has started/);

    const recovery = await engine.lifecycle.recover(key(report));
    expect(recovery.unresolved.map((r) => r.reportId)).toEqual([report.reportId]);

    // Jira lookup (Phase 2) says the comment was not created.
    await engine.lifecycle.resolvePending(key(report), report.reportId, { published: false });
    const again = await prepared(engine, repo);
    expect(again.nextSequence).toBe(1);
    expect(again.baseline.kind).toBe('merge-base');
  });

  it('settles an unknown outcome as published without duplicating history', async () => {
    const { repo, engine } = await setup();
    await repo.write('a.ts', '1');
    const report = await prepared(engine, repo);
    await engine.lifecycle.beginPublication(report, DIGEST);
    const checkpoint = await engine.lifecycle.resolvePending(key(report), report.reportId, {
      published: true,
      commentId: '555',
      publishedAt: new Date().toISOString(),
    });
    expect(checkpoint.state).toBe('published');
    expect((await engine.lifecycle.prepare({ cwd: repo.root, site: SITE })).status).toBe(
      'no-changes',
    );
  });

  it('confirmation is idempotent', async () => {
    const { repo, engine } = await setup();
    await repo.write('a.ts', '1');
    const report = await prepared(engine, repo);
    await engine.lifecycle.beginPublication(report, DIGEST);
    const publication = { commentId: '1', publishedAt: new Date().toISOString() };
    const a = await engine.lifecycle.confirmPublication(key(report), report.reportId, publication);
    const b = await engine.lifecycle.confirmPublication(key(report), report.reportId, publication);
    expect(b).toEqual(a);
  });

  it('rejects a report prepared before another one was published', async () => {
    const { repo, engine } = await setup();
    await repo.write('a.ts', '1');
    const stale = await prepared(engine, repo);
    await publish(engine, { cwd: repo.root });
    await expect(engine.lifecycle.beginPublication(stale, DIGEST)).rejects.toThrow(
      StaleReportError,
    );
  });

  it('allows exactly one of several concurrent publications', async () => {
    const { repo, engine } = await setup();
    await repo.write('a.ts', '1');
    const reports = await Promise.all([1, 2, 3].map(() => prepared(engine, repo)));
    expect(new Set(reports.map((r) => r.reportId)).size).toBe(3);
    const results = await Promise.allSettled(
      reports.map((r) => engine.lifecycle.beginPublication(r, DIGEST)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const rejected of results.filter((r) => r.status === 'rejected')) {
      expect(rejected.reason).toBeInstanceOf(PendingPublicationError);
    }
  });

  async function writeForeignLock(report: PreparedReport, pid: number): Promise<string> {
    const lock = path.join(
      report.context.repository.commonDir,
      'git2jira',
      'locks',
      `${SITE.id}-LSND-1234.lock`,
    );
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, `${JSON.stringify({ pid, host: hostname(), createdAt: '' })}\nforeign`);
    return lock;
  }

  it('times out instead of waiting forever on a lock held by a live process', async () => {
    const { repo, engine } = await setup();
    await repo.write('a.ts', '1');
    const report = await prepared(engine, repo);
    // Our own pid is alive, so the lock looks held by another running invocation.
    const lock = await writeForeignLock(report, process.pid);
    const impatient = new LineageStore({ timeoutMs: 200 });
    await expect(
      impatient.withLock(report.context.repository, SITE.id, report.context.issueKey, () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow(LockBusyError);
    await rm(lock);
    await engine.lifecycle.beginPublication(report, DIGEST);
  });

  it('breaks a lock left by a crashed process', async () => {
    const { repo, engine } = await setup();
    await repo.write('a.ts', '1');
    const report = await prepared(engine, repo);
    await writeForeignLock(report, 4194305);
    await engine.lifecycle.beginPublication(report, DIGEST);
  });
});

describe('recovery and corruption', () => {
  async function publishedRepo() {
    const ctx = await setup();
    await ctx.repo.write('a.ts', '1');
    ctx.repo.commitAll('a');
    const { prepared: report } = await publish(ctx.engine, { cwd: ctx.repo.root });
    await ctx.repo.write('b.ts', '1');
    const journal = ctx.engine.store.journalPath(
      report.context.repository,
      SITE.id,
      report.context.issueKey,
    );
    return { ...ctx, report, journal };
  }

  it('refuses to regenerate a full report when the journal is missing, and recovers it from refs', async () => {
    const { repo, engine, report, journal } = await publishedRepo();
    await rm(journal);
    await expect(engine.lifecycle.prepare({ cwd: repo.root, site: SITE })).rejects.toThrow(
      JournalMissingError,
    );
    await expect(engine.lifecycle.analyze({ cwd: repo.root })).rejects.toThrow(JournalMissingError);
    const recovery = await engine.lifecycle.recover(key(report));
    expect(recovery.rebuiltFromRefs).toBe(true);
    const next = await prepared(engine, repo);
    expect(next.baseline).toMatchObject({ kind: 'checkpoint', sequence: 1 });
    expect(changedPaths(next)).toEqual(['added:b.ts']);
  });

  it('refuses corrupted metadata, and recovery quarantines and rebuilds it', async () => {
    const { repo, engine, report, journal } = await publishedRepo();
    await writeFile(journal, '{ "schemaVersion": 1, "records": [');
    await expect(engine.lifecycle.prepare({ cwd: repo.root, site: SITE })).rejects.toThrow(
      CheckpointCorruptedError,
    );
    const recovery = await engine.lifecycle.recover(key(report));
    expect(recovery.quarantinedJournal).toMatch(/\.corrupt-/);
    expect(await readFile(recovery.quarantinedJournal ?? '', 'utf8')).toContain('"records": [');
    expect((await prepared(engine, repo)).baseline).toMatchObject({
      kind: 'checkpoint',
      sequence: 1,
    });
  });

  it('refuses when the checkpoint snapshot is gone', async () => {
    const { repo, engine } = await publishedRepo();
    repo.git('update-ref', '-d', `refs/git2jira/${SITE.id}/LSND-1234/checkpoints/000001`);
    await expect(engine.lifecycle.prepare({ cwd: repo.root, site: SITE })).rejects.toThrow(
      CheckpointUnavailableError,
    );
  });

  it('promotes a publication that was confirmed but interrupted before promotion', async () => {
    const { repo, engine } = await setup();
    await repo.write('a.ts', '1');
    const report = await prepared(engine, repo);
    const record = await engine.lifecycle.beginPublication(report, DIGEST);
    // Simulate a crash right after Jira confirmed: journal says "confirmed", no checkpoint ref yet.
    const journal = await engine.store.read(
      report.context.repository,
      SITE.id,
      report.context.issueKey,
    );
    if (!journal) throw new Error('journal expected');
    await engine.store.write(report.context.repository, {
      ...journal,
      records: [
        {
          ...record,
          state: 'confirmed',
          publication: { commentId: '9', publishedAt: record.createdAt },
        },
      ],
    });
    await expect(engine.lifecycle.prepare({ cwd: repo.root, site: SITE })).rejects.toThrow(
      PendingPublicationError,
    );
    const recovery = await engine.lifecycle.recover(key(report));
    expect(recovery.promoted).toEqual([report.reportId]);
    expect((await engine.lifecycle.prepare({ cwd: repo.root, site: SITE })).status).toBe(
      'no-changes',
    );
  });

  it('removes abandoned candidate refs during recovery', async () => {
    const { repo } = await setup();
    let now = new Date('2026-01-01T00:00:00Z');
    const engine = createEngine(repo, undefined, () => now);
    await repo.write('a.ts', '1');
    const report = await prepared(engine, repo);
    expect(repo.git('for-each-ref', 'refs/git2jira')).toContain('candidates');
    now = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const recovery = await engine.lifecycle.recover(key(report));
    expect(recovery.removedCandidates).toEqual([report.snapshotRef]);
    expect(repo.git('for-each-ref', 'refs/git2jira')).toBe('');
  });
});

describe('garbage collection and worktrees', () => {
  it('keeps candidate and checkpoint snapshots through aggressive garbage collection', async () => {
    const { repo, engine } = await setup();
    await repo.write('uncommitted.ts', 'only in the working tree\n');
    const { checkpoint } = await publish(engine, { cwd: repo.root });
    await repo.write('second.ts', '2');
    const candidate = await prepared(engine, repo);
    // Remove the uncommitted file so nothing but our refs references its blob.
    await repo.remove('uncommitted.ts');
    repo.git('reflog', 'expire', '--expire=now', '--all');
    repo.git('gc', '-q', '--prune=now', '--aggressive');
    expect(repo.git('cat-file', '-t', checkpoint.snapshot.tree).trim()).toBe('tree');
    expect(repo.git('show', `${checkpoint.snapshot.tree}:uncommitted.ts`)).toBe(
      'only in the working tree\n',
    );
    expect(repo.git('cat-file', '-t', candidate.snapshot.tree).trim()).toBe('tree');
    await engine.lifecycle.beginPublication(candidate, DIGEST);
    await engine.lifecycle.confirmPublication(key(candidate), candidate.reportId, {
      commentId: '2',
      publishedAt: new Date().toISOString(),
    });
    expect(changedPaths(await prepared(engine, repo))).toEqual(['deleted:uncommitted.ts']);
  });

  it('shares history across worktrees of the same repository', async () => {
    const { repo, engine } = await setup('feature/LSND-8-main-wt');
    await repo.write('a.ts', '1');
    repo.commitAll('a');
    await publish(engine, { cwd: repo.root });
    const wtPath = path.join(repo.sandbox, 'wt');
    repo.git('worktree', 'add', '-q', '-b', 'feature/LSND-9-other', wtPath, 'main');
    const wt = repo.at(wtPath);
    await wt.write('w.ts', '1');
    const before = await wt.userState();
    const fromWorktree = await prepared(engine, wt);
    expect(await wt.userState()).toEqual(before);
    expect(changedPaths(fromWorktree)).toEqual(['added:w.ts']);
    expect(fromWorktree.context.repository.commonDir).toBe(path.join(repo.root, '.git'));
    // The main worktree's issue history is visible from the linked worktree.
    const analysis = await engine.lifecycle.analyze({
      cwd: wtPath,
      issue: 'LSND-8',
      acceptBranchChange: true,
    });
    expect(analysis.baseline).toMatchObject({ kind: 'checkpoint', sequence: 1 });
  });
});
