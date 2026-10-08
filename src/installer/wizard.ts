import { access } from 'node:fs/promises';
import { jiraSiteFromUrl } from '../checkpoints/site';
import { TestCommandSchema, type GlobalConfig } from '../config/schema';
import type { ConfigStore } from '../config/store';
import { GUIDANCE, type EnvironmentReport } from '../diagnostics/environment';
import type { DiagnosticResult } from '../diagnostics/types';
import type { DeliveryMode } from '../delivery/mode';
import type { LoginInput, LoginResult } from '../jira/connections';
import { LANGUAGE_NAMES, type Language } from '../localization/languages';
import type { McpSetupService } from '../mcp/setup';
import { ATLASSIAN_MCP_ENDPOINT, DEFAULT_MCP_SERVER_NAME } from '../mcp/tools';
import type { McpVerificationRecord } from '../mcp/verification';
import type { SkillInstallResult, SkillInstaller } from '../skill/types';
import { PromptCancelledError, type Prompter } from './prompter';

/**
 * `git2jira init`: the setup wizard.
 *
 * It runs in two phases. First it checks the environment and asks every question; then
 * it shows a summary and changes nothing until the user confirms it. So cancelling
 * (Ctrl+C, Esc, or "no" at the summary) always leaves the machine as it was.
 *
 * Applying writes the global configuration, registers the official Atlassian MCP
 * server in Claude Code if the user agreed (never touching other servers), signs in
 * with an API token only if that optional mode was chosen, installs `/jira-report`,
 * and runs the doctor checks. It never signs in to Atlassian or Claude Code for the
 * user and never claims an OAuth authorization it has not seen.
 */
export interface WizardDependencies {
  prompter: Prompter;
  config: ConfigStore;
  environment: () => Promise<EnvironmentReport>;
  mcp: McpSetupService;
  lastVerification: () => Promise<McpVerificationRecord | undefined>;
  skill: SkillInstaller;
  connections: {
    list(): Promise<{ connections: { name: string }[]; defaultConnection: string | undefined }>;
    login(input: LoginInput): Promise<LoginResult>;
  };
  doctor: () => Promise<{
    results: { title: string; result: DiagnosticResult }[];
    summary: { ok: boolean; text: string };
  }>;
}

export interface WizardOptions {
  language?: Language | undefined;
  mode?: DeliveryMode | undefined;
  /** Accept every default without asking (non-interactive). */
  yes?: boolean | undefined;
  skipSkill?: boolean | undefined;
}

export interface WizardOutcome {
  status: 'completed' | 'cancelled';
  language?: Language;
  mode?: DeliveryMode;
  /** Why the chosen mode was replaced by manual mode, if it was. */
  fallbackReason?: string;
  mcpServer?: string;
  skill?: SkillInstallResult | { error: string } | { skipped: string };
  doctorOk?: boolean;
}

interface Plan {
  mode: DeliveryMode;
  requestedMode: DeliveryMode;
  fallbackReason?: string;
  mcpServer?: string;
  /** Server name to register at user scope during apply. */
  registerMcp?: string;
  login?: LoginInput;
  defaultConnection?: string;
  language: Language;
  includeUncommitted?: boolean;
  testCommand?: string | null;
  openAfterPublish?: boolean;
  skill: { install: false; reason: string } | { install: true; force: boolean };
}

const MODE_LABELS: Readonly<Record<DeliveryMode, string>> = {
  mcp: 'Atlassian MCP',
  manual: 'Manual',
  'api-token': 'Personal API token',
};

export class InitWizard {
  constructor(private readonly deps: WizardDependencies) {}

  async run(options: WizardOptions = {}): Promise<WizardOutcome> {
    const { prompter } = this.deps;
    let plan: Plan | undefined;
    try {
      plan = await this.collect(options);
    } catch (error) {
      if (error instanceof PromptCancelledError) {
        prompter.outro('Setup cancelled.');
        return { status: 'cancelled' };
      }
      throw error;
    }
    if (!plan) {
      prompter.outro('Setup cancelled.');
      return { status: 'cancelled' };
    }
    return this.apply(plan);
  }

  // ---------------------------------------------------------------------------
  // Phase 1: questions only. Nothing is written.

