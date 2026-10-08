import { Command } from 'commander';
import { jiraSiteFromUrl } from '../../checkpoints/site';
import type { Baseline, JiraSite } from '../../checkpoints/types';
import { findRepositoryRoot } from '../../config/paths';
import { terminalSafeLine } from '../../core/sanitize';
import type { JiraIssue } from '../../jira/client/types';
import {
  AmbiguousConnectionError,
  NoConnectionError,
  type JiraConnection,
} from '../../jira/connections';
import { IssueNotFoundError } from '../../publication/errors';
import type { Analysis } from '../../publication/lifecycle';
import { JiraNotFoundError } from '../../jira/client/errors';
import type { FileChange } from '../../snapshots/types';
import { println, type CliContext } from '../context';

interface StatusOptions {
  issue?: string;
  base?: string;
  site?: string;
  connection?: string;
  jira?: boolean;
  acceptBranchChange?: boolean;
  json?: boolean;
}

/**
 * Read-only preview of the next report: which issue, which baseline, and what
 * changed since then. Captures the working tree without creating any refs and
 * without touching the index, HEAD, or files.
 */
export function createStatusCommand(ctx: CliContext): Command {
  return new Command('status')
    .description('Show the issue, baseline, and changes the next report would cover.')
    .option('-i, --issue <key>', 'Jira issue key (default: detected from the branch name)')
    .option('-b, --base <branch>', 'base branch for the first report of an issue')
    .option('-c, --connection <name>', 'Jira connection to use')
    .option('--site <url>', 'Jira site URL (default: selected connection or jira.site)')
    .option('--jira', 'also verify the issue in Jira and show its title (read-only)')
    .option('--accept-branch-change', 'continue history that was recorded on another branch')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: StatusOptions) => {
      const configStore = ctx.container.resolve('configStore');
      const root = await findRepositoryRoot(ctx.cwd);
      const repoConfig = root ? await configStore.readRepo(root) : {};
      const lifecycle = ctx.container.resolve('publicationLifecycle');
      const identity = await lifecycle.identify({
        cwd: ctx.cwd,
        issue: options.issue,
        projectKeys: repoConfig.issue?.projectKeys,
      });

      // Status works without any Jira connection; selection only picks the site when it can.
      let connection: JiraConnection | undefined;
      let site: JiraSite | undefined;
      try {
        connection = (
          await ctx.container.resolve('jiraConnections').select({
            connection: options.connection,
            site: options.site,
            repositorySite: repoConfig.jira?.site,
            historySites: identity.historySites,
            issueKey: identity.issueKey,
          })
        ).connection;
        site = connection.site;
      } catch (error) {
        if (options.connection !== undefined || options.jira) throw error;
        if (!(error instanceof NoConnectionError || error instanceof AmbiguousConnectionError))
          throw error;
        const fallback = options.site ?? repoConfig.jira?.site;
        site = fallback ? jiraSiteFromUrl(fallback) : undefined;
      }

      const analysis = await lifecycle.analyze({
        cwd: ctx.cwd,
        issue: options.issue,
        base: options.base,
        configuredBase: repoConfig.base?.branch,
        projectKeys: repoConfig.issue?.projectKeys,
        site,
        acceptBranchChange: options.acceptBranchChange,
      });

      let issue: JiraIssue | undefined;
      if (options.jira && connection) {
        const { client } = ctx.container.resolve('jiraConnections').session(connection);
        try {
          issue = await client.getIssue(analysis.context.issueKey);
        } catch (error) {
          if (error instanceof JiraNotFoundError)
            throw new IssueNotFoundError(analysis.context.issueKey, connection.site.url);
          throw error;
        }
      }

      if (options.json) {
        println(ctx.stdout, JSON.stringify(toJson(analysis, connection, issue), null, 2));
      } else {
        printHuman(ctx, analysis, connection, issue);
      }
    });
}

