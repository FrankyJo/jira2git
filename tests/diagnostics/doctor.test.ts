import { describe, expect, it } from 'vitest';
import type { GlobalConfig } from '../../src/config/schema';
import type { ProcessResult, ProcessRunner } from '../../src/core/process';
import {
  SequentialDiagnosticsRunner,
  doctorChecks,
  doctorSummary,
  type DoctorInputs,
} from '../../src/diagnostics/checks';
import { EnvironmentProbe, nodeSupported } from '../../src/diagnostics/environment';
import type { McpRegistrationState } from '../../src/mcp/setup';
import type { McpVerificationRecord } from '../../src/mcp/verification';
import type { SkillInstallState } from '../../src/skill/types';
import { environment, registered, verification } from '../fixtures/setup';

const location = {
  skillDir: '/h/.claude/skills/jira-report',
  agentPath: '/h/.claude/agents/jira-reporter.md',
};

function inputs(
  overrides: {
    env?: Parameters<typeof environment>[0];
    global?: GlobalConfig;
    skill?: SkillInstallState;
    registration?: McpRegistrationState;
    last?: McpVerificationRecord;
    store?: { available: boolean; backend: string };
    connections?: string[];
  } = {},
): DoctorInputs {
  const global = overrides.global ?? {};
  return {
    cliVersion: '0.0.0-test',
    environment: () => Promise.resolve(environment(overrides.env)),
    skill: () =>
      Promise.resolve(
        overrides.skill ?? { ...location, state: 'installed', version: '0.0.0-test' },
      ),
    config: () =>
      Promise.resolve({ global, repo: {}, globalPath: '/h/.config/git2jira/config.json' }),
    language: (g) => ({
      language: g.report?.language ?? 'en',
      source: g.report?.language ? 'global' : 'default',
    }),
    mode: (g) => ({ mode: g.jira?.mode ?? 'manual', source: g.jira?.mode ? 'global' : 'default' }),
    credentialStore: () =>
      Promise.resolve(overrides.store ?? { available: true, backend: 'macos-keychain' }),
    connections: () => Promise.resolve(overrides.connections ?? []),
    mcpRegistration: () =>
      Promise.resolve(
        overrides.registration ?? { kind: 'registered', entry: registered(), official: true },
      ),
    lastVerification: () => Promise.resolve(overrides.last),
  };
}

async function doctor(i: DoctorInputs) {
  const results = await new SequentialDiagnosticsRunner().run(doctorChecks(i));
  const byId = Object.fromEntries(results.map((r) => [r.check.id, r.result]));
  return { byId, summary: doctorSummary(results) };
}

const MCP: GlobalConfig = { jira: { mode: 'mcp' }, mcp: { server: 'atlassian' } };