  private async collect(options: WizardOptions): Promise<Plan | undefined> {
    const { prompter } = this.deps;
    prompter.intro('Git2Jira AI');
    prompter.note(
      [
        'Generate incremental Jira implementation reports with Claude Code.',
        '',
        'This setup will:',
        '  1. check your environment (Node.js, Git, Claude Code),',
        '  2. ask how you want to work with Jira and which language reports use,',
        '  3. install the /jira-report command for Claude Code (all repositories),',
        '  4. run diagnostics.',
        'Nothing is changed until you confirm the summary at the end.',
      ].join('\n'),
      'Welcome',
    );

    const env = await this.deps.environment();
    const global = await this.deps.config.readGlobal();
    const existing = await this.existingInstallation();
    prompter.note(environmentLines(env, existing).join('\n'), 'Environment');

    const mode = await this.chooseMode(options, env, global);
    if (!mode) return undefined;
    const language = await this.chooseLanguage(options, global);
    const settings = await this.additionalSettings(options, global, mode.mode);
    const skill = await this.planSkill(options);

    const plan: Plan = { ...mode, language, ...settings, skill };
    prompter.note(summaryLines(plan).join('\n'), 'Summary');
    const apply = await prompter.confirm('Apply this configuration?', true);
    return apply ? plan : undefined;
  }

  private async existingInstallation(): Promise<{ config: boolean; skill: string }> {
    const config = await access(this.deps.config.globalPath).then(
      () => true,
      () => false,
    );
    const skill = await this.deps.skill.status().catch(() => undefined);
    return { config, skill: skill?.state ?? 'unknown' };
  }

  private async chooseMode(
    options: WizardOptions,
    env: EnvironmentReport,
    global: GlobalConfig,
  ): Promise<Omit<Plan, 'language' | 'skill'> | undefined> {
    const { prompter } = this.deps;
    const previous = await this.deps.lastVerification();
    const blocked =
      previous !== undefined &&
      (previous.state === 'blocked-by-policy' || previous.state === 'no-jira-access');
    const mcpAvailable = env.claude.installed && !blocked;

    let requested = options.mode;
    if (requested === undefined) {
      prompter.note(
        [
          "Atlassian MCP: Claude Code publishes the report as a new Jira comment after you approve it. Requires an authorized Atlassian Rovo MCP connection (OAuth in your browser) and your company's approval of Rovo MCP.",
          '',
          'Manual: Git2Jira writes the report; you copy it into Jira and confirm. No API tokens or Jira authorization required.',
        ].join('\n'),
        'Jira delivery',
      );
      const initial: DeliveryMode = global.jira?.mode ?? (mcpAvailable ? 'mcp' : 'manual');
      requested = await prompter.select<DeliveryMode>(
        'How would you like to work with Jira?',
        [
          {
            value: 'mcp',
            label: 'Atlassian MCP',
            hint: mcpAvailable
              ? 'Browser authorization and automatic publishing after approval'
              : env.claude.installed
                ? 'blocked at the last access check'
                : 'needs Claude Code',
          },
          {
            value: 'manual',
            label: 'Manual',
            hint: 'Generate and copy reports without Jira access',
          },
          {
            value: 'api-token',
            label: 'Personal API token (advanced)',
            hint: 'only for personal use where your company allows API tokens',
          },
        ],
        mcpAvailable ? initial : initial === 'mcp' ? 'manual' : initial,
      );
    }

    if (requested === 'manual') {
      prompter.note(
        [
          'No Jira credentials, API token, or MCP connection is needed.',
          'In Claude Code, /jira-report writes the report and shows it. You copy it (clipboard or file), paste it as a comment in the Jira issue, and confirm. Only your confirmation moves the checkpoint, so the next report starts after it.',
        ].join('\n'),
        'Manual mode',
      );
      return { mode: 'manual', requestedMode: 'manual' };
    }
    if (requested === 'mcp') return this.planMcp(env, global, previous);
    return this.planApiToken(options, global);
  }

