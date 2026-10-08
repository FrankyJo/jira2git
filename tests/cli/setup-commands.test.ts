import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultContainer } from '../../src/app/bootstrap';
import { repoConfigPath } from '../../src/config/paths';
import { FileConfigStore } from '../../src/config/store';
import { ExitCode } from '../../src/core/errors';
import type { ProcessRunner } from '../../src/core/process';
import { runCli } from '../../src/cli/run';
import { EnvironmentProbe } from '../../src/diagnostics/environment';
import { SpawnGitRunner } from '../../src/git/runner';
import { McpVerificationStore } from '../../src/mcp/setup';
import { FileSkillInstaller } from '../../src/skill/installer';
import { loadSkillPackage } from '../../src/skill/package';
import { GitRepo } from '../fixtures/git-repo';
import { MemoryCredentialStore } from '../fixtures/mock-jira';
import { sampleContent } from '../fixtures/publication';
import { ASSETS, FakeRegistry } from '../fixtures/setup';
import { MemoryStream } from '../helpers';

describe('setup commands (init, doctor, uninstall)', () => {
  let repo: GitRepo;
  let configStore: FileConfigStore;
  let credentials: MemoryCredentialStore;
  let registry: FakeRegistry;
  let opened: string[];
  const cfgDir = () => path.join(repo.sandbox, 'cfg');
  const claudeHome = () => path.join(repo.sandbox, 'claude');

  beforeEach(async () => {
    repo = await GitRepo.create({ branch: 'feature/LSND-1234-profile' });
    configStore = new FileConfigStore({
      globalPath: path.join(cfgDir(), 'config.json'),
      repoPath: repoConfigPath,
    });
    credentials = new MemoryCredentialStore();
    registry = new FakeRegistry();
    opened = [];
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  /** Version commands answer like an installed toolchain; browser openers are recorded. */
  const processes: ProcessRunner = {
    run: (file, args) => {
      const key = [file, ...args].join(' ');
      const answers: Record<string, string> = {
        'git --version': 'git version 2.46.2',
        'claude --version': '2.1.294 (Claude Code)',
        'claude auth status --json': JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
        'git2jira --version': '0.0.0-test',
      };
      if (['open', 'xdg-open', 'rundll32'].includes(file)) opened.push(args.at(-1) ?? '');
      const stdout = answers[key];
      const known = stdout !== undefined || ['open', 'xdg-open', 'rundll32'].includes(file);
      return Promise.resolve({
        stdout: stdout ?? '',
        stderr: '',
        exitCode: known ? 0 : null,
        notFound: !known,
        timedOut: false,
      });
    },
  };

  function container() {
    return createDefaultContainer()
      .register('gitRunner', () => new SpawnGitRunner({ env: repo.env }))
      .register('configStore', () => configStore)
      .register('credentialStore', () => credentials)
      .register('processRunner', () => processes)
      .register('claudeMcpRegistry', () => registry)
      .register('pathEnvironment', () => ({
        env: { GIT2JIRA_CONFIG_DIR: cfgDir() },
        platform: 'darwin',
        homeDir: repo.sandbox,
      }))
      .register(
        'mcpVerificationStore',
        () => new McpVerificationStore(path.join(cfgDir(), 'mcp-verification.json')),
      )
      .register(
        'skillInstaller',
        () =>
          new FileSkillInstaller({
            claudeHome: claudeHome(),
            loadPackage: () => loadSkillPackage(ASSETS, '0.0.0-test'),
          }),
      )
      .register(
        'environmentProbe',
        (c) =>
          new EnvironmentProbe({
            runner: c.resolve('processRunner'),
            env: {},
            platform: 'darwin',
            release: '25.0.0',
            arch: 'arm64',
            nodeVersion: 'v22.19.0',
            cliVersion: '0.0.0-test',
          }),
      );
  }

  async function run(
    argv: string[],
    options: { cwd?: string; stdin?: unknown; interactive?: boolean } = {},
  ) {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();
    const input = options.stdin === undefined ? undefined : JSON.stringify(options.stdin);
    const exitCode = await runCli(argv, {
      container: container(),
      cwd: options.cwd ?? repo.root,
      stdout,
      stderr,
      interactive: options.interactive ?? false,
      ...(input === undefined ? {} : { stdin: [Buffer.from(input)] as never }),
    });
    return { exitCode, stdout: stdout.text, stderr: stderr.text };
  }

  it('init needs a terminal unless --yes is given', async () => {
    const result = await run(['init']);
    expect(result.exitCode).toBe(ExitCode.Usage);
    expect(result.stderr).toContain('--yes');
    await expect(access(configStore.globalPath)).rejects.toThrow();
  });

  it('init --yes sets up manual mode in Ukrainian, installs /jira-report, and runs doctor', async () => {
    const result = await run(['init', '--yes', '--mode', 'manual', '--language', 'uk']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Git2Jira AI is ready!');
    expect(result.stdout).toContain('Report language: Ukrainian (uk)');
    expect((await run(['config', 'get', 'report.language'])).stdout.trim()).toBe('uk');
    expect((await run(['config', 'get', 'jira.mode'])).stdout.trim()).toBe('manual');
    await access(path.join(claudeHome(), 'skills', 'jira-report', 'SKILL.md'));
    expect(credentials.secrets.size).toBe(0);
    expect(registry.added).toEqual([]);

    // Manual mode now works end to end without any Jira credentials.
    await repo.write('src/a.ts', 'export const a = 1;\n');
    const prepared = JSON.parse((await run(['report', 'prepare', '--json'])).stdout) as {
      reportId: string;
      language: string;
    };
    expect(prepared.language).toBe('uk');
    const submitted = await run(
      ['report', 'submit', '--report', prepared.reportId, '--json', '--input', '-'],
      { stdin: sampleContent('uk', {}, ['src/a.ts']) },
    );
    expect(submitted.exitCode).toBe(0);
  });

  it('init --yes --mode mcp registers the official server for the user and keeps others intact', async () => {
    registry.servers = [
      {
        name: 'github',
        target: 'https://api.github.com/mcp (HTTP)',
        url: 'https://api.github.com/mcp',
        health: 'connected',
        status: '✓ Connected',
      },
    ];
    const result = await run(['init', '--yes', '--mode', 'mcp', '--skip-skill']);
    expect(result.exitCode).toBe(0);
    expect(registry.added).toEqual([
      { name: 'atlassian', url: 'https://mcp.atlassian.com/v2/mcp', scope: 'user' },
    ]);
    expect(registry.servers.map((s) => s.name)).toEqual(['github', 'atlassian']);
    expect(result.stdout).toContain('Not authorized yet: run /mcp in Claude Code.');
    expect(result.stdout).not.toContain('Git2Jira AI is ready!');
    const doctor = JSON.parse((await run(['doctor', '--json'])).stdout) as {
      checks: { id: string; status: string }[];
    };
    const status = Object.fromEntries(doctor.checks.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({
      'mcp-installed': 'pass',
      'mcp-authenticated': 'warn',
      'jira-read': 'warn',
      'jira-write': 'warn',
      skill: 'fail',
    });
  });

  it('doctor prints every check and exits non-zero only on failures', async () => {
    const before = await run(['doctor']);
    expect(before.exitCode).toBe(1);
    expect(before.stdout).toContain('✖ /jira-report Skill: not installed');
    expect(before.stdout).toContain('→ Run "git2jira skill install".');
    await run(['skill', 'install']);
    const after = await run(['doctor']);
    expect(after.exitCode).toBe(0);
    expect(after.stdout).toContain('All applicable checks passed.');
  });

  it('uninstall removes the Skill, API tokens, and configuration, and leaves MCP and repositories alone', async () => {
    await run(['skill', 'install']);
    await configStore.writeGlobal({
      report: { language: 'uk' },
      jira: {
        mode: 'mcp',
        connections: { work: { siteUrl: 'https://x.atlassian.net', authMethod: 'api-token' } },
      },
      mcp: { server: 'atlassian' },
    });
    credentials.secrets.set('jira-api-token:work', 'secret');
    expect((await run(['uninstall'])).exitCode).toBe(ExitCode.Usage);

    const result = await run(['uninstall', '--yes']);
    expect(result.exitCode).toBe(0);
    expect(credentials.secrets.size).toBe(0);
    await expect(access(configStore.globalPath)).rejects.toThrow();
    await expect(access(path.join(claudeHome(), 'skills', 'jira-report'))).rejects.toThrow();
    expect(result.stdout).toContain('claude mcp remove "atlassian" --scope user');
    expect(result.stdout).toContain('npm uninstall -g git2jira-ai');
    expect(registry.added).toEqual([]);
  });

  it('login explains that MCP authorization happens in Claude Code', async () => {
    await configStore.writeGlobal({ jira: { mode: 'mcp' } });
    const result = await run(['login']);
    expect(result.stderr).toContain(
      'Atlassian MCP is authorized with OAuth in Claude Code (/mcp → Authenticate)',
    );
    expect((await run(['login', '--help'])).stdout).toContain('need no "git2jira login"');
  });

  it('honours report.includeUncommitted = false and keeps that work for a later report', async () => {
    expect((await run(['config', 'set', 'report.includeUncommitted', 'false'])).exitCode).toBe(0);
    expect((await run(['config', 'set', 'report.includeUncommitted', 'maybe'])).exitCode).toBe(
      ExitCode.Usage,
    );
    await repo.write('src/committed.ts', 'c\n');
    repo.commitAll('committed work');
    await repo.write('src/draft.ts', 'uncommitted\n');
    const first = JSON.parse(
      (await run(['report', 'prepare', '--json', '--mode', 'manual'])).stdout,
    ) as {
      reportId: string;
      files: { path: string }[];
      includesUncommittedChanges: boolean;
    };
    expect(first.files.map((f) => f.path)).toEqual(['src/committed.ts']);
    expect(first.includesUncommittedChanges).toBe(false);
    const submitted = JSON.parse(
      (
        await run(['report', 'submit', '--report', first.reportId, '--json', '--input', '-'], {
          stdin: sampleContent('en', {}, ['src/committed.ts']),
        })
      ).stdout,
    ) as { reportDigest: string };
    await run([
      'report',
      'confirm',
      '--report',
      first.reportId,
      '--digest',
      submitted.reportDigest,
      '--attest-manual-publication',
    ]);

    repo.commitAll('commit the draft');
    const second = JSON.parse(
      (await run(['report', 'prepare', '--json', '--mode', 'manual'])).stdout,
    ) as {
      files: { path: string }[];
    };
    expect(second.files.map((f) => f.path)).toEqual(['src/draft.ts']);
  });

  it('validates and stores the other settings', async () => {
    expect((await run(['config', 'set', 'report.testCommand', 'pnpm test'])).exitCode).toBe(0);
    expect(
      (await run(['config', 'set', 'report.testCommand', 'pnpm test; rm -rf ~'])).exitCode,
    ).toBe(ExitCode.Usage);
    expect(
      (await run(['config', 'set', 'report.testCommand', 'pnpm test', '--repo'])).exitCode,
    ).toBe(ExitCode.Usage);
    expect((await run(['config', 'set', 'jira.openAfterPublish', 'yes'])).exitCode).toBe(0);
    expect((await run(['config', 'get', 'jira.openAfterPublish'])).stdout.trim()).toBe('true');
    expect(JSON.parse(await readFile(configStore.globalPath, 'utf8'))).toMatchObject({
      report: { testCommand: 'pnpm test' },
      jira: { openAfterPublish: true },
    });
  });

  it('report open shows the Jira issue for a manual report on a configured site', async () => {
    await configStore.writeGlobal({ jira: { site: 'https://example.atlassian.net' } });
    await repo.write('src/a.ts', 'x\n');
    const prepared = JSON.parse(
      (await run(['report', 'prepare', '--json', '--mode', 'manual'])).stdout,
    ) as {
      reportId: string;
    };
    const printed = await run(['report', 'open', '--report', prepared.reportId, '--print']);
    expect(printed.stdout.trim()).toBe('https://example.atlassian.net/browse/LSND-1234');
    await run(['report', 'open', '--report', prepared.reportId]);
    expect(opened).toEqual(['https://example.atlassian.net/browse/LSND-1234']);
  });

  it('runs outside any Git repository', async () => {
    const outside = repo.sandbox;
    expect((await run(['config', 'set', 'report.language', 'uk'], { cwd: outside })).exitCode).toBe(
      0,
    );
    expect((await run(['skill', 'install'], { cwd: outside })).exitCode).toBe(0);
    const doctor = await run(['doctor', '--json'], { cwd: outside });
    expect(JSON.parse(doctor.stdout)).toMatchObject({ ok: true });
  });
});
