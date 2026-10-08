import type { Command } from 'commander';
import { findRepositoryRoot } from '../../config/paths';
import type { TargetSelection } from '../../publication/types';
import type { CliContext } from '../context';

export interface TargetOptions {
  issue?: string;
  connection?: string;
  site?: string;
}

/** Options shared by commands that act on one issue of one Jira site. */
export function addTargetOptions(command: Command): Command {
  return command
    .option('-i, --issue <key>', 'Jira issue key (default: detected from the branch name)')
    .option('-c, --connection <name>', 'Jira connection to use (see "git2jira connections")')
    .option('--site <url>', 'Jira site URL; selects the connection for that site');
}

/** Combines command options with repository configuration (`jira.site`, `issue.projectKeys`). */
export async function targetSelection(
  ctx: CliContext,
  options: TargetOptions,
): Promise<TargetSelection> {
  const root = await findRepositoryRoot(ctx.cwd);
  const repoConfig = root ? await ctx.container.resolve('configStore').readRepo(root) : {};
  return {
    cwd: ctx.cwd,
    issue: options.issue,
    connection: options.connection,
    site: options.site,
    repositorySite: repoConfig.jira?.site,
    projectKeys: repoConfig.issue?.projectKeys,
  };
}
