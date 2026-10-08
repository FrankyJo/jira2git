import { Command, Option } from 'commander';
import { McpProbeSchema } from '../../mcp/bridge';
import { McpSetupService, type McpRegistrationState } from '../../mcp/setup';
import { ATLASSIAN_MCP_ENDPOINT, DEFAULT_MCP_SERVER_NAME } from '../../mcp/tools';
import { assessMcpAccess } from '../../mcp/verification';
import { resolveDeliveryMode } from '../../delivery/mode';
import { findRepositoryRoot } from '../../config/paths';
import { UsageError } from '../../core/errors';
import { println, type CliContext } from '../context';
import { readJson } from './report';

/**
 * `git2jira mcp …`: the Atlassian Rovo MCP connection of Claude Code.
 *
 * The CLI can see and create the registration (through `claude mcp`), but not the
 * OAuth authorization, which lives inside Claude Code. Only `mcp verify`, fed by
 * read-only tool calls made in a Claude Code session, can say whether access works.
 */
export function createMcpCommand(ctx: CliContext): Command {
  const command = new Command('mcp').description(
    'Set up and check the Atlassian MCP connection used by MCP mode.',
  );
  const setup = () => new McpSetupService(ctx.container.resolve('claudeMcpRegistry'));

  command
    .command('status')
    .description('Show Claude Code, the Atlassian MCP registration, and the last verification.')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const configStore = ctx.container.resolve('configStore');
      const global = await configStore.readGlobal();
      const root = await findRepositoryRoot(ctx.cwd);
      const repo = root ? await configStore.readRepo(root) : {};
      const mode = resolveDeliveryMode({ repoConfig: repo, globalConfig: global });
      const registration = await setup().inspect(global.mcp?.server ?? DEFAULT_MCP_SERVER_NAME);
      const verification = await ctx.container.resolve('mcpVerificationStore').read();
      if (options.json) {
        println(
          ctx.stdout,
          JSON.stringify({ mode, registration, verification: verification ?? null }, null, 2),
        );
        return;
      }
      println(ctx.stdout, `Jira mode:        ${mode.mode} (${mode.source})`);
      println(ctx.stdout, `MCP registration: ${describeRegistration(registration)}`);
      println(
        ctx.stdout,
        verification
          ? `Last verification: ${verification.state} at ${verification.verifiedAt}`
          : 'Last verification: never (run /jira-report in Claude Code, which verifies access)',
      );
      for (const message of verification?.messages ?? []) println(ctx.stdout, `  ${message}`);
      println(
        ctx.stdout,
        'OAuth sign-in happens inside Claude Code and cannot be checked from here.',
      );
    });

  command
    .command('setup')
    .description(
      `Register the official Atlassian MCP server (${ATLASSIAN_MCP_ENDPOINT}) in Claude Code.`,
    )
    .option('--name <name>', 'server name to use', DEFAULT_MCP_SERVER_NAME)
    .addOption(
      new Option('--scope <scope>', 'Claude Code configuration scope')
        .choices(['user', 'local', 'project'])
        .default('user'),
    )
    .option('-y, --yes', 'register without asking')
    .action(
      async (options: { name: string; scope: 'user' | 'local' | 'project'; yes?: boolean }) => {
        if (!options.yes && ctx.interactive !== true) {
          throw new UsageError('Pass --yes to register without an interactive terminal.');
        }
        const result = await setup().ensureRegistered({
          name: options.name,
          scope: options.scope,
          confirm: (message) =>
            options.yes
              ? Promise.resolve(true)
              : ctx.container.resolve('prompter').confirm(message, true),
        });
        const configStore = ctx.container.resolve('configStore');
        const remember = async (name: string) => {
          const global = await configStore.readGlobal();
          if (global.mcp?.server !== name)
            await configStore.writeGlobal({ ...global, mcp: { server: name } });
        };
        switch (result.kind) {
          case 'claude-not-installed':
            throw new UsageError(
              'Claude Code is not installed (no "claude" command). Install it, or use manual mode: git2jira config set jira.mode manual',
            );
          case 'failed':
            throw new UsageError(`Could not register the MCP server: ${result.error}`);
          case 'declined':
            println(ctx.stdout, 'Nothing was changed.');
            return;
          case 'already-registered':
            await remember(result.entry.name);
            println(
              ctx.stdout,
              `Claude Code already has an Atlassian MCP server: "${result.entry.name}" (${result.entry.url ?? result.entry.target}). It was not changed.`,
            );
            if (!result.official) {
              println(
                ctx.stdout,
                `It does not use the current endpoint ${ATLASSIAN_MCP_ENDPOINT}; consider re-adding it yourself.`,
              );
            }
            break;
          case 'registered':
            await remember(result.name);
            println(
              ctx.stdout,
              `Registered "${result.name}" (${ATLASSIAN_MCP_ENDPOINT}) at ${result.scope} scope.`,
            );
        }
        for (const line of AUTH_STEPS) println(ctx.stdout, line);
      },
    );

  command
    .command('verify')
    .description('Assess MCP access from read-only probe results gathered in Claude Code.')
    .requiredOption('--input <file>', 'probe JSON written by the Skill, or - for stdin')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { input: string; json?: boolean }) => {
      const probe = McpProbeSchema.parse(await readJson(ctx, options.input));
      const assessment = assessMcpAccess(probe);
      await ctx.container.resolve('mcpVerificationStore').write({
        schemaVersion: 1,
        verifiedAt: new Date().toISOString(),
        state: assessment.state,
        ...(probe.server ? { server: probe.server } : {}),
        tools: assessment.tools,
        sites: assessment.sites.map((s) => ({
          cloudId: s.cloudId,
          url: s.url,
          ...(s.name ? { name: s.name } : {}),
        })),
        messages: assessment.messages,
      });
      if (options.json) {
        println(ctx.stdout, JSON.stringify(assessment, null, 2));
        return;
      }
      println(ctx.stdout, `MCP access: ${assessment.state}`);
      for (const message of assessment.messages) println(ctx.stdout, `  ${message}`);
      if (!assessment.publicationEnabled) {
        println(
          ctx.stdout,
          '  Automatic publication is off. Manual mode works without any Jira access.',
        );
      }
    });

  return command;
}

const AUTH_STEPS = [
  '',
  'Next, authorize it (this happens in your browser, inside Claude Code):',
  '  1. Start Claude Code and run /mcp.',
  '  2. Select the Atlassian server and choose "Authenticate"; sign in and approve access.',
  '  3. Run /jira-report; it checks Jira access before anything is published.',
  'Git2Jira cannot see whether the sign-in succeeded until a tool call from Claude Code works.',
  'If your organization blocks Rovo MCP, use manual mode: git2jira config set jira.mode manual',
];

function describeRegistration(state: McpRegistrationState): string {
  switch (state.kind) {
    case 'claude-not-installed':
      return 'Claude Code is not installed';
    case 'not-registered':
      return 'no Atlassian MCP server registered (run "git2jira mcp setup")';
    case 'unknown':
      return `could not be read (${state.error})`;
    case 'registered':
      return `"${state.entry.name}" ${state.entry.url ?? state.entry.target} — Claude Code reports: ${state.entry.status}${state.official ? '' : ' (not the current endpoint)'}`;
  }
}
