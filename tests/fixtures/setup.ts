import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoConfigPath } from '../../src/config/paths';
import { FileConfigStore } from '../../src/config/store';
import type { EnvironmentReport } from '../../src/diagnostics/environment';
import { PromptCancelledError, type Prompter } from '../../src/installer/prompter';
import { InitWizard, type WizardDependencies } from '../../src/installer/wizard';
import type { ClaudeMcpRegistry, McpServerEntry } from '../../src/mcp/claude-code';
import { McpSetupService } from '../../src/mcp/setup';
import type { McpVerificationRecord } from '../../src/mcp/verification';
import { FileSkillInstaller } from '../../src/skill/installer';
import { findSkillAssets, loadSkillPackage } from '../../src/skill/package';
import { createTempDir, must } from '../helpers';

export const ASSETS = must(findSkillAssets(path.dirname(fileURLToPath(import.meta.url))));

export function environment(overrides: Partial<EnvironmentReport> = {}): EnvironmentReport {
  return {
    os: { platform: 'darwin', release: '25.0.0', arch: 'arm64' },
    node: { version: 'v22.19.0', supported: true },
    git: { installed: true, version: '2.46.2' },
    claude: { installed: true, version: '2.1.294' },
    claudeAuth: {
      state: 'signed-in',
      method: 'claude.ai',
      billing: 'subscription',
      detail: 'claude.ai sign-in',
    },
    anthropicApiKeySet: false,
    cliOnPath: { installed: true, version: '0.0.0-test', matchesThisCli: true },
    viaNpx: false,
    ...overrides,
  };
}

export type Answer = string | boolean | Error;

/**
 * Answers prompts by matching their message. Unmatched prompts take their default.
 * Every prompt is recorded with its default, so tests can check what was pre-selected.
 */
export function scriptedPrompter(script: [RegExp, Answer][] = []) {
  const asked: { kind: string; message: string; initial: unknown }[] = [];
  const notes: { title: string; message: string }[] = [];
  const outros: string[] = [];
  const answer = (kind: string, message: string, initial: unknown): unknown => {
    asked.push({ kind, message, initial });
    const index = script.findIndex(([pattern]) => pattern.test(message));
    if (index < 0) return initial;
    const [[, value]] = script.splice(index, 1) as [[RegExp, Answer]];
    if (value instanceof Error) throw value;
    return value;
  };
  const prompter: Prompter = {
    intro: () => undefined,
    outro: (message) => {
      outros.push(message);
    },
    note: (message, title) => {
      notes.push({ title: title ?? '', message });
    },
    select: <T extends string>(
      message: string,
      _options: readonly { value: T }[],
      initialValue?: T,
    ) => Promise.resolve(answer('select', message, initialValue) as T),
    text: (message) => Promise.resolve((answer('text', message, '') as string | undefined) ?? ''),
    password: (message) => Promise.resolve(answer('password', message, '') as string),
    confirm: (message, initialValue = false) =>
      Promise.resolve(answer('confirm', message, initialValue) as boolean),
  };
  return {
    prompter,
    asked,
    notes,
    outros,
    noteText: () => notes.map((n) => `[${n.title}]\n${n.message}`).join('\n'),
  };
}

export const CANCEL = new PromptCancelledError();

export class FakeRegistry implements ClaudeMcpRegistry {
  added: { name: string; url: string; scope: string }[] = [];
  listCalls = 0;
  failAdd = false;
  constructor(
    public servers: McpServerEntry[] = [],
    private readonly installed = true,
  ) {}
  version() {
    return Promise.resolve(this.installed ? '2.1.294' : undefined);
  }
  list() {
    this.listCalls += 1;
    return Promise.resolve(this.servers);
  }
  addHttpServer(name: string, url: string, scope: string) {
    if (this.failAdd) return Promise.reject(new Error('permission denied'));
    this.added.push({ name, url, scope });
    this.servers = [
      ...this.servers,
      { name, target: url, url, health: 'needs-authentication', status: '△ Needs authentication' },
    ];
    return Promise.resolve();
  }
}

export function registered(
  name = 'atlassian',
  health: McpServerEntry['health'] = 'connected',
  url = 'https://mcp.atlassian.com/v2/mcp',
): McpServerEntry {
  return {
    name,
    target: `${url} (HTTP)`,
    url,
    health,
    status: health === 'connected' ? '✓ Connected' : '△ Needs authentication',
  };
}

export function verification(state: McpVerificationRecord['state']): McpVerificationRecord {
  return {
    schemaVersion: 1,
    verifiedAt: '2026-10-01T10:00:00.000Z',
    state,
    server: 'atlassian',
    tools: {},
    sites: [],
    messages: [state === 'blocked-by-policy' ? 'Your organization blocks this app.' : state],
  };
}

/** Real config store and Skill installer in a temp dir; everything else scripted. */
export async function createWizardHarness() {
  const { dir, cleanup } = await createTempDir();
  const config = new FileConfigStore({
    globalPath: path.join(dir, 'cfg', 'config.json'),
    repoPath: repoConfigPath,
  });
  const claudeHome = path.join(dir, 'claude');
  let skillVersion = '0.5.0';
  const installer = () =>
    new FileSkillInstaller({
      claudeHome,
      loadPackage: () => loadSkillPackage(ASSETS, skillVersion),
    });
  const logins: unknown[] = [];
  const state = {
    env: environment(),
    registry: new FakeRegistry(),
    previous: undefined as McpVerificationRecord | undefined,
    connections: [] as { name: string }[],
    loginFails: false,
  };

  const harness = {
    dir,
    config,
    claudeHome,
    state,
    logins,
    installer,
    setSkillVersion(version: string) {
      skillVersion = version;
    },
    async foreignSkill() {
      await mkdir(path.join(claudeHome, 'skills', 'jira-report'), { recursive: true });
      await writeFile(
        path.join(claudeHome, 'skills', 'jira-report', 'SKILL.md'),
        '---\nname: jira-report\n---\nsomeone else\n',
      );
    },
    async run(script: [RegExp, Answer][] = [], options: Parameters<InitWizard['run']>[0] = {}) {
      const ui = scriptedPrompter(script);
      const deps: WizardDependencies = {
        prompter: ui.prompter,
        config,
        environment: () => Promise.resolve(state.env),
        mcp: new McpSetupService(state.registry),
        lastVerification: () => Promise.resolve(state.previous),
        skill: installer(),
        connections: {
          list: () =>
            Promise.resolve({ connections: state.connections, defaultConnection: undefined }),
          login: (input) => {
            logins.push(input);
            if (state.loginFails) return Promise.reject(new Error('401 Unauthorized'));
            return Promise.resolve({
              connection: {
                name: input.name,
                config: { siteUrl: input.siteUrl, authMethod: 'api-token' as const },
                site: { id: 'x', url: input.siteUrl },
              },
              user: { accountId: 'a', displayName: 'Dev' },
              isDefault: true,
            } as never);
          },
        },
        doctor: () =>
          Promise.resolve({
            results: [{ title: 'Stub', result: { status: 'pass' as const, message: 'ok' } }],
            summary: { ok: true, text: 'All applicable checks passed.' },
          }),
      };
      const outcome = await new InitWizard(deps).run(options);
      return { outcome, ui, global: await config.readGlobal() };
    },
    cleanup,
  };
  return harness;
}

export type WizardHarness = Awaited<ReturnType<typeof createWizardHarness>>;