describe('git2jira doctor', () => {
  it('passes a complete manual setup and skips what manual mode does not use', async () => {
    const { byId, summary } = await doctor(inputs());
    for (const id of [
      'cli',
      'os',
      'git',
      'claude',
      'claude-auth',
      'skill',
      'config',
      'language',
      'mode',
    ]) {
      expect(byId[id]?.status, id).toBe('pass');
    }
    for (const id of [
      'credentials',
      'mcp-installed',
      'mcp-authenticated',
      'jira-read',
      'jira-write',
    ]) {
      expect(byId[id]?.status, id).toBe('skip');
    }
    expect(summary).toEqual({ ok: true, text: 'All applicable checks passed.' });
  });

  it('fails without Claude Code or Git, with official guidance', async () => {
    const { byId, summary } = await doctor(
      inputs({
        env: {
          claude: { installed: false },
          claudeAuth: { state: 'not-installed' },
          git: { installed: false },
        },
      }),
    );
    expect(byId.claude).toMatchObject({
      status: 'fail',
      remedy: expect.stringContaining('claude-code/setup') as string,
    });
    expect(byId.git).toMatchObject({
      status: 'fail',
      remedy: expect.stringContaining('git-scm.com') as string,
    });
    expect(byId['claude-auth']?.status).toBe('skip');
    expect(summary.ok).toBe(false);
  });

  it('warns when Claude Code is signed out or would bill an API account', async () => {
    expect(
      (await doctor(inputs({ env: { claudeAuth: { state: 'signed-out' } } }))).byId['claude-auth'],
    ).toMatchObject({
      status: 'warn',
      remedy: expect.stringContaining('claude auth login') as string,
    });
    expect(
      (await doctor(inputs({ env: { anthropicApiKeySet: true } }))).byId['claude-auth'],
    ).toMatchObject({
      status: 'warn',
      remedy: expect.stringContaining('ANTHROPIC_API_KEY') as string,
    });
  });

  it('fails when /jira-report could not find the CLI on PATH, and warns on a version mismatch', async () => {
    const missing = await doctor(
      inputs({ env: { cliOnPath: { installed: false, matchesThisCli: false }, viaNpx: true } }),
    );
    expect(missing.byId.cli).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('through npx') as string,
    });
    const other = await doctor(
      inputs({ env: { cliOnPath: { installed: true, version: '0.1.0', matchesThisCli: false } } }),
    );
    expect(other.byId.cli?.status).toBe('warn');
  });

  it('reports Skill problems', async () => {
    expect(
      (await doctor(inputs({ skill: { ...location, state: 'not-installed' } }))).byId.skill?.status,
    ).toBe('fail');
    expect(
      (
        await doctor(
          inputs({ skill: { ...location, state: 'conflict', reason: 'foreign', paths: ['/x'] } }),
        )
      ).byId.skill?.status,
    ).toBe('fail');
    expect(
      (
        await doctor(
          inputs({
            skill: {
              ...location,
              state: 'outdated',
              installedVersion: '0.4.0',
              currentVersion: '0.5.0',
            },
          }),
        )
      ).byId.skill?.status,
    ).toBe('warn');
  });

  describe('MCP mode keeps four facts apart', () => {
    it('registered but OAuth not completed', async () => {
      const { byId, summary } = await doctor(
        inputs({
          global: MCP,
          registration: {
            kind: 'registered',
            entry: registered('atlassian', 'needs-authentication'),
            official: true,
          },
        }),
      );
      expect(byId['mcp-installed']?.status).toBe('pass');
      expect(byId['mcp-authenticated']).toMatchObject({
        status: 'warn',
        remedy: expect.stringContaining('/mcp') as string,
      });
      expect(byId['jira-read']).toMatchObject({ status: 'warn', message: 'not verified yet' });
      expect(byId['jira-write']?.status).toBe('warn');
      expect(summary.text).not.toBe('All applicable checks passed.');
      expect(summary.text).toMatch(/could not be verified/);
    });

    it('authorized with read and write access', async () => {
      const { byId, summary } = await doctor(inputs({ global: MCP, last: verification('ready') }));
      expect(byId['mcp-authenticated']).toMatchObject({
        status: 'pass',
        message: expect.stringContaining('Claude Code reports') as string,
      });
      expect(byId['jira-read']?.status).toBe('pass');
      expect(byId['jira-write']).toMatchObject({
        status: 'pass',
        message: expect.stringContaining('confirmed by the first publication') as string,
      });
      expect(summary.ok).toBe(true);
    });

    it('read-only access', async () => {
      const { byId } = await doctor(inputs({ global: MCP, last: verification('read-only') }));
      expect(byId['jira-read']?.status).toBe('pass');
      expect(byId['jira-write']).toMatchObject({
        status: 'warn',
        remedy: expect.stringContaining('manual mode') as string,
      });
    });

    it('blocked by an organization policy', async () => {
      const { byId, summary } = await doctor(
        inputs({ global: MCP, last: verification('blocked-by-policy') }),
      );
      expect(byId['jira-read']).toMatchObject({
        status: 'fail',
        remedy: expect.stringContaining('jira.mode manual') as string,
      });
      expect(summary.ok).toBe(false);
    });

    it('authorization rejected at the last check', async () => {
      const { byId } = await doctor(
        inputs({ global: MCP, last: verification('not-authenticated') }),
      );
      expect(byId['jira-read']).toMatchObject({
        status: 'warn',
        remedy: expect.stringContaining('/mcp') as string,
      });
    });

    it('no server registered', async () => {
      const { byId } = await doctor(
        inputs({
          global: MCP,
          registration: { kind: 'not-registered', suggestedName: 'atlassian' },
        }),
      );
      expect(byId['mcp-installed']).toMatchObject({
        status: 'fail',
        remedy: 'Run "git2jira mcp setup".',
      });
      expect(byId['mcp-authenticated']?.status).toBe('skip');
    });
  });

  it('checks secure credential storage only in API-token mode', async () => {
    const global: GlobalConfig = { jira: { mode: 'api-token' } };
    expect((await doctor(inputs({ global }))).byId.credentials).toMatchObject({
      status: 'fail',
      remedy: 'Run "git2jira login".',
    });
    expect((await doctor(inputs({ global, connections: ['work'] }))).byId.credentials?.status).toBe(
      'pass',
    );
    expect(
      (await doctor(inputs({ global, store: { available: false, backend: 'secret-service' } })))
        .byId.credentials?.status,
    ).toBe('fail');
  });

  it('turns a crashing check into a failure instead of hiding it', async () => {
    const broken = { ...inputs(), skill: () => Promise.reject(new Error('boom')) };
    expect((await doctor(broken)).byId.skill).toMatchObject({
      status: 'fail',
      message: 'check failed: boom',
    });
  });
});

