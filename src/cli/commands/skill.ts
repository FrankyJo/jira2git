import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Command } from 'commander';
import { latestCheckpoint } from '../../checkpoints/types';
import { Git2JiraError, UsageError } from '../../core/errors';
import { VERSION } from '../../core/version';
import { isOpen } from '../../delivery/draft';
import { resolveDeliveryMode } from '../../delivery/mode';
import { resolveDeliverySite } from '../../delivery/site';
import { resolveLanguage } from '../../localization/resolve';
import { ATLASSIAN_TOOLS, DEFAULT_MCP_SERVER_NAME, claudeToolPrefix } from '../../mcp/tools';
import { SKILL_USAGE, parseSkillArguments } from '../../skill/args';
import type { SkillInstallState } from '../../skill/types';
import { println, type CliContext } from '../context';
import { configs, draftSummary } from './report';

/**
 * `git2jira skill …`: the `/jira-report` Claude Code Skill.
 *
 * `install`, `uninstall`, `status`, and `verify` manage the user-level installation.
 * `context` is the Skill's first call in every run: it validates the `/jira-report`
 * arguments and resolves, read-only, everything the run depends on (repository, branch,
 * issue, mode, language, checkpoint, pending reports), so those decisions are the CLI's.
 */
export function createSkillCommand(ctx: CliContext): Command {
  const command = new Command('skill').description(
    'Install and check the /jira-report Claude Code Skill.',
  );
  const installer = () => ctx.container.resolve('skillInstaller');

  command
    .command('install')
    .description('Install or upgrade /jira-report for the current user (all repositories).')
    .option('--force', 'replace installed files that were changed since installation')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { force?: boolean; json?: boolean }) => {
      const result = await installer().install({ force: options.force === true });
      if (options.json) {
        println(ctx.stdout, JSON.stringify(result, null, 2));
        return;
      }
      const { skillDir, agentPath } = result.state;
      const verb = {
        installed: 'Installed',
        upgraded: 'Upgraded',
        repaired: 'Repaired',
        unchanged: 'Already up to date:',
      }[result.action];
      println(ctx.stdout, `${verb} /jira-report ${describeVersion(result.state)}`);
      println(ctx.stdout, `  Skill:    ${skillDir}`);
      println(ctx.stdout, `  Subagent: ${agentPath}`);
      for (const file of result.keptFiles) {
        println(ctx.stdout, `  Kept your file: ${file}`);
      }
      println(ctx.stdout, 'Start Claude Code in any Git repository and run /jira-report.');
    });

  command
    .command('uninstall')
    .description('Remove /jira-report (only the files Git2Jira installed).')
    .option('--force', 'also remove installed files that were changed since installation')
    .action(async (options: { force?: boolean }) => {
      const result = await installer().uninstall({ force: options.force === true });
      if (!result.removed) {
        println(ctx.stdout, '/jira-report is not installed. Nothing was removed.');
        return;
      }
      println(ctx.stdout, 'Removed /jira-report.');
      for (const file of result.keptFiles) {
        println(ctx.stdout, `  Kept (not installed by Git2Jira): ${file}`);
      }
    });

  command
    .command('status')
    .description('Show whether /jira-report is installed and current.')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const state = await installer().status();
      if (options.json) {
        println(ctx.stdout, JSON.stringify({ cliVersion: VERSION, ...state }, null, 2));
        return;
      }
      println(ctx.stdout, `/jira-report: ${describeState(state)}`);
      println(ctx.stdout, `  Skill:    ${state.skillDir}`);
      println(ctx.stdout, `  Subagent: ${state.agentPath}`);
    });

  command
    .command('verify')
    .description(
      'Check the installed Skill against this CLI, and scan Claude Code permission rules that would skip approvals.',
    )
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const { globalConfig } = await configs(ctx);
      const root = await ctx.container
        .resolve('repositoryLocator')
        .locate(ctx.cwd)
        .then((r) => r.root)
        .catch(() => undefined);
      const result = await installer().verify({
        projectSettingsFiles: root
          ? [
              path.join(root, '.claude', 'settings.json'),
              path.join(root, '.claude', 'settings.local.json'),
            ]
          : [],
        mcpServers: [globalConfig.mcp?.server ?? DEFAULT_MCP_SERVER_NAME],
      });
      if (options.json) {
        println(ctx.stdout, JSON.stringify(result, null, 2));
      } else {
        println(ctx.stdout, `/jira-report: ${describeState(result.state)}`);
        for (const problem of result.problems) println(ctx.stdout, `  Problem: ${problem}`);
        for (const warning of result.warnings) println(ctx.stdout, `  Warning: ${warning}`);
        if (result.ok && result.warnings.length === 0) println(ctx.stdout, '  All checks passed.');
      }
      if (!result.ok)
        throw new Git2JiraError('The installed /jira-report Skill did not pass verification.');
    });

  command
    .command('context')
    .description(
      'Used by /jira-report: validate its arguments and resolve the run (read-only, JSON).',
    )
    .option('--args <text>', `the /jira-report arguments, as typed (${SKILL_USAGE})`, '')
    .option('--json', 'print machine-readable JSON (always JSON)')
    .action(async (options: { args: string }) => {
      println(ctx.stdout, JSON.stringify(await skillContext(ctx, options.args), null, 2));
    });

  return command;
}

