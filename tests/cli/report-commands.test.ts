import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultContainer } from '../../src/app/bootstrap';
import { repoConfigPath } from '../../src/config/paths';
import { FileConfigStore } from '../../src/config/store';
import { ExitCode } from '../../src/core/errors';
import type { CredentialStore } from '../../src/credentials/types';
import { SpawnGitRunner } from '../../src/git/runner';
import { runCli } from '../../src/cli/run';
import type { ClaudeMcpRegistry } from '../../src/mcp/claude-code';
import { McpVerificationStore } from '../../src/mcp/setup';
import { GitRepo } from '../fixtures/git-repo';
import { CLOUD_ID, issueLookup } from '../fixtures/delivery';
import { ISSUE, sampleReport } from '../fixtures/publication';
import { MemoryStream } from '../helpers';

/** Any use of credentials or Jira connections fails the test. */
const NO_CREDENTIALS: CredentialStore = new Proxy({} as CredentialStore, {
  get: () => () => {
    throw new Error('credentials must not be used');
  },
});

describe('report and mcp commands', () => {
  let repo: GitRepo;
  let configStore: FileConfigStore;
  let registry: ClaudeMcpRegistry & { added: string[] };

  beforeEach(async () => {
    repo = await GitRepo.create({ branch: `feature/${ISSUE}-profile` });
    configStore = new FileConfigStore({
      globalPath: path.join(repo.sandbox, 'cfg', 'config.json'),
      repoPath: repoConfigPath,
    });
    registry = {
      added: [],
      version: () => Promise.resolve('2.1.294'),
      list: () => Promise.resolve([]),
      addHttpServer(name: string) {
        this.added.push(name);
        return Promise.resolve();
      },
    };
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  function container() {
    return createDefaultContainer()
      .register('gitRunner', () => new SpawnGitRunner({ env: repo.env }))
      .register('configStore', () => configStore)
      .register('credentialStore', () => NO_CREDENTIALS)
      .register('jiraConnections', () => {
        throw new Error('Jira connections must not be used');
      })
      .register('claudeMcpRegistry', () => registry)
      .register(
        'mcpVerificationStore',
        () => new McpVerificationStore(path.join(repo.sandbox, 'cfg', 'mcp-verification.json')),
      );
  }

  async function run(argv: string[], shared = container()) {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();
    const exitCode = await runCli(argv, {
      container: shared,
      cwd: repo.root,
      stdout,
      stderr,
      interactive: false,
    });
    return { exitCode, stdout: stdout.text, stderr: stderr.text };
  }

  async function json(file: string, value: unknown): Promise<string> {
    const target = path.join(repo.sandbox, file);
    await writeFile(target, JSON.stringify(value));
    return target;
  }

  it('runs the manual flow end to end without any Jira authentication', async () => {
    await repo.write('src/a.ts', 'export const a = 1;\n');
    const prepared = await run(['report', 'prepare', '--json']);
    expect(prepared.exitCode).toBe(0);
    const request = JSON.parse(prepared.stdout) as {
      reportId: string;
      mode: string;
      untrusted: { patch: string };
    };
    expect(request.mode).toBe('manual');
    expect(request.untrusted.patch).toContain('export const a = 1;');

    const submitted = await run([
      'report',
      'submit',
      '--report',
      request.reportId,
      '--input',
      await json('r.json', sampleReport('en')),
    ]);
    expect(submitted.exitCode).toBe(0);
    expect(submitted.stdout).toContain('### Summary');
    const digest = /Digest: ([0-9a-f]{64})/.exec(submitted.stdout)?.[1] ?? '';

    const exported = await run(['report', 'export']);
    expect(exported.stdout).toMatch(/Wrote report #1 to .*LSND-1234-report-1-en\.md/);
    expect(exported.stdout).toContain(
      `git2jira report confirm --report ${request.reportId} --digest ${digest}`,
    );

    // Without a terminal, confirmation needs the explicit attestation flag.
    const refused = await run([
      'report',
      'confirm',
      '--report',
      request.reportId,
      '--digest',
      digest,
    ]);
    expect(refused.exitCode).toBe(ExitCode.Usage);
    const pending = await run(['report', 'pending', '--json']);
    expect(JSON.parse(pending.stdout)).toEqual([
      expect.objectContaining({ status: 'AWAITING_MANUAL_CONFIRMATION', confirmation: null }),
    ]);

    const confirmed = await run([
      'report',
      'confirm',
      '--report',
      request.reportId,
      '--digest',
      digest,
      '--attest-manual-publication',
    ]);
    expect(confirmed.exitCode).toBe(0);
    expect(confirmed.stdout).toContain('user-attested, not verified in Jira');
    expect((await run(['report', 'pending'])).stdout).toContain('No pending reports.');
    expect((await run(['report', 'prepare'])).stdout).toContain('Nothing to report.');
  });

  it('switches modes through configuration and honours --language', async () => {
    expect((await run(['config', 'get', 'jira.mode'])).stdout.trim()).toBe('manual');
    expect((await run(['config', 'set', 'jira.mode', 'mcp'])).exitCode).toBe(0);
    expect((await configStore.readGlobal()).jira?.mode).toBe('mcp');
    expect((await run(['config', 'set', 'jira.mode', 'telepathy'])).exitCode).toBe(ExitCode.Usage);
    expect((await run(['config', 'set', 'jira.mode', 'manual', '--repo'])).exitCode).toBe(0);
    expect((await run(['config', 'get', 'jira.mode', '--json'])).stdout).toContain(
      '"source":"repository"',
    );

    await repo.write('src/a.ts', 'x\n');
    const prepared = await run(['report', 'prepare', '--language', 'uk', '--json']);
    expect(JSON.parse(prepared.stdout)).toMatchObject({ mode: 'manual', language: 'uk' });
  });

  it('MCP mode needs the Skill-provided lookup, and never falls back silently', async () => {
    await repo.write('src/a.ts', 'x\n');
    await run(['config', 'set', 'jira.mode', 'mcp']);
    const noSite = await run(['report', 'prepare']);
    expect(noSite.exitCode).toBe(ExitCode.Usage);
    expect(noSite.stderr).toMatch(/needs the Jira site/);
    const noLookup = await run(['report', 'prepare', '--site', 'https://example.atlassian.net']);
    expect(noLookup.exitCode).toBe(ExitCode.Usage);
    expect(noLookup.stderr).toMatch(/cannot use the MCP authorization/);
    expect((await run(['report', 'pending', '--json'])).stdout.trim()).toBe('[]');

    const prepared = await run([
      'report',
      'prepare',
      '--site',
      'https://example.atlassian.net',
      '--cloud-id',
      CLOUD_ID,
      '--issue-lookup',
      await json('issue.json', issueLookup()),
      '--language',
      'uk',
      '--json',
    ]);
    expect(prepared.exitCode).toBe(0);
    expect(JSON.parse(prepared.stdout)).toMatchObject({
      mode: 'mcp',
      language: 'uk',
      cloudId: CLOUD_ID,
    });
  });

  it('leaves API-token reports to the interactive "report" command', async () => {
    await repo.write('src/a.ts', 'x\n');
    const result = await run(['report', 'prepare', '--mode', 'api-token']);
    expect(result.exitCode).toBe(ExitCode.Usage);
    expect(result.stderr).toContain('git2jira report --mode api-token');
  });

  it('registers MCP and records a verification, without claiming authorization', async () => {
    const setup = await run(['mcp', 'setup', '--yes']);
    expect(setup.exitCode).toBe(0);
    expect(registry.added).toEqual(['atlassian']);
    expect(setup.stdout).toMatch(/cannot see whether the sign-in succeeded/);
    expect((await configStore.readGlobal()).mcp?.server).toBe('atlassian');

    const verify = await run([
      'mcp',
      'verify',
      '--input',
      await json('probe.json', { schemaVersion: 1, tools: ['Read'], server: 'atlassian' }),
    ]);
    expect(verify.stdout).toContain('MCP access: no-tools');
    expect(verify.stdout).toContain('Manual mode works without any Jira access');
    const status = await run(['mcp', 'status']);
    expect(status.stdout).toContain('Last verification: no-tools');
    expect(status.stdout).toContain('no Atlassian MCP server registered');
  });
});