  private async planMcp(
    env: EnvironmentReport,
    global: GlobalConfig,
    previous: McpVerificationRecord | undefined,
  ): Promise<Omit<Plan, 'language' | 'skill'> | undefined> {
    const { prompter } = this.deps;
    const manual = (reason: string) => {
      prompter.note(
        `${reason}\nManual mode will be configured instead. Switch later with: git2jira config set jira.mode mcp`,
        'Using manual mode',
      );
      return { mode: 'manual' as const, requestedMode: 'mcp' as const, fallbackReason: reason };
    };
    if (!env.claude.installed) return manual(`Claude Code is not installed. ${GUIDANCE.claude}`);

    if (
      previous &&
      (previous.state === 'blocked-by-policy' || previous.state === 'no-jira-access')
    ) {
      prompter.note(
        [
          `The last Atlassian access check (${previous.verifiedAt}) found: ${previous.messages[0] ?? previous.state}.`,
          'Git2Jira does not work around organization controls. Ask your Atlassian administrator',
          'whether Rovo MCP may be used, or use manual mode, which needs no Jira access.',
        ].join('\n'),
        'Access restricted',
      );
      const choice = await prompter.select<'manual' | 'mcp'>(
        'How do you want to continue?',
        [
          { value: 'manual', label: 'Use manual mode', hint: 'recommended' },
          { value: 'mcp', label: 'Keep MCP mode', hint: 'after your administrator allowed access' },
        ],
        'manual',
      );
      if (choice === 'manual') return manual('Atlassian MCP access is restricted.');
    }

    const preferred = global.mcp?.server ?? DEFAULT_MCP_SERVER_NAME;
    const state = await this.deps.mcp.inspect(preferred);
    let server: string | undefined;
    let registerMcp: string | undefined;
    switch (state.kind) {
      case 'claude-not-installed':
        return manual(`Claude Code is not installed. ${GUIDANCE.claude}`);
      case 'unknown':
        return manual(`Claude Code's MCP configuration could not be read (${state.error}).`);
      case 'registered':
        server = state.entry.name;
        prompter.note(
          [
            `Claude Code already has "${server}" (${state.entry.url ?? state.entry.target}). It will not be changed.`,
            state.official
              ? ''
              : `It does not use the current endpoint ${ATLASSIAN_MCP_ENDPOINT}; consider re-adding it yourself.`,
            `Claude Code reports: ${state.entry.status} (this is Claude Code's statement, not a Git2Jira check).`,
          ]
            .filter((l) => l !== '')
            .join('\n'),
          'Atlassian MCP',
        );
        break;
      case 'not-registered': {
        const register = await prompter.confirm(
          `Register the official Atlassian Rovo MCP server for your user?\n` +
            `  claude mcp add --transport http --scope user ${state.suggestedName} ${ATLASSIAN_MCP_ENDPOINT}`,
          true,
        );
        if (!register) return manual('You chose not to register the Atlassian MCP server.');
        server = state.suggestedName;
        registerMcp = state.suggestedName;
      }
    }

    prompter.note(
      [
        'OAuth authorization is NOT done by this setup and is not verified yet.',
        'After setup:',
        '  1. Start Claude Code and run /mcp.',
        `  2. Select "${server}" and choose Authenticate; approve access in your browser.`,
        '  3. Run /jira-report: it checks Jira read access and the comment tool before offering to publish.',
        'If your organization blocks Rovo MCP or its write access, /jira-report offers manual mode.',
      ].join('\n'),
      'Atlassian MCP authorization',
    );
    return {
      mode: 'mcp',
      requestedMode: 'mcp',
      mcpServer: server,
      ...(registerMcp ? { registerMcp } : {}),
    };
  }