describe('environment probe', () => {
  function runner(
    responses: Record<string, Partial<ProcessResult>>,
  ): ProcessRunner & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      run: (file, args) => {
        const key = [file, ...args].join(' ');
        calls.push(key);
        const r = responses[key];
        return Promise.resolve({
          stdout: '',
          stderr: '',
          exitCode: r ? 0 : null,
          notFound: !r,
          timedOut: false,
          ...r,
        });
      },
    };
  }
  const probe = (r: ProcessRunner, env: Record<string, string> = {}, scriptPath?: string) =>
    new EnvironmentProbe({
      runner: r,
      env,
      platform: 'linux',
      release: '6.1',
      arch: 'x64',
      nodeVersion: 'v22.12.0',
      cliVersion: '0.5.0',
      scriptPath,
    });

  it('reads versions and a subscription sign-in, and never reads Claude Code files', async () => {
    const r = runner({
      'git --version': { stdout: 'git version 2.46.2\n' },
      'claude --version': { stdout: '2.1.294 (Claude Code)\n' },
      'claude auth status --json': {
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          subscriptionType: 'max',
        }),
      },
      'git2jira --version': { stdout: '0.5.0\n' },
    });
    const report = await probe(r).inspect();
    expect(report).toMatchObject({
      git: { installed: true, version: '2.46.2' },
      claude: { installed: true, version: '2.1.294' },
      claudeAuth: {
        state: 'signed-in',
        billing: 'subscription',
        detail: 'claude.ai sign-in (max)',
      },
      cliOnPath: { installed: true, matchesThisCli: true },
      anthropicApiKeySet: false,
      viaNpx: false,
      node: { supported: true },
    });
    expect(r.calls.sort()).toEqual([
      'claude --version',
      'claude auth status --json',
      'git --version',
      'git2jira --version',
    ]);
  });

  it('detects API billing, a signed-out Claude Code, missing tools, and npx', async () => {
    const api = await probe(
      runner({
        'claude --version': { stdout: '2.1.294' },
        'claude auth status --json': {
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: 'api_key',
            apiKeySource: 'ANTHROPIC_API_KEY',
          }),
        },
      }),
      { ANTHROPIC_API_KEY: 'x' },
      '/home/u/.npm/_npx/abc/node_modules/git2jira-ai/dist/cli.js',
    ).inspect();
    expect(api.claudeAuth).toMatchObject({ state: 'signed-in', billing: 'api' });
    expect(api).toMatchObject({
      anthropicApiKeySet: true,
      viaNpx: true,
      git: { installed: false },
      cliOnPath: { installed: false },
    });

    const out = await probe(
      runner({
        'claude --version': { stdout: '2.1.294' },
        'claude auth status --json': { stdout: '{"loggedIn":false}' },
      }),
    ).inspect();
    expect(out.claudeAuth).toEqual({ state: 'signed-out' });

    const missing = await probe(runner({})).inspect();
    expect(missing.claudeAuth).toEqual({ state: 'not-installed' });
  });

  it.each([
    ['v22.12.0', true],
    ['v22.11.9', false],
    ['v24.0.0', true],
    ['v20.18.0', false],
  ])('Node.js %s supported: %s', (version, expected) => {
    expect(nodeSupported(version)).toBe(expected);
  });
});
