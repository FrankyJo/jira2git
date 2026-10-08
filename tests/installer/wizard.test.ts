import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CANCEL,
  createWizardHarness,
  environment,
  FakeRegistry,
  registered,
  verification,
  type WizardHarness,
} from '../fixtures/setup';

const MODE = /How would you like to work with Jira\?/;
const LANGUAGE = /Which language should Git2Jira AI use for Jira reports\?/;
const REGISTER = /Register the official Atlassian Rovo MCP server/;
const APPLY = /Apply this configuration\?/;

describe('git2jira init wizard', () => {
  let h: WizardHarness;
  beforeEach(async () => {
    h = await createWizardHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const skillInstalled = () =>
    access(path.join(h.claudeHome, 'skills', 'jira-report', 'SKILL.md')).then(
      () => true,
      () => false,
    );

  describe('fresh install', () => {
    it('welcomes, checks the environment, asks the mandatory questions, and applies on confirmation', async () => {
      const { outcome, ui, global } = await h.run([
        [MODE, 'manual'],
        [LANGUAGE, 'en'],
      ]);
      expect(outcome).toMatchObject({ status: 'completed', mode: 'manual', language: 'en' });
      expect(global).toMatchObject({ report: { language: 'en' }, jira: { mode: 'manual' } });
      expect(await skillInstalled()).toBe(true);
      expect(outcome.skill).toMatchObject({ action: 'installed' });

      const text = ui.noteText();
      expect(text).toContain('Generate incremental Jira implementation reports with Claude Code.');
      expect(text).toContain('Claude Code 2.1.294');
      expect(text).toContain('No previous Git2Jira installation found.');
      expect(text).toContain('No API tokens or Jira authorization required.');
      expect(text).toContain("company's approval of Rovo MCP");
      expect(text).toMatch(/1\. Open any Git repository\.[\s\S]*4\. Run \/jira-report/);
      expect(ui.outros).toEqual(['Git2Jira AI is ready!']);
      // The language question is always asked and defaults to English.
      expect(
        ui.asked.find((q) =>
          q.message.includes('Which language should Git2Jira AI use for Jira reports?'),
        )?.initial,
      ).toBe('en');
    });

    it('offers MCP first and preselects it when Claude Code is available', async () => {
      const { ui } = await h.run([[MODE, 'manual']]);
      expect(
        ui.asked.find((q) => q.message.includes('How would you like to work with Jira?'))?.initial,
      ).toBe('mcp');
    });
  });

  describe('environment', () => {
    it('defaults to manual and explains the install when Claude Code is missing', async () => {
      h.state.env = environment({
        claude: { installed: false },
        claudeAuth: { state: 'not-installed' },
      });
      h.state.registry = new FakeRegistry([], false);
      const { outcome, ui, global } = await h.run([[MODE, 'mcp']]);
      expect(
        ui.asked.find((q) => q.message.includes('How would you like to work with Jira?'))?.initial,
      ).toBe('manual');
      expect(outcome).toMatchObject({
        mode: 'manual',
        fallbackReason: expect.stringContaining('Claude Code is not installed') as string,
      });
      expect(ui.noteText()).toContain('https://docs.anthropic.com/en/docs/claude-code/setup');
      expect(h.state.registry.added).toEqual([]);
      expect(global.jira?.mode).toBe('manual');
    });

    it('explains how to sign in when Claude Code is not authenticated, and never signs in itself', async () => {
      h.state.env = environment({ claudeAuth: { state: 'signed-out' } });
      const { outcome, ui } = await h.run([[MODE, 'manual']]);
      expect(outcome.status).toBe('completed');
      expect(ui.noteText()).toMatch(
        /Claude Code is not signed in\s+Sign in to Claude Code: run "claude auth login"/,
      );
      expect(ui.asked.some((q) => q.kind === 'password')).toBe(false);
    });

    it('warns that ANTHROPIC_API_KEY may change billing', async () => {
      h.state.env = environment({ anthropicApiKeySet: true });
      const { ui } = await h.run([[MODE, 'manual']]);
      expect(ui.noteText()).toMatch(/ANTHROPIC_API_KEY is set\. Claude Code may use it/);
    });

    it('points out that /jira-report needs git2jira on PATH when run through npx', async () => {
      h.state.env = environment({
        viaNpx: true,
        cliOnPath: { installed: false, matchesThisCli: false },
      });
      const { ui } = await h.run([[MODE, 'manual']]);
      expect(ui.noteText()).toContain('this setup runs through npx');
      expect(ui.noteText()).toContain('npm install -g git2jira-ai');
    });
  });

  describe('manual mode', () => {
    it('needs no Jira credentials, no API token, and no MCP registration', async () => {
      const { outcome, ui, global } = await h.run([[MODE, 'manual']]);
      expect(outcome.mode).toBe('manual');
      expect(h.state.registry.listCalls).toBe(0);
      expect(h.state.registry.added).toEqual([]);
      expect(h.logins).toEqual([]);
      expect(ui.asked.some((q) => q.kind === 'password' || q.kind === 'text')).toBe(false);
      expect(global.mcp).toBeUndefined();
      expect(global.jira?.connections).toBeUndefined();
    });
  });

  describe('Atlassian MCP', () => {
    it('registers the official server for the user only after consent, and says OAuth is not verified', async () => {
      const { outcome, ui, global } = await h.run([
        [MODE, 'mcp'],
        [REGISTER, true],
      ]);
      expect(h.state.registry.added).toEqual([
        { name: 'atlassian', url: 'https://mcp.atlassian.com/v2/mcp', scope: 'user' },
      ]);
      expect(outcome).toMatchObject({ mode: 'mcp', mcpServer: 'atlassian' });
      expect(global).toMatchObject({ jira: { mode: 'mcp' }, mcp: { server: 'atlassian' } });
      const register = ui.asked.find((q) =>
        q.message.includes('Register the official Atlassian Rovo MCP server'),
      );
      expect(register?.message).toContain(
        'claude mcp add --transport http --scope user atlassian https://mcp.atlassian.com/v2/mcp',
      );
      const text = ui.noteText();
      expect(text).toContain(
        'OAuth authorization is NOT done by this setup and is not verified yet.',
      );
      expect(text).toMatch(/run \/mcp[\s\S]*Authenticate/);
      expect(text).not.toMatch(/authorized successfully|signed in to Atlassian/i);
    });

    it('reuses an existing registration without changing it', async () => {
      h.state.registry = new FakeRegistry([registered('rovo', 'connected')]);
      const { outcome, ui, global } = await h.run([[MODE, 'mcp']]);
      expect(h.state.registry.added).toEqual([]);
      expect(
        ui.asked.some((q) => q.message.includes('Register the official Atlassian Rovo MCP server')),
      ).toBe(false);
      expect(outcome.mcpServer).toBe('rovo');
      expect(global.mcp?.server).toBe('rovo');
      expect(ui.noteText()).toContain('It will not be changed.');
      expect(ui.noteText()).toContain(
        "Claude Code reports: ✓ Connected (this is Claude Code's statement",
      );
    });

    it('never takes the name of an unrelated MCP server', async () => {
      h.state.registry = new FakeRegistry([
        {
          name: 'atlassian',
          target: 'npx other',
          url: undefined,
          health: 'connected',
          status: 'ok',
        },
      ]);
      await h.run([
        [MODE, 'mcp'],
        [REGISTER, true],
      ]);
      expect(h.state.registry.added.map((a) => a.name)).toEqual(['atlassian-rovo']);
    });

    it('falls back to manual when registration is declined', async () => {
      const { outcome } = await h.run([
        [MODE, 'mcp'],
        [REGISTER, false],
      ]);
      expect(outcome).toMatchObject({
        mode: 'manual',
        fallbackReason: expect.stringContaining('not to register') as string,
      });
      expect(h.state.registry.added).toEqual([]);
    });

    it('falls back to manual when Claude Code refuses the registration', async () => {
      h.state.registry.failAdd = true;
      const { outcome, global } = await h.run([
        [MODE, 'mcp'],
        [REGISTER, true],
      ]);
      expect(outcome).toMatchObject({
        mode: 'manual',
        fallbackReason: expect.stringContaining('permission denied') as string,
      });
      expect(global.jira?.mode).toBe('manual');
      expect(global.mcp).toBeUndefined();
    });

    it('explains a corporate restriction, does not work around it, and offers manual mode', async () => {
      h.state.previous = verification('blocked-by-policy');
      const { outcome, ui } = await h.run([
        [MODE, 'mcp'],
        [/How do you want to continue/, 'manual'],
      ]);
      expect(
        ui.asked.find((q) => q.message.includes('How would you like to work with Jira?'))?.initial,
      ).toBe('manual');
      expect(ui.noteText()).toContain('Git2Jira does not work around organization controls.');
      expect(ui.noteText()).toContain('Your organization blocks this app.');
      expect(outcome).toMatchObject({
        mode: 'manual',
        fallbackReason: 'Atlassian MCP access is restricted.',
      });
      expect(h.state.registry.added).toEqual([]);
    });
  });

  describe('optional API-token mode', () => {
    it('is never preselected and uses an existing connection', async () => {
      h.state.connections = [{ name: 'work' }];
      const { outcome, ui, global } = await h.run([[MODE, 'api-token']]);
      expect(
        ui.asked.find((q) => q.message.includes('How would you like to work with Jira?'))?.initial,
      ).not.toBe('api-token');
      expect(outcome.mode).toBe('api-token');
      expect(global.jira?.mode).toBe('api-token');
      expect(ui.noteText()).toContain(
        "Use it only where your\ncompany's security policy allows personal API tokens",
      );
    });

    it('signs in only when asked, and falls back to manual if Jira rejects the token', async () => {
      h.state.loginFails = true;
      const { outcome } = await h.run([
        [MODE, 'api-token'],
        [/Sign in to Jira/, true],
        [/site URL/, 'https://example.atlassian.net'],
        [/email/, 'dev@example.com'],
        [/API token/, 'tok-123'],
      ]);
      expect(h.logins).toHaveLength(1);
      expect(outcome).toMatchObject({
        mode: 'manual',
        fallbackReason: expect.stringContaining('401') as string,
      });
    });
  });

  describe('language and persistence', () => {
    it.each([
      ['en', 'English (en)'],
      ['uk', 'Ukrainian (uk)'],
    ])('stores %s globally and shows it at the end', async (language, label) => {
      const { global, ui } = await h.run([
        [MODE, 'manual'],
        [LANGUAGE, language],
      ]);
      expect(global.report?.language).toBe(language);
      expect(ui.noteText()).toContain(`Report language: ${label}`);
    });

    it('preselects the stored language and mode on the next run, and switches modes', async () => {
      await h.run([
        [MODE, 'mcp'],
        [REGISTER, true],
        [LANGUAGE, 'uk'],
      ]);
      const second = await h.run([[MODE, 'manual']]);
      expect(
        second.ui.asked.find((q) =>
          q.message.includes('Which language should Git2Jira AI use for Jira reports?'),
        )?.initial,
      ).toBe('uk');
      expect(
        second.ui.asked.find((q) => q.message.includes('How would you like to work with Jira?'))
          ?.initial,
      ).toBe('mcp');
      expect(second.ui.noteText()).toContain('Existing installation found');
      expect(second.global).toMatchObject({ report: { language: 'uk' }, jira: { mode: 'manual' } });
    });

    it('stores the additional settings when reviewed', async () => {
      const { global, ui } = await h.run([
        [MODE, 'mcp'],
        [REGISTER, true],
        [/Review additional settings/, true],
        [/Include uncommitted changes/, false],
        [/Test command/, 'pnpm test'],
        [/Open the Jira comment/, true],
      ]);
      expect(global.report).toMatchObject({ includeUncommitted: false, testCommand: 'pnpm test' });
      expect(global.jira?.openAfterPublish).toBe(true);
      expect(ui.noteText()).toContain('Publishing always needs your explicit approval');
    });
  });

  describe('/jira-report installation', () => {
    it('reports an existing foreign Skill and does not overwrite it', async () => {
      await h.foreignSkill();
      const { outcome, ui } = await h.run([[MODE, 'manual']]);
      expect(outcome.skill).toMatchObject({
        skipped: expect.stringContaining('not installed by Git2Jira') as string,
      });
      expect(ui.noteText()).toContain('It will not be overwritten.');
      expect(
        await readFile(path.join(h.claudeHome, 'skills', 'jira-report', 'SKILL.md'), 'utf8'),
      ).toContain('someone else');
      expect(ui.outros[0]).toMatch(/some items need attention/);
    });

    it('reinstalls idempotently and upgrades an older version', async () => {
      await h.run([[MODE, 'manual']]);
      expect((await h.run([[MODE, 'manual']])).outcome.skill).toMatchObject({
        action: 'unchanged',
      });
      h.setSkillVersion('0.6.0');
      expect((await h.run([[MODE, 'manual']])).outcome.skill).toMatchObject({ action: 'upgraded' });
    });
  });

  describe('cancellation', () => {
    it.each([
      ['at the mode question', [[MODE, CANCEL]]],
      [
        'at the language question',
        [
          [MODE, 'mcp'],
          [REGISTER, true],
          [LANGUAGE, CANCEL],
        ],
      ],
      [
        'by declining the summary',
        [
          [MODE, 'mcp'],
          [REGISTER, true],
          [APPLY, false],
        ],
      ],
    ] as const)('changes nothing when cancelled %s', async (_when, script) => {
      const { outcome, ui } = await h.run([...script] as never);
      expect(outcome.status).toBe('cancelled');
      expect(ui.outros).toEqual(['Setup cancelled.']);
      await expect(access(h.config.globalPath)).rejects.toThrow();
      expect(await skillInstalled()).toBe(false);
      expect(h.state.registry.added).toEqual([]);
    });
  });

  it('runs non-interactively with --yes', async () => {
    const { outcome, ui } = await h.run([], { yes: true, mode: 'manual', language: 'uk' });
    expect(outcome).toMatchObject({ status: 'completed', mode: 'manual', language: 'uk' });
    expect(
      ui.asked.some(
        (q) =>
          q.message.includes('How would you like to work with Jira?') ||
          q.message.includes('Which language should Git2Jira AI use for Jira reports?'),
      ),
    ).toBe(false);
  });
});