  private async planApiToken(
    options: WizardOptions,
    global: GlobalConfig,
  ): Promise<Omit<Plan, 'language' | 'skill'>> {
    const { prompter } = this.deps;
    const manual = (reason: string) => {
      prompter.note(`${reason}\nManual mode will be configured instead.`, 'Using manual mode');
      return {
        mode: 'manual' as const,
        requestedMode: 'api-token' as const,
        fallbackReason: reason,
      };
    };
    prompter.note(
      [
        'A personal Atlassian API token lets the CLI publish reports itself. Use it only where your',
        "company's security policy allows personal API tokens; otherwise choose MCP or manual mode.",
        'The token is verified with Jira and stored only in your OS credential store.',
      ].join('\n'),
      'Personal API token',
    );
    const { connections } = await this.deps.connections.list();
    if (connections.length > 0) {
      let defaultConnection = global.jira?.defaultConnection;
      if (connections.length > 1 && !options.yes) {
        defaultConnection = await prompter.select(
          'Which Jira connection should be the default?',
          connections.map((c) => ({ value: c.name, label: c.name })),
          defaultConnection ?? connections[0]?.name,
        );
      }
      return {
        mode: 'api-token',
        requestedMode: 'api-token',
        ...(defaultConnection ? { defaultConnection } : {}),
      };
    }
    if (options.yes)
      return manual('No Jira connection exists; sign in with "git2jira login" first.');
    const signIn = await prompter.confirm('Sign in to Jira with an API token now?', true);
    if (!signIn) {
      return manual(
        'No Jira connection was created. Later: "git2jira login", then "git2jira config set jira.mode api-token".',
      );
    }
    const siteUrl = await prompter.text('Jira Cloud site URL', {
      placeholder: 'https://example.atlassian.net',
      validate: (value) => {
        try {
          jiraSiteFromUrl(value);
          return undefined;
        } catch (error) {
          return (error as Error).message;
        }
      },
    });
    const email = await prompter.text('Atlassian account email', {
      validate: (value) =>
        /^[^\s@]+@[^\s@]+$/.test(value) ? undefined : 'Enter an email address.',
    });
    prompter.note(
      'Create a token at https://id.atlassian.com/manage-profile/security/api-tokens.',
      'API token',
    );
    const token = (await prompter.password('API token')).trim();
    if (token === '') return manual('No API token was entered.');
    return {
      mode: 'api-token',
      requestedMode: 'api-token',
      login: {
        name: 'default',
        siteUrl: jiraSiteFromUrl(siteUrl).url,
        email,
        token,
        tokenType: 'auto',
        makeDefault: true,
      },
    };
  }

  private async chooseLanguage(options: WizardOptions, global: GlobalConfig): Promise<Language> {
    if (options.language) return options.language;
    return this.deps.prompter.select<Language>(
      'Which language should Git2Jira AI use for Jira reports?',
      [
        { value: 'en', label: 'English' },
        { value: 'uk', label: `Ukrainian (${LANGUAGE_NAMES.uk.native})` },
      ],
      global.report?.language ?? 'en',
    );
  }

  private async additionalSettings(
    options: WizardOptions,
    global: GlobalConfig,
    mode: DeliveryMode,
  ): Promise<Pick<Plan, 'includeUncommitted' | 'testCommand' | 'openAfterPublish'>> {
    const { prompter } = this.deps;
    if (options.yes) return {};
    const review = await prompter.confirm(
      'Review additional settings? (uncommitted changes, test command, opening Jira after publishing)',
      false,
    );
    if (!review) return {};
    const includeUncommitted = await prompter.confirm(
      'Include uncommitted changes in reports?',
      global.report?.includeUncommitted ?? true,
    );
    const rawTest = await prompter.text(
      'Test command "git2jira report" should run and cite (empty for none)',
      {
        placeholder: global.report?.testCommand ?? 'pnpm test',
        validate: (value) => {
          if (value.trim() === '') return undefined;
          const parsed = TestCommandSchema.safeParse(value);
          return parsed.success ? undefined : parsed.error.issues[0]?.message;
        },
      },
    );
    const openAfterPublish =
      mode === 'manual'
        ? (global.jira?.openAfterPublish ?? false)
        : await prompter.confirm(
            'Open the Jira comment in your browser after a publication?',
            global.jira?.openAfterPublish ?? false,
          );
    prompter.note(
      'Publishing always needs your explicit approval of the exact report; no setting turns that off.',
      'Approval',
    );
    return {
      includeUncommitted,
      testCommand: rawTest.trim() === '' ? null : rawTest.trim(),
      openAfterPublish,
    };
  }

