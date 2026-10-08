import { readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { Command, Option } from 'commander';
import { globalConfigDir } from '../../config/paths';
import { credentialReference } from '../../credentials/types';
import { Git2JiraError, UsageError } from '../../core/errors';
import { VERSION } from '../../core/version';
import { doctorChecks, doctorSummary, type DoctorInputs } from '../../diagnostics/checks';
import type { DiagnosticResult } from '../../diagnostics/types';
import { DELIVERY_MODES, resolveDeliveryMode, type DeliveryMode } from '../../delivery/mode';
import type { Prompter } from '../../installer/prompter';
import { InitWizard } from '../../installer/wizard';
import { apiTokenAccount } from '../../jira/auth/api-token';
import { SUPPORTED_LANGUAGES, type Language } from '../../localization/languages';
import { resolveLanguage } from '../../localization/resolve';
import { McpSetupService } from '../../mcp/setup';
import { println, type CliContext, type OutputStream } from '../context';
import { configs } from './report';

/** `git2jira init`, `doctor`, and `uninstall`. */
export function createInitCommand(ctx: CliContext): Command {
  return new Command('init')
    .description(
      'Interactive setup: environment check, Jira mode (Atlassian MCP or manual), report language, /jira-report.',
    )
    .addOption(new Option('-l, --language <code>', 'report language').choices(SUPPORTED_LANGUAGES))
    .addOption(new Option('-m, --mode <mode>', 'Jira delivery mode').choices(DELIVERY_MODES))
    .option('-y, --yes', 'accept the defaults without asking (non-interactive)')
    .option('--skip-skill', 'do not install /jira-report')
    .action(
      async (options: {
        language?: Language;
        mode?: DeliveryMode;
        yes?: boolean;
        skipSkill?: boolean;
      }) => {
        if (!options.yes && ctx.interactive !== true) {
          throw new UsageError(
            'git2jira init is interactive. Without a terminal pass --yes (and optionally --mode, --language).',
          );
        }
        const prompter = options.yes
          ? defaultsPrompter(ctx.stdout)
          : ctx.container.resolve('prompter');
        const wizard = new InitWizard({
          prompter,
          config: ctx.container.resolve('configStore'),
          environment: () => ctx.container.resolve('environmentProbe').inspect(),
          mcp: new McpSetupService(ctx.container.resolve('claudeMcpRegistry')),
          lastVerification: () => ctx.container.resolve('mcpVerificationStore').read(),
          skill: ctx.container.resolve('skillInstaller'),
          connections: {
            list: () => ctx.container.resolve('jiraConnections').list(),
            login: (input) => ctx.container.resolve('jiraConnections').login(input),
          },
          doctor: () => runDoctor(ctx),
        });
        const outcome = await wizard.run({
          language: options.language,
          mode: options.mode,
          yes: options.yes,
          skipSkill: options.skipSkill,
        });
        if (outcome.status === 'cancelled') throw new SetupCancelledError();
      },
    );
}

export class SetupCancelledError extends Git2JiraError {
  constructor() {
    super('Nothing was changed.');
  }
}

export function createDoctorCommand(ctx: CliContext): Command {
  return new Command('doctor')
    .description(
      'Check the installation: CLI, Git, Claude Code, /jira-report, configuration, Jira access.',
    )
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const { results, summary } = await runDoctor(ctx);
      if (options.json) {
        println(
          ctx.stdout,
          JSON.stringify(
            {
              ok: summary.ok,
              summary: summary.text,
              checks: results.map((r) => ({ id: r.id, title: r.title, ...r.result })),
            },
            null,
            2,
          ),
        );
      } else {
        for (const { title, result } of results) {
          println(ctx.stdout, `${ICONS[result.status]} ${title}: ${result.message}`);
          if (result.remedy && result.status !== 'pass')
            println(ctx.stdout, `    → ${result.remedy}`);
        }
        println(ctx.stdout);
        println(ctx.stdout, summary.text);
      }
      if (!summary.ok) throw new DoctorFailedError();
    });
}

class DoctorFailedError extends Git2JiraError {
  constructor() {
    super('Some checks failed; see above.');
  }
}