function describeBaseline(baseline: Baseline): string {
  switch (baseline.kind) {
    case 'checkpoint':
      return `report #${String(baseline.sequence)} (last published checkpoint)`;
    case 'merge-base':
      return `merge base with ${baseline.baseName} (${baseline.mergeBase.slice(0, 12)}); first report`;
    case 'empty':
      return 'empty repository; first report';
  }
}

const STATUS_LETTER: Record<FileChange['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  'type-changed': 'T',
};

function describeFile(file: FileChange): string {
  const name = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
  const detail: string[] = [];
  if (file.binary) detail.push('binary');
  else if (file.kind !== 'submodule')
    detail.push(`+${String(file.additions)} −${String(file.deletions)}`);
  if (file.kind !== 'file') detail.push(file.kind);
  if (file.modeChanged) detail.push('mode changed');
  return `  ${STATUS_LETTER[file.status]}  ${name} (${detail.join(', ')})`;
}

function printHuman(
  ctx: CliContext,
  analysis: Analysis,
  connection: JiraConnection | undefined,
  issue: JiraIssue | undefined,
): void {
  const { context, changeSet } = analysis;
  const out = (line = '') => {
    println(ctx.stdout, line);
  };
  out(`Repository: ${context.repository.root}`);
  out(`Branch:     ${context.branch.name}`);
  out(
    `Issue:      ${context.issueKey} (${context.issueSource === 'option' ? '--issue' : 'from branch name'})`,
  );
  out(
    `Jira site:  ${context.site?.url ?? '(not configured)'}` +
      (connection ? ` (connection "${connection.name}")` : ''),
  );
  if (issue) {
    out(
      `Jira issue: ${terminalSafeLine(issue.summary)}` +
        (issue.status ? ` [${terminalSafeLine(issue.status, 40)}]` : ''),
    );
  }
  out(`Baseline:   ${describeBaseline(analysis.baseline)}`);
  if (context.branchChange) {
    out(
      `Note:       history was recorded on "${context.branchChange.from}"` +
        (context.branchChange.renamed ? ' (branch renamed)' : ''),
    );
  }
  for (const record of context.unresolved) {
    out(
      `Warning:    report #${String(record.sequence)} is "${record.state}"; run "git2jira recover" before publishing.`,
    );
  }
  out();
  if (!analysis.hasChanges) {
    out('No changes since the baseline. Nothing to report.');
    return;
  }
  const additions = changeSet.files.reduce((n, f) => n + f.additions, 0);
  const deletions = changeSet.files.reduce((n, f) => n + f.deletions, 0);
  out(
    `Report #${String(analysis.nextSequence)} would cover ${String(changeSet.files.length)} file(s) ` +
      `(+${String(additions)} −${String(deletions)}), ${String(changeSet.commits.length)} commit(s)` +
      (analysis.snapshot.includesUncommittedChanges ? ', including uncommitted changes' : '') +
      ':',
  );
  for (const file of changeSet.files) out(describeFile(file));
  if (changeSet.patchTruncated)
    out('\nThe diff exceeds the analysis budget and will be truncated.');
}

function toJson(
  analysis: Analysis,
  connection: JiraConnection | undefined,
  issue: JiraIssue | undefined,
) {
  const { context, changeSet } = analysis;
  return {
    connection: connection?.name ?? null,
    jiraIssue: issue
      ? { id: issue.id, summary: issue.summary, status: issue.status ?? null }
      : null,
    repository: context.repository.root,
    branch: context.branch.name,
    issueKey: context.issueKey,
    issueSource: context.issueSource,
    site: context.site?.url ?? null,
    baseline: analysis.baseline,
    branchChange: context.branchChange ?? null,
    unresolved: context.unresolved.map((r) => ({
      reportId: r.reportId,
      sequence: r.sequence,
      state: r.state,
    })),
    hasChanges: analysis.hasChanges,
    nextSequence: analysis.nextSequence,
    includesUncommittedChanges: analysis.snapshot.includesUncommittedChanges,
    files: changeSet.files,
    commits: changeSet.commits,
    commitsTruncated: changeSet.commitsTruncated,
    patchBytes: Buffer.byteLength(changeSet.patch),
    patchTruncated: changeSet.patchTruncated,
  };
}