  private async planSkill(options: WizardOptions): Promise<Plan['skill']> {
    const { prompter } = this.deps;
    if (options.skipSkill) return { install: false, reason: 'skipped (--skip-skill)' };
    const state = await this.deps.skill.status();
    switch (state.state) {
      case 'conflict':
        prompter.note(
          `${state.reason}\nIt will not be overwritten. Move ${state.paths.join(', ')} away and run ` +
            '"git2jira skill install" later.',
          '/jira-report',
        );
        return { install: false, reason: state.reason };
      case 'modified': {
        const force = options.yes
          ? false
          : await prompter.confirm(
              `The installed /jira-report was changed (${[...state.modifiedFiles, ...state.missingFiles].join(', ')}). Replace your changes?`,
              false,
            );
        return force
          ? { install: true, force: true }
          : { install: false, reason: 'the installed Skill has local changes; kept as is' };
      }
      default:
        return { install: true, force: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 2: apply the confirmed plan.

  private async apply(plan: Plan): Promise<WizardOutcome> {
    const { prompter } = this.deps;
    let mode = plan.mode;
    let fallbackReason = plan.fallbackReason;
    let mcpServer = plan.mcpServer;
    let defaultConnection = plan.defaultConnection;

    if (plan.login) {
      try {
        const result = await this.deps.connections.login(plan.login);
        defaultConnection = result.connection.name;
        prompter.note(
          `Signed in to ${result.connection.site.url}; the token is in the OS credential store.`,
          'Jira',
        );
      } catch (error) {
        mode = 'manual';
        fallbackReason = `Jira sign-in failed: ${(error as Error).message}`;
        prompter.note(`${fallbackReason}\nManual mode is configured instead.`, 'Using manual mode');
      }
    }
    if (plan.registerMcp) {
      const result = await this.deps.mcp.ensureRegistered({
        name: plan.registerMcp,
        scope: 'user',
        // Already confirmed in the summary.
        confirm: () => Promise.resolve(true),
      });
      if (result.kind === 'registered') {
        mcpServer = result.name;
        prompter.note(
          `Registered "${result.name}" (${ATLASSIAN_MCP_ENDPOINT}) for your user. Not authorized yet: run /mcp in Claude Code.`,
          'Atlassian MCP',
        );
      } else if (result.kind === 'already-registered') {
        mcpServer = result.entry.name;
      } else {
        mode = 'manual';
        mcpServer = undefined;
        fallbackReason =
          result.kind === 'failed'
            ? `The MCP server could not be registered: ${result.error}`
            : 'The MCP server was not registered.';
        prompter.note(`${fallbackReason}\nManual mode is configured instead.`, 'Using manual mode');
      }
    }

    const global = await this.deps.config.readGlobal();
    const report: NonNullable<GlobalConfig['report']> = {
      ...global.report,
      language: plan.language,
    };
    if (plan.includeUncommitted !== undefined) report.includeUncommitted = plan.includeUncommitted;
    if (plan.testCommand === null) delete report.testCommand;
    else if (plan.testCommand !== undefined) report.testCommand = plan.testCommand;
    const jira: NonNullable<GlobalConfig['jira']> = { ...global.jira, mode };
    if (plan.openAfterPublish !== undefined) jira.openAfterPublish = plan.openAfterPublish;
    if (defaultConnection !== undefined) jira.defaultConnection = defaultConnection;
    await this.deps.config.writeGlobal({
      ...global,
      report,
      jira,
      ...(mode === 'mcp' && mcpServer ? { mcp: { server: mcpServer } } : {}),
    });

    let skill: WizardOutcome['skill'];
    if (plan.skill.install) {
      try {
        skill = await this.deps.skill.install({ force: plan.skill.force });
      } catch (error) {
        skill = { error: (error as Error).message };
        prompter.note((error as Error).message, '/jira-report not installed');
      }
    } else {
      skill = { skipped: plan.skill.reason };
    }

    const doctor = await this.deps.doctor();
    prompter.note(
      doctor.results
        .map((r) => `${ICONS[r.result.status]} ${r.title}: ${r.result.message}`)
        .join('\n') + `\n\n${doctor.summary.text}`,
      'Diagnostics (git2jira doctor)',
    );

    const skillReady = 'action' in skill;
    prompter.note(
      [
        `Delivery mode: ${MODE_LABELS[mode]}${fallbackReason ? ` (instead of ${MODE_LABELS[plan.requestedMode]})` : ''}`,
        `Report language: ${plan.language === 'uk' ? 'Ukrainian (uk)' : 'English (en)'}`,
        '',
        '1. Open any Git repository.',
        '2. Use a branch with a Jira issue key, e.g. feature/LSND-1234-user-profile.',
        '3. Start Claude Code: claude',
        '4. Run /jira-report',
        '5. Review the generated report.',
        mode === 'manual'
          ? '6. Copy it into the Jira issue, then confirm publication.'
          : mode === 'mcp'
            ? '6. Approve it, and Claude Code publishes it as a new Jira comment (or copy it manually).'
            : '6. Approve it; "git2jira report" publishes it with your API token.',
        '',
        'Change settings later: git2jira config set report.language uk | jira.mode manual',
      ].join('\n'),
      'Next steps',
    );
    prompter.outro(
      doctor.summary.ok && skillReady
        ? 'Git2Jira AI is ready!'
        : 'Git2Jira AI is configured, but some items need attention (see Diagnostics).',
    );
    return {
      status: 'completed',
      language: plan.language,
      mode,
      ...(fallbackReason ? { fallbackReason } : {}),
      ...(mode === 'mcp' && mcpServer ? { mcpServer } : {}),
      skill,
      doctorOk: doctor.summary.ok,
    };
  }
}

const ICONS: Readonly<Record<DiagnosticResult['status'], string>> = {
  pass: '✔',
  warn: '!',
  fail: '✖',
  skip: '–',
};

function environmentLines(
  env: EnvironmentReport,
  existing: { config: boolean; skill: string },
): string[] {
  const line = (ok: boolean, text: string, guidance?: string) =>
    `${ok ? '✔' : '✖'} ${text}${!ok && guidance ? `\n    ${guidance}` : ''}`;
  const lines = [
    `✔ ${env.os.platform} ${env.os.release} (${env.os.arch})`,
    line(env.node.supported, `Node.js ${env.node.version}`, GUIDANCE.node),
    line(
      env.git.installed,
      env.git.installed ? `Git ${env.git.version ?? ''}`.trim() : 'Git not found',
      GUIDANCE.git,
    ),
    line(
      env.claude.installed,
      env.claude.installed
        ? `Claude Code ${env.claude.version ?? ''}`.trim()
        : 'Claude Code not found',
      GUIDANCE.claude,
    ),
  ];
  switch (env.claudeAuth.state) {
    case 'signed-in':
      lines.push(
        `${env.claudeAuth.billing === 'subscription' ? '✔' : '!'} Claude Code signed in (${env.claudeAuth.detail})`,
      );
      break;
    case 'signed-out':
      lines.push(line(false, 'Claude Code is not signed in', GUIDANCE.claudeAuth));
      break;
    case 'unknown':
      lines.push(
        `! Claude Code sign-in status unknown (${env.claudeAuth.detail})\n    ${GUIDANCE.claudeAuth}`,
      );
      break;
    case 'not-installed':
      break;
  }
  if (env.anthropicApiKeySet) lines.push(`! ${GUIDANCE.apiKey}`);
  if (!env.cliOnPath.installed) {
    lines.push(
      `! "git2jira" is not on your PATH${env.viaNpx ? ' (this setup runs through npx)' : ''}.\n    ${GUIDANCE.cliOnPath}`,
    );
  } else if (!env.cliOnPath.matchesThisCli) {
    lines.push(`! "git2jira" on your PATH is version ${env.cliOnPath.version ?? 'unknown'}.`);
  }
  lines.push(
    existing.config || !['not-installed', 'unknown'].includes(existing.skill)
      ? `• Existing installation found (configuration: ${existing.config ? 'yes' : 'no'}, /jira-report: ${existing.skill}); your settings are pre-selected.`
      : '• No previous Git2Jira installation found.',
  );
  return lines;
}

function summaryLines(plan: Plan): string[] {
  return [
    `Delivery mode:   ${MODE_LABELS[plan.mode]}${plan.fallbackReason ? ` (instead of ${MODE_LABELS[plan.requestedMode]})` : ''}`,
    ...(plan.mode === 'mcp'
      ? [
          plan.registerMcp
            ? `Atlassian MCP:   register "${plan.registerMcp}" at user scope (${ATLASSIAN_MCP_ENDPOINT})`
            : `Atlassian MCP:   use the existing "${plan.mcpServer ?? ''}" (unchanged)`,
        ]
      : []),
    ...(plan.login
      ? [`Jira sign-in:    API token for ${plan.login.siteUrl} (OS credential store)`]
      : []),
    ...(plan.defaultConnection ? [`Jira connection: ${plan.defaultConnection}`] : []),
    `Report language: ${plan.language === 'uk' ? 'Ukrainian (uk)' : 'English (en)'}`,
    ...(plan.includeUncommitted !== undefined
      ? [`Uncommitted:     ${plan.includeUncommitted ? 'included' : 'not included'}`]
      : []),
    ...(plan.testCommand !== undefined ? [`Test command:    ${plan.testCommand ?? '(none)'}`] : []),
    ...(plan.openAfterPublish !== undefined
      ? [`Open Jira after publishing: ${plan.openAfterPublish ? 'yes' : 'no'}`]
      : []),
    `/jira-report:    ${plan.skill.install ? (plan.skill.force ? 'install (replace local changes)' : 'install or upgrade') : `not installed (${plan.skill.reason})`}`,
  ];
}