async function skillContext(ctx: CliContext, rawArgs: string) {
  const args = parseSkillArguments(rawArgs);
  const { repoConfig, globalConfig } = await configs(ctx);
  const mode = resolveDeliveryMode({ override: args.mode, repoConfig, globalConfig });
  if (mode.mode === 'api-token') {
    throw new UsageError(
      `jira.mode is "api-token" (${mode.source} configuration). /jira-report delivers in manual or MCP mode: ` +
        'run "/jira-report --mode manual" or "/jira-report --mode mcp", or publish with a token from a ' +
        'terminal with "git2jira report --mode api-token".',
    );
  }
  const language = resolveLanguage({ override: args.language, repoConfig, globalConfig });
  const lifecycle = ctx.container.resolve('publicationLifecycle');
  const identity = await lifecycle.identify({
    cwd: ctx.cwd,
    issue: args.issue,
    projectKeys: repoConfig.issue?.projectKeys,
  });
  const { repository, issueKey } = identity;

  // MCP mode without a configured site: the Skill picks one from the sites the
  // Atlassian account can see, with the user. Manual mode can always proceed.
  let site: { url: string | null; placeholder: boolean; source: string; id: string | null };
  try {
    const resolved = resolveDeliverySite({
      mode: mode.mode,
      repositorySite: repoConfig.jira?.site,
      globalSite: globalConfig.jira?.site,
      historySites: identity.historySites,
    });
    site = {
      url: resolved.placeholder ? null : resolved.site.url,
      placeholder: resolved.placeholder,
      source: resolved.source,
      id: resolved.site.id,
    };
  } catch (error) {
    if (!(error instanceof UsageError) || mode.mode !== 'mcp') throw error;
    site = { url: null, placeholder: true, source: 'choose-from-mcp', id: null };
  }

  let checkpoint = null;
  if (site.id !== null) {
    const journal = await ctx.container
      .resolve('lineageStore')
      .read(repository, site.id, issueKey)
      .catch(() => undefined);
    const latest = latestCheckpoint(journal);
    if (latest) {
      checkpoint = {
        sequence: latest.sequence,
        publishedAt: latest.publication.publishedAt,
        confirmedBy: latest.publication.confirmedBy ?? 'jira-api',
        snapshotId: latest.snapshot.commit,
      };
    }
  }

  const pending = (await ctx.container.resolve('deliveryService').list(ctx.cwd))
    .filter((d) => isOpen(d) && d.issueKey === issueKey)
    .map(draftSummary);

  const server = globalConfig.mcp?.server ?? DEFAULT_MCP_SERVER_NAME;
  const prefix = claudeToolPrefix(server);
  const verification = await ctx.container.resolve('mcpVerificationStore').read();

  const warnings: string[] = [];
  let skill: Record<string, unknown>;
  try {
    const state = await ctx.container.resolve('skillInstaller').status();
    skill = { ...stateSummary(state), matchesCli: state.state === 'installed' };
    if (state.state !== 'installed') {
      warnings.push(
        `/jira-report installation: ${describeState(state)}. See "git2jira skill status".`,
      );
    }
  } catch (error) {
    skill = { state: 'unknown', matchesCli: false, error: (error as Error).message };
  }

  return {
    result: 'context',
    cli: { version: VERSION },
    skill,
    arguments: {
      language: args.language ?? null,
      mode: args.mode ?? null,
      issue: args.issue ?? null,
    },
    repository: { root: repository.root, worktree: repository.gitDir !== repository.commonDir },
    branch: repository.branch,
    issue: { key: issueKey, source: identity.issueSource },
    mode: { value: mode.mode, source: mode.source },
    language: { value: language.language, source: language.source },
    site: { url: site.url, placeholder: site.placeholder, source: site.source },
    checkpoint,
    pending,
    mcp: {
      server,
      tools: Object.fromEntries(
        Object.entries(ATLASSIAN_TOOLS).map(([capability, name]) => [
          capability,
          `${prefix}${name}`,
        ]),
      ),
      lastVerification: verification
        ? { state: verification.state, verifiedAt: verification.verifiedAt }
        : null,
    },
    heredocDelimiter: `GIT2JIRA_JSON_${randomBytes(6).toString('hex').toUpperCase()}`,
    nextStep: pending.length > 0 ? 'resume' : mode.mode === 'mcp' ? 'mcp-access-check' : 'prepare',
    warnings,
  };
}

function stateSummary(state: SkillInstallState): Record<string, unknown> {
  const { skillDir: _dir, agentPath: _agent, ...rest } = state;
  return rest;
}

function describeVersion(state: SkillInstallState): string {
  return state.state === 'installed' ? state.version : '';
}

function describeState(state: SkillInstallState): string {
  switch (state.state) {
    case 'installed':
      return `installed (${state.version})`;
    case 'not-installed':
      return 'not installed (run "git2jira skill install")';
    case 'outdated':
      return `outdated (${state.installedVersion}; this CLI ships ${state.currentVersion})`;
    case 'modified':
      return `modified since installation (${[...state.modifiedFiles, ...state.missingFiles].join(', ')})`;
    case 'conflict':
      return `conflict: ${state.reason}`;
  }
}
