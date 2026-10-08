import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultContainer } from '../../src/app/bootstrap';
import { repoConfigPath } from '../../src/config/paths';
import { FileConfigStore } from '../../src/config/store';
import { ExitCode } from '../../src/core/errors';
import { SpawnGitRunner } from '../../src/git/runner';
import { JiraConnectionManager } from '../../src/jira/connections';
import { runCli } from '../../src/cli/run';
import { GitRepo } from '../fixtures/git-repo';
import { MemoryCredentialStore, MockJira, SITE_URL, type MockAccount } from '../fixtures/mock-jira';
import { sampleReport } from '../fixtures/publication';
import { MemoryStream } from '../helpers';

describe('Jira CLI commands', () => {
  let repo: GitRepo;
  let jira: MockJira;
  let dev: MockAccount;
  let credentials: MemoryCredentialStore;
  let configStore: FileConfigStore;

  beforeEach(async () => {
    repo = await GitRepo.create({ branch: 'feature/LSND-1234-profile' });
    jira = await MockJira.start();
    dev = jira.addAccount({
      email: 'dev@example.com',
      token: 'cli-token-xyz',
      accountId: 'acc-dev',
      displayName: 'Dev',
    });
    jira.addIssue({
      id: '10001',
      key: 'LSND-1234',
      summary: 'Profile \u001b[31mred\u001b[0m page',
    });
    credentials = new MemoryCredentialStore();
    configStore = new FileConfigStore({
      globalPath: path.join(repo.sandbox, 'cfg', 'config.json'),
      repoPath: repoConfigPath,
    });
  });
  afterEach(async () => {
    await jira.close();
    await repo.cleanup();
  });

  function container() {
    return createDefaultContainer()
      .register('gitRunner', () => new SpawnGitRunner({ env: repo.env }))
      .register('configStore', () => configStore)
      .register('credentialStore', () => credentials)
      .register(
        'jiraConnections',
        (c) =>
          new JiraConnectionManager({
            configStore: c.resolve('configStore'),
            credentialStore: c.resolve('credentialStore'),
            http: { fetch: jira.fetch, timeoutMs: 1000, retry: { maxAttempts: 1 } },
          }),
      );
  }

  async function run(argv: string[], stdin?: string, shared = container()) {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();
    const exitCode = await runCli(argv, {
      container: shared,
      cwd: repo.root,
      stdout,
      stderr,
      ...(stdin === undefined ? {} : { stdin: Readable.from([stdin]) }),
      interactive: false,
    });
    return { exitCode, stdout: stdout.text, stderr: stderr.text };
  }

  const login = (extra: string[] = []) =>
    run(
      ['login', '--site', SITE_URL, '--email', dev.email, '--token-stdin', ...extra],
      `${dev.token}\n`,
    );

  it('logs in with a token from stdin and never asks for it as an argument', async () => {
    const result = await login();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'Signed in to https://example.atlassian.net as Dev (connection "default", classic token, default)',
    );
    expect(credentials.secrets.get('jira-api-token:default')).toBe(dev.token);
    expect(await readFile(configStore.globalPath, 'utf8')).not.toContain(dev.token);

    const help = await run(['login', '--help']);
    expect(help.stdout).not.toMatch(/--token </);
  });

  it('does not re-point an existing connection at another site', async () => {
    await login();
    const result = await run(
      ['login', '--site', 'https://other.atlassian.net', '--email', dev.email, '--token-stdin'],
      'x\n',
    );
    expect(result.exitCode).toBe(ExitCode.Usage);
    expect(result.stderr).toContain('--connection <new-name>');
    expect(jira.requests.filter((r) => r.path.endsWith('/myself'))).toHaveLength(1);
  });

  it('requires --token-stdin without a terminal and reports rejected tokens', async () => {
    const noTty = await run(['login', '--site', SITE_URL, '--email', dev.email]);
    expect(noTty.exitCode).toBe(ExitCode.Usage);
    expect(noTty.stderr).toContain('--token-stdin');
    const wrong = await run(
      ['login', '--site', SITE_URL, '--email', dev.email, '--token-stdin'],
      'bad\n',
    );
    expect(wrong.exitCode).toBe(ExitCode.Failure);
    expect(wrong.stderr).toContain('did not accept');
    expect(wrong.stderr).not.toContain('bad');
    expect(credentials.secrets.size).toBe(0);
  });

  it('lists and checks connections, then logs out', async () => {
    await login(['--connection', 'work', '--project', 'LSND']);
    const list = await run(['connections', '--check']);
    expect(list.stdout).toContain(
      'work  https://example.atlassian.net  dev@example.com  (default, classic token, projects LSND)',
    );
    expect(list.stdout).toContain('signed in as Dev');

    dev.token = 'revoked';
    const json = JSON.parse((await run(['connections', '--check', '--json'])).stdout) as {
      connections: { status: { state: string } }[];
    };
    expect(json.connections[0]?.status.state).toBe('rejected');

    expect((await run(['logout'])).stdout).toContain(
      'work: token removed from the credential store.',
    );
    expect((await run(['connections', '--check'])).stdout).toContain('signed out');
    expect((await run(['logout', '--connection', 'work', '--forget'])).stdout).toContain(
      'settings removed',
    );
    expect((await run(['connections'])).stdout).toContain('No Jira connections');
  });

  it('shows the verified issue in status --jira, without terminal escapes', async () => {
    await login();
    await repo.write('a.ts', '1');
    const result = await run(['status', '--jira']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'Jira site:  https://example.atlassian.net (connection "default")',
    );
    expect(result.stdout).toContain('Jira issue: Profile �[31mred�[0m page [In Progress]');
    expect(result.stdout).not.toContain('\u001b');

    jira.issues.delete('LSND-1234');
    const missing = await run(['status', '--jira']);
    expect(missing.exitCode).toBe(ExitCode.Failure);
    expect(missing.stderr).toContain('was not found on https://example.atlassian.net');
  });

  it('works offline in status when no connection exists', async () => {
    await repo.write('a.ts', '1');
    const result = await run(['status']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Jira site:  (not configured)');
  });

  it('prints history and recovery results', async () => {
    await login();
    const shared = container();
    const service = shared.resolve('publicationService');
    await repo.write('a.ts', '1');
    const prepared = await service.prepare({ cwd: repo.root, language: 'en' });
    if (prepared.status !== 'prepared') throw new Error('expected changes');
    const reviewed = await service.review(repo.root, prepared.plan.reportId, sampleReport());
    await service.approve(repo.root, prepared.plan.reportId, reviewed.reportDigest);
    const outcome = await service.publish(repo.root, prepared.plan.reportId, reviewed.reportDigest);
    if (outcome.state !== 'PUBLISHED') throw new Error('expected publication');

    const history = await run(['history'], undefined, shared);
    expect(history.stdout).toContain('Issue LSND-1234 on https://example.atlassian.net');
    expect(history.stdout).toMatch(
      new RegExp(`#1 +published .*${outcome.commentUrl.replace(/[?]/g, '\\?')}  \\[in Jira\\]`),
    );
    const json = JSON.parse(
      (await run(['history', '--json', '--offline'], undefined, shared)).stdout,
    ) as {
      reports: { commentUrl: string; inJira: unknown }[];
    };
    expect(json.reports[0]).toMatchObject({ commentUrl: outcome.commentUrl, inJira: null });

    const recover = await run(['recover'], undefined, shared);
    expect(recover.exitCode).toBe(0);
    expect(recover.stdout).toContain('Nothing to repair.');
  });

  it('explains that history needs a connection', async () => {
    const result = await run(['history']);
    expect(result.exitCode).toBe(ExitCode.Failure);
    expect(result.stderr).toContain('git2jira login');
  });
});