export function createUninstallCommand(ctx: CliContext): Command {
  return new Command('uninstall')
    .description(
      'Remove /jira-report, stored Jira API tokens, and the global configuration. Repositories are not touched.',
    )
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--keep-config', 'keep the global configuration file')
    .option('--keep-credentials', 'keep Jira API tokens in the OS credential store')
    .action(async (options: { yes?: boolean; keepConfig?: boolean; keepCredentials?: boolean }) => {
      if (!options.yes && ctx.interactive !== true) {
        throw new UsageError('Pass --yes to uninstall without an interactive terminal.');
      }
      const configStore = ctx.container.resolve('configStore');
      const global = await configStore.readGlobal();
      const connections = Object.keys(global.jira?.connections ?? {});
      const server = global.mcp?.server;
      const plan = [
        '/jira-report Skill and jira-reporter agent (only files Git2Jira installed)',
        ...(options.keepCredentials || connections.length === 0
          ? []
          : [`Jira API tokens for: ${connections.join(', ')}`]),
        ...(options.keepConfig
          ? []
          : [`global configuration in ${path.dirname(configStore.globalPath)}`]),
      ];
      if (!options.yes) {
        const prompter = ctx.container.resolve('prompter');
        prompter.note(plan.map((p) => `• ${p}`).join('\n'), 'Git2Jira will remove');
        if (!(await prompter.confirm('Uninstall Git2Jira?', false))) {
          println(ctx.stdout, 'Nothing was removed.');
          return;
        }
      }

      const skill = await ctx.container
        .resolve('skillInstaller')
        .uninstall()
        .then(
          (r) =>
            r.removed
              ? `removed${r.keptFiles.length ? ` (kept your files: ${r.keptFiles.join(', ')})` : ''}`
              : 'was not installed',
          (error: unknown) => `not removed: ${(error as Error).message}`,
        );
      println(ctx.stdout, `/jira-report: ${skill}`);

      if (!options.keepCredentials) {
        const store = ctx.container.resolve('credentialStore');
        for (const name of connections) {
          const removed = await store.delete(credentialReference(apiTokenAccount(name))).then(
            (deleted) => (deleted ? 'token removed' : 'no token stored'),
            (error: unknown) => `could not remove the token: ${(error as Error).message}`,
          );
          println(ctx.stdout, `Jira connection "${name}": ${removed}`);
        }
      }

      if (!options.keepConfig) {
        const dir = globalConfigDir(ctx.container.resolve('pathEnvironment'));
        await rm(configStore.globalPath, { force: true });
        await rm(path.join(dir, 'mcp-verification.json'), { force: true });
        if ((await readdir(dir).catch(() => ['?'])).length === 0) await rmdir(dir);
        println(ctx.stdout, `Configuration removed from ${dir}`);
      }

      println(ctx.stdout);
      println(ctx.stdout, 'Not removed (remove them yourself if you want):');
      println(
        ctx.stdout,
        server
          ? `  • the Claude Code MCP server "${server}": claude mcp remove "${server}" --scope user`
          : '  • any Atlassian MCP server registered in Claude Code ("claude mcp list")',
      );
      println(
        ctx.stdout,
        '  • report history in each repository: .git/git2jira/ and refs/git2jira/ (local only, never pushed)',
      );
      println(ctx.stdout, '  • the CLI itself: npm uninstall -g git2jira-ai');
    });
}

const ICONS: Readonly<Record<DiagnosticResult['status'], string>> = {
  pass: '✔',
  warn: '!',
  fail: '✖',
  skip: '–',
};

export async function runDoctor(ctx: CliContext) {
  const { container } = ctx;
  const inputs: DoctorInputs = {
    cliVersion: VERSION,
    environment: () => container.resolve('environmentProbe').inspect(),
    skill: () => container.resolve('skillInstaller').status(),
    config: async () => {
      const { globalConfig, repoConfig } = await configs(ctx);
      return {
        global: globalConfig,
        repo: repoConfig,
        globalPath: container.resolve('configStore').globalPath,
      };
    },
    language: (global, repo) => resolveLanguage({ globalConfig: global, repoConfig: repo }),
    mode: (global, repo) => resolveDeliveryMode({ globalConfig: global, repoConfig: repo }),
    credentialStore: async () => {
      const store = container.resolve('credentialStore');
      return { available: await store.isAvailable(), backend: store.backend };
    },
    connections: async () =>
      (await container.resolve('jiraConnections').list()).connections.map((c) => c.name),
    mcpRegistration: (server) =>
      new McpSetupService(container.resolve('claudeMcpRegistry')).inspect(server),
    lastVerification: () => container.resolve('mcpVerificationStore').read(),
  };
  const checks = doctorChecks(inputs);
  const results = (await container.resolve('diagnostics').run(checks)).map((r) => ({
    id: r.check.id,
    title: r.check.title,
    result: r.result,
  }));
  return { results, summary: doctorSummary(results) };
}

/** `--yes`: every question takes its default; output is plain text. */
export function defaultsPrompter(out: OutputStream): Prompter {
  return {
    intro: (title) => {
      println(out, `== ${title} ==`);
    },
    outro: (message) => {
      println(out, message);
    },
    note: (message, title) => {
      println(out);
      if (title) println(out, `[${title}]`);
      println(out, message);
    },
    select: (message, options, initialValue) => {
      const value = initialValue ?? options[0]?.value;
      if (value === undefined) return Promise.reject(new UsageError(`No default for: ${message}`));
      println(out, `${message} → ${options.find((o) => o.value === value)?.label ?? value}`);
      return Promise.resolve(value);
    },
    text: (message) => {
      println(out, `${message} → (skipped)`);
      return Promise.resolve('');
    },
    password: (message) =>
      Promise.reject(new UsageError(`"${message}" cannot be answered with --yes.`)),
    confirm: (message, initialValue = false) => {
      println(out, `${message} → ${initialValue ? 'yes' : 'no'}`);
      return Promise.resolve(initialValue);
    },
  };
}
