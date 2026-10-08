import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultContainer } from '../../src/app/bootstrap';
import { FileConfigStore } from '../../src/config/store';
import { repoConfigPath } from '../../src/config/paths';
import { runCli } from '../../src/cli/run';
import { ExitCode } from '../../src/core/errors';
import { SpawnGitRunner } from '../../src/git/runner';
import { GitRepo, SITE, createEngine, publish } from '../fixtures/git-repo';
import { MemoryStream } from '../helpers';

describe('git2jira status', () => {
  let repo: GitRepo;

  beforeEach(async () => {
    repo = await GitRepo.create({ branch: 'feature/LSND-1234-profile' });
  });
  afterEach(() => repo.cleanup());

  async function run(argv: string[], cwd = repo.root) {
    const container = createDefaultContainer()
      .register('gitRunner', () => new SpawnGitRunner({ env: repo.env }))
      .register(
        'configStore',
        () =>
          new FileConfigStore({
            globalPath: path.join(repo.sandbox, 'cfg', 'config.json'),
            repoPath: repoConfigPath,
          }),
      );
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();
    const exitCode = await runCli(argv, { container, cwd, stdout, stderr });
    return { exitCode, stdout: stdout.text, stderr: stderr.text };
  }

  it('previews the first report without changing anything', async () => {
    await repo.write('src/ProfileView.vue', 'v');
    repo.commitAll('view');
    await repo.write('notes with space.md', 'n');
    const before = await repo.userState();
    const { exitCode, stdout } = await run(['status']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Issue:      LSND-1234 (from branch name)');
    expect(stdout).toContain('merge base with main');
    expect(stdout).toContain('A  src/ProfileView.vue (+1 −0)');
    expect(stdout).toContain('A  notes with space.md');
    expect(stdout).toContain('including uncommitted changes');
    expect(await repo.userState()).toEqual(before);
    expect(repo.git('for-each-ref', 'refs/git2jira')).toBe('');
  });

  it('reports changes since the last published checkpoint, or nothing', async () => {
    await repo.write('a.ts', '1');
    repo.commitAll('a');
    await publish(createEngine(repo), { cwd: repo.root });
    expect((await run(['status'])).stdout).toContain(
      'No changes since the baseline. Nothing to report.',
    );

    await repo.write('b.ts', '1');
    const { stdout } = await run(['status', '--json']);
    const json = JSON.parse(stdout) as {
      site: string;
      baseline: { kind: string };
      files: { path: string }[];
    };
    expect(json.site).toBe(SITE.url);
    expect(json.baseline.kind).toBe('checkpoint');
    expect(json.files.map((f) => f.path)).toEqual(['b.ts']);
  });

  it('uses --issue and --base, and the repository base.branch setting', async () => {
    repo.git('branch', '-m', 'feature/no-key');
    repo.git('branch', 'develop', 'main');
    repo.git('switch', '-q', 'develop');
    await repo.write('d.ts', '1');
    repo.commitAll('develop');
    repo.git('switch', '-q', 'feature/no-key');
    repo.git('rebase', '-q', 'develop');

    const missing = await run(['status']);
    expect(missing.exitCode).toBe(ExitCode.Usage);
    expect(missing.stderr).toContain('--issue');

    const ambiguous = await run(['status', '--issue', 'LSND-9']);
    expect(ambiguous.exitCode).toBe(ExitCode.Usage);
    expect(ambiguous.stderr).toContain('develop');

    expect((await run(['status', '--issue', 'LSND-9', '--base', 'develop'])).stdout).toContain(
      'merge base with develop',
    );
    expect((await run(['config', 'set', 'base.branch', 'develop'])).exitCode).toBe(ExitCode.Usage);
    expect((await run(['config', 'set', 'base.branch', 'develop', '--repo'])).exitCode).toBe(0);
    expect((await run(['status', '--issue', 'LSND-9'])).stdout).toContain(
      'merge base with develop',
    );
  });

  it('explains detached HEAD and non-repositories', async () => {
    repo.git('switch', '-q', '--detach');
    const detached = await run(['status']);
    expect(detached.exitCode).toBe(ExitCode.Failure);
    expect(detached.stderr).toContain('HEAD is detached');
    const outside = await run(['status'], repo.sandbox);
    expect(outside.stderr).toContain('not inside a Git working tree');
  });

  it('rejects an invalid --site', async () => {
    const result = await run(['status', '--site', 'http://insecure.example.com']);
    expect(result.exitCode).toBe(ExitCode.Usage);
  });
});
