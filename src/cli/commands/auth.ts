import { Command, Option } from 'commander';
import { jiraSiteFromUrl } from '../../checkpoints/site';
import { UsageError } from '../../core/errors';
import { terminalSafeLine } from '../../core/sanitize';
import { ConnectionNameSchema, ProjectKeySchema } from '../../config/schema';
import type { JiraAuthStatus } from '../../jira/auth/types';
import { println, type CliContext } from '../context';

interface LoginOptions {
  connection?: string;
  site?: string;
  email?: string;
  tokenStdin?: boolean;
  tokenType: 'auto' | 'classic' | 'scoped';
  project?: string[];
  default?: boolean;
}

const MAX_TOKEN_BYTES = 8 * 1024;

/**
 * `git2jira login`: verifies an Atlassian API token against Jira, stores it in
 * the OS credential store, and saves the non-secret connection settings. The
 * token is read from a masked prompt or stdin, never from a command-line
 * argument (which would end up in shell history and the process list).
 */
export function createLoginCommand(ctx: CliContext): Command {
  return new Command('login')
    .description(
      'Connect to a Jira Cloud site with an API token stored in the OS credential store.',
    )
    .option(
      '-c, --connection <name>',
      'connection name (default: the default connection, or "default")',
    )
    .option('--site <url>', 'Jira Cloud site, e.g. https://example.atlassian.net')
    .option('--email <email>', 'Atlassian account email')
    .option('--token-stdin', 'read the API token from stdin instead of prompting')
    .addOption(
      new Option('--token-type <type>', 'API token type')
        .choices(['auto', 'classic', 'scoped'])
        .default('auto'),
    )
    .option('--project <keys...>', 'route issues of these projects to this connection')
    .option('--default', 'make this the default connection')
    .addHelpText(
      'after',
      '\nAtlassian MCP and manual modes need no "git2jira login". MCP is authorized with OAuth inside\n' +
        'Claude Code: run /mcp, select the Atlassian server, and choose Authenticate.',
    )
    .action(async (options: LoginOptions) => {
      const configStore = ctx.container.resolve('configStore');
      const global = await configStore.readGlobal();
      if (global.jira?.mode !== 'api-token') {
        println(
          ctx.stderr,
          `Note: Jira mode is "${global.jira?.mode ?? 'manual'}". ` +
            (global.jira?.mode === 'mcp'
              ? 'Atlassian MCP is authorized with OAuth in Claude Code (/mcp → Authenticate), not with "git2jira login". '
              : 'Manual mode needs no Jira sign-in. ') +
            '"git2jira login" sets up the optional personal API-token mode.',
        );
      }
      const name = options.connection ?? global.jira?.defaultConnection ?? 'default';
      if (!ConnectionNameSchema.safeParse(name).success) {
        throw new UsageError(
          `Invalid connection name "${name}": use lowercase letters, digits, "-" or "_".`,
        );
      }
      const projectKeys = (options.project ?? []).map((key) => {
        if (!ProjectKeySchema.safeParse(key).success)
          throw new UsageError(`Invalid project key "${key}".`);
        return key;
      });
      const existing = global.jira?.connections?.[name];
      const interactive = ctx.interactive === true && !options.tokenStdin;
      const prompter = () => ctx.container.resolve('prompter');

      let siteUrl = options.site ?? existing?.siteUrl;
      if (siteUrl === undefined) {
        if (!interactive) throw new UsageError('Pass --site <url> (no interactive terminal).');
        siteUrl = await prompter().text('Jira Cloud site URL', {
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
      }
      const site = jiraSiteFromUrl(siteUrl);
      // Never silently re-point an existing connection at another site.
      if (
        options.connection === undefined &&
        existing &&
        jiraSiteFromUrl(existing.siteUrl).id !== site.id
      ) {
        throw new UsageError(
          `Connection "${name}" is for ${existing.siteUrl}. Pass --connection <new-name> to add ${site.url}.`,
        );
      }

      let email = options.email ?? (existing?.siteUrl === site.url ? existing.email : undefined);
      if (email === undefined) {
        if (!interactive) throw new UsageError('Pass --email <email> (no interactive terminal).');
        email = await prompter().text('Atlassian account email', {
          validate: (value) =>
            /^[^\s@]+@[^\s@]+$/.test(value) ? undefined : 'Enter an email address.',
        });
      }

      let token: string;
      if (options.tokenStdin) {
        if (!ctx.stdin) throw new UsageError('No standard input is available for --token-stdin.');
        token = await readSecret(ctx.stdin);
      } else if (interactive) {
        prompter().note(
          'Create a token at https://id.atlassian.com/manage-profile/security/api-tokens.\n' +
            'It is verified with Jira, then stored only in your OS credential store.',
          'Jira API token',
        );
        token = (await prompter().password('API token')).trim();
      } else {
        throw new UsageError('No interactive terminal: pipe the token and pass --token-stdin.');
      }
      if (token === '') throw new UsageError('The API token is empty.');

      const result = await ctx.container.resolve('jiraConnections').login({
        name,
        siteUrl: site.url,
        email,
        token,
        tokenType: options.tokenType,
        projectKeys,
        makeDefault: options.default,
      });
      const backend = ctx.container.resolve('credentialStore').backend;
      println(
        ctx.stdout,
        `Signed in to ${result.connection.site.url} as ${terminalSafeLine(result.user.displayName)} ` +
          `(connection "${name}", ${result.connection.config.tokenType ?? 'classic'} token${result.isDefault ? ', default' : ''}).`,
      );
      println(
        ctx.stdout,
        `The token is stored in the ${backend}; no configuration file contains it.`,
      );
    });
}

export function createLogoutCommand(ctx: CliContext): Command {
  return new Command('logout')
    .description('Remove stored Jira credentials.')
    .option('-c, --connection <name>', 'connection to sign out (default: the default connection)')
    .option('--all', 'sign out of every connection')
    .option('--forget', 'also remove the connection settings (site, email)')
    .action(async (options: { connection?: string; all?: boolean; forget?: boolean }) => {
      const manager = ctx.container.resolve('jiraConnections');
      const { connections, defaultConnection } = await manager.list();
      let names: string[];
      if (options.all) names = connections.map((c) => c.name);
      else {
        const name =
          options.connection ??
          defaultConnection ??
          (connections.length === 1 ? connections[0]?.name : undefined);
        if (name === undefined) {
          throw new UsageError(
            connections.length === 0
              ? 'No Jira connection is configured.'
              : 'Pass --connection <name> or --all.',
          );
        }
        names = [name];
      }
      if (names.length === 0) {
        println(ctx.stdout, 'No Jira connection is configured.');
        return;
      }
      for (const name of names) {
        const { removedSecret } = await manager.logout(name, options.forget === true);
        println(
          ctx.stdout,
          `${name}: ${removedSecret ? 'token removed from the credential store' : 'no stored token'}` +
            (options.forget ? '; connection settings removed.' : '.'),
        );
      }
    });
}

export function createConnectionsCommand(ctx: CliContext): Command {
  return new Command('connections')
    .description('List Jira connections; --check verifies their credentials with Jira (read-only).')
    .option('--check', 'verify each connection with Jira')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { check?: boolean; json?: boolean }) => {
      const manager = ctx.container.resolve('jiraConnections');
      const { connections, defaultConnection } = await manager.list();
      const rows: {
        name: string;
        site: string;
        email: string | null;
        tokenType: string | null;
        default: boolean;
        projectKeys: string[];
        status?: JiraAuthStatus;
      }[] = [];
      for (const connection of connections) {
        rows.push({
          name: connection.name,
          site: connection.site.url,
          email: connection.config.email ?? null,
          tokenType: connection.config.tokenType ?? null,
          default: connection.name === defaultConnection,
          projectKeys: connection.config.projectKeys ?? [],
          ...(options.check ? { status: await manager.check(connection) } : {}),
        });
      }
      if (options.json) {
        println(
          ctx.stdout,
          JSON.stringify(
            { defaultConnection: defaultConnection ?? null, connections: rows },
            null,
            2,
          ),
        );
        return;
      }
      if (rows.length === 0) {
        println(ctx.stdout, 'No Jira connections. Run "git2jira login".');
        return;
      }
      for (const row of rows) {
        const flags = [
          row.default ? 'default' : undefined,
          row.tokenType ? `${row.tokenType} token` : undefined,
          row.projectKeys.length > 0 ? `projects ${row.projectKeys.join(',')}` : undefined,
        ].filter(Boolean);
        println(
          ctx.stdout,
          `${row.name}  ${row.site}  ${row.email ?? ''}  ${flags.length ? `(${flags.join(', ')})` : ''}`.trimEnd(),
        );
        if (row.status) println(ctx.stdout, `  ${describeStatus(row.status)}`);
      }
    });
}

export function describeStatus(status: JiraAuthStatus): string {
  switch (status.state) {
    case 'signed-in':
      return `signed in as ${terminalSafeLine(status.account.displayName)}`;
    case 'signed-out':
      return 'signed out: no stored token (run "git2jira login")';
    case 'rejected':
      return `rejected: ${status.reason}`;
    case 'unavailable':
      return `could not check: ${status.reason}`;
  }
}

async function readSecret(stream: AsyncIterable<Buffer | string>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (Buffer.byteLength(text) > MAX_TOKEN_BYTES)
      throw new UsageError('The token on stdin is too long.');
  }
  return text.trim();
}
