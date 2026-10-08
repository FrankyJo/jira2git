import type { ConfigStore } from '../config/store';
import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES, type Language } from '../localization/languages';
import type { McpSetupService } from '../mcp/setup';
import type { McpVerificationRecord } from '../mcp/verification';
import type { InstallerContext, InstallerStep } from './types';

/** Asks for the report language and stores it globally (`report.language`). */
export class LanguageStep implements InstallerStep {
  readonly id = 'language';
  readonly title = 'Report language';

  constructor(private readonly config: ConfigStore) {}

  async run(context: InstallerContext): Promise<void> {
    const global = await this.config.readGlobal();
    const language = await context.prompter.select<Language>(
      'In which language should Jira reports be written?',
      SUPPORTED_LANGUAGES.map((code) => ({
        value: code,
        label: `${LANGUAGE_NAMES[code].native} (${code})`,
      })),
      global.report?.language ?? 'en',
    );
    await this.config.writeGlobal({ ...global, report: { ...global.report, language } });
    context.answers.language = language;
  }
}

/**
 * "How do you want to use Jira?" — Atlassian MCP or manual. Manual needs nothing.
 * MCP registers the official server in Claude Code (never replacing an existing one)
 * and explains the OAuth sign-in, which only Claude Code can perform and only the
 * Skill can verify. When MCP cannot be set up, or a previous verification showed it
 * is blocked, manual mode is configured instead and the reason is shown.
 */
export class JiraModeStep implements InstallerStep {
  readonly id = 'jira-mode';
  readonly title = 'Jira mode';

  constructor(
    private readonly config: ConfigStore,
    private readonly mcp: McpSetupService,
    private readonly lastVerification: () => Promise<McpVerificationRecord | undefined>,
  ) {}

  async run(context: InstallerContext): Promise<void> {
    const { prompter } = context;
    const requested = await prompter.select<'mcp' | 'manual'>(
      'How do you want to use Jira?',
      [
        {
          value: 'mcp',
          label: 'Atlassian MCP',
          hint: 'OAuth browser login in Claude Code; automated publication where supported',
        },
        {
          value: 'manual',
          label: 'Manual',
          hint: 'generate and copy reports; no Jira authorization needed',
        },
      ],
      'mcp',
    );
    context.answers.requestedJiraMode = requested;
    if (requested === 'manual') {
      await this.setMode('manual');
      context.answers.jiraMode = 'manual';
      prompter.note(
        'Reports are generated locally. You paste them into Jira and confirm; no credentials or MCP needed.',
        'Manual mode',
      );
      return;
    }

    const result = await this.mcp.ensureRegistered({
      confirm: (message) => prompter.confirm(message, true),
    });
    let server: string | undefined;
    switch (result.kind) {
      case 'claude-not-installed':
        return this.fallBack(context, 'Claude Code is not installed.');
      case 'failed':
        return this.fallBack(context, `The MCP server could not be registered (${result.error}).`);
      case 'declined':
        return this.fallBack(context, 'You chose not to register the Atlassian MCP server.');
      case 'already-registered':
        server = result.entry.name;
        prompter.note(
          `Claude Code already has "${server}" (${result.entry.url ?? result.entry.target}); it was left unchanged.` +
            (result.official ? '' : ' It does not use the current v2 endpoint.'),
          'Atlassian MCP',
        );
        break;
      case 'registered':
        server = result.name;
    }

    const previous = await this.lastVerification();
    if (
      previous &&
      (previous.server === undefined || previous.server === server) &&
      (previous.state === 'blocked-by-policy' || previous.state === 'no-jira-access')
    ) {
      return this.fallBack(
        context,
        `The last access check (${previous.verifiedAt}) found: ${previous.messages[0] ?? previous.state}`,
      );
    }

    const global = await this.config.readGlobal();
    await this.config.writeGlobal({
      ...global,
      jira: { ...global.jira, mode: 'mcp' },
      mcp: { server },
    });
    context.answers.jiraMode = 'mcp';
    context.answers.mcpServer = server;
    prompter.note(
      [
        'Authorization is NOT verified yet. To sign in:',
        '  1. Start Claude Code and run /mcp.',
        `  2. Select "${server}", choose Authenticate, and approve access in the browser.`,
        '  3. /jira-report checks Jira access before it offers to publish.',
        'If access turns out to be blocked, /jira-report offers manual mode for that report;',
        'switch permanently with: git2jira config set jira.mode manual',
      ].join('\n'),
      'Atlassian MCP',
    );
  }

  private async fallBack(context: InstallerContext, reason: string): Promise<void> {
    await this.setMode('manual');
    context.answers.jiraMode = 'manual';
    context.answers.fallbackReason = reason;
    context.prompter.note(
      `${reason}\nManual mode is configured instead: reports are generated and copied by hand. ` +
        'Switch later with: git2jira config set jira.mode mcp',
      'Using manual mode',
    );
  }

  private async setMode(mode: 'manual' | 'mcp'): Promise<void> {
    const global = await this.config.readGlobal();
    await this.config.writeGlobal({ ...global, jira: { ...global.jira, mode } });
  }
}
