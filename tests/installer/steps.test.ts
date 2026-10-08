import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileConfigStore } from '../../src/config/store';
import { repoConfigPath } from '../../src/config/paths';
import type { Prompter } from '../../src/installer/prompter';
import { JiraModeStep, LanguageStep } from '../../src/installer/steps';
import type { InstallerContext } from '../../src/installer/types';
import type { ClaudeMcpRegistry, McpServerEntry } from '../../src/mcp/claude-code';
import { McpSetupService } from '../../src/mcp/setup';
import type { McpVerificationRecord } from '../../src/mcp/verification';
import { createTempDir } from '../helpers';
import path from 'node:path';

function scriptedPrompter(selects: string[], confirms: boolean[] = []) {
  const notes: string[] = [];
  const prompter: Prompter = {
    intro: () => undefined,
    outro: () => undefined,
    note: (message) => {
      notes.push(message);
    },
    select: <T extends string>() => Promise.resolve(selects.shift() as T),
    text: () => Promise.reject(new Error('unexpected text prompt')),
    password: () => Promise.reject(new Error('never ask for secrets')),
    confirm: () => Promise.resolve(confirms.shift() ?? false),
  };
  return { prompter, notes };
}

class FakeRegistry implements ClaudeMcpRegistry {
  added: string[] = [];
  constructor(
    private servers: McpServerEntry[] = [],
    private readonly installed = true,
  ) {}
  version() {
    return Promise.resolve(this.installed ? '2.1.294' : undefined);
  }
  list() {
    return Promise.resolve(this.servers);
  }
  addHttpServer(name: string, url: string) {
    this.added.push(name);
    this.servers = [
      ...this.servers,
      { name, target: url, url, health: 'needs-authentication', status: '⚠ Needs authentication' },
    ];
    return Promise.resolve();
  }
}

describe('installer steps', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let config: FileConfigStore;
  beforeEach(async () => {
    ({ dir, cleanup } = await createTempDir());
    config = new FileConfigStore({
      globalPath: path.join(dir, 'config.json'),
      repoPath: repoConfigPath,
    });
  });
  afterEach(async () => {
    await cleanup();
  });

  const run = async (
    selects: string[],
    registry: FakeRegistry,
    confirms: boolean[] = [true],
    previous?: McpVerificationRecord,
  ) => {
    const { prompter, notes } = scriptedPrompter(selects, confirms);
    const context: InstallerContext = { prompter, answers: {} };
    await new JiraModeStep(config, new McpSetupService(registry), () =>
      Promise.resolve(previous),
    ).run(context);
    return { context, notes, global: await config.readGlobal() };
  };

  it('asks for the report language and stores it', async () => {
    const { prompter } = scriptedPrompter(['uk']);
    const context: InstallerContext = { prompter, answers: {} };
    await new LanguageStep(config).run(context);
    expect((await config.readGlobal()).report?.language).toBe('uk');
    expect(context.answers.language).toBe('uk');
  });

  it('manual mode asks for no credentials and does not touch Claude Code', async () => {
    const registry = new FakeRegistry();
    const { global, context } = await run(['manual'], registry);
    expect(global.jira?.mode).toBe('manual');
    expect(context.answers.jiraMode).toBe('manual');
    expect(registry.added).toEqual([]);
  });

  it('MCP mode registers the server and says that authorization is not verified', async () => {
    const registry = new FakeRegistry();
    const { global, notes, context } = await run(['mcp'], registry);
    expect(registry.added).toEqual(['atlassian']);
    expect(global.jira?.mode).toBe('mcp');
    expect(global.mcp?.server).toBe('atlassian');
    expect(context.answers.mcpServer).toBe('atlassian');
    expect(notes.join('\n')).toMatch(/NOT verified/);
    expect(notes.join('\n')).toMatch(/\/mcp/);
  });

  it('falls back to manual when Claude Code is missing', async () => {
    const { global, context } = await run(['mcp'], new FakeRegistry([], false));
    expect(global.jira?.mode).toBe('manual');
    expect(context.answers).toMatchObject({ requestedJiraMode: 'mcp', jiraMode: 'manual' });
    expect(context.answers.fallbackReason).toMatch(/not installed/);
  });

  it('falls back to manual when the organization blocked MCP at the last check', async () => {
    const existing: McpServerEntry = {
      name: 'atlassian',
      target: 'https://mcp.atlassian.com/v2/mcp',
      url: 'https://mcp.atlassian.com/v2/mcp',
      health: 'connected',
      status: '✔ Connected',
    };
    const { global, context } = await run(['mcp'], new FakeRegistry([existing]), [], {
      schemaVersion: 1,
      verifiedAt: '2026-10-01T00:00:00.000Z',
      state: 'blocked-by-policy',
      server: 'atlassian',
      tools: {},
      sites: [],
      messages: ['Access is blocked by your organization.'],
    });
    expect(global.jira?.mode).toBe('manual');
    expect(context.answers.fallbackReason).toMatch(/blocked/);
  });

  it('falls back to manual when the user declines registration', async () => {
    const registry = new FakeRegistry();
    const { global } = await run(['mcp'], registry, [false]);
    expect(registry.added).toEqual([]);
    expect(global.jira?.mode).toBe('manual');
  });
});
