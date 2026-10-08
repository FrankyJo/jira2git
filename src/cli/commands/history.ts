import { Command } from 'commander';
import type { HistoryView, RecoveryAction } from '../../publication/types';
import { println, type CliContext } from '../context';
import { addTargetOptions, targetSelection, type TargetOptions } from './selection';

/** `git2jira history`: published reports for the issue, cross-checked against Jira by default. */
export function createHistoryCommand(ctx: CliContext): Command {
  return addTargetOptions(
    new Command('history').description('List reports published for the current issue.'),
  )
    .option('--offline', 'show local history only; do not contact Jira')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: TargetOptions & { offline?: boolean; json?: boolean }) => {
      const view = await ctx.container
        .resolve('publicationService')
        .history(await targetSelection(ctx, options), { remote: !options.offline });
      if (options.json) {
        println(ctx.stdout, JSON.stringify(historyJson(view), null, 2));
        return;
      }
      printHistory(ctx, view);
    });
}

function printHistory(ctx: CliContext, view: HistoryView): void {
  const out = (line = '') => {
    println(ctx.stdout, line);
  };
  out(`Issue ${view.issueKey} on ${view.site.url}`);
  if (view.entries.length === 0 && view.openPlans.length === 0) out('No reports yet.');
  for (const { record, commentUrl, inJira } of view.entries) {
    const when = record.publication?.publishedAt ?? record.updatedAt;
    const remote = inJira === undefined ? '' : inJira ? '  [in Jira]' : '  [NOT FOUND in Jira]';
    out(
      `#${String(record.sequence)}  ${record.state.padEnd(10)}  ${when}  ${commentUrl ?? '-'}${remote}`,
    );
  }
  for (const plan of view.openPlans) {
    out(`(unpublished)  ${plan.status.padEnd(16)}  ${plan.updatedAt}  report ${plan.reportId}`);
  }
  if (view.remote) {
    const known = new Set(view.entries.map((e) => e.record.reportId));
    for (const report of view.remote.reports.filter((r) => !known.has(r.reportId))) {
      out(
        `Jira has report #${String(report.sequence)} (comment ${report.commentId}) that is not in this repository's history.`,
      );
    }
    if (view.remote.error) out(`Warning: could not read Jira comments: ${view.remote.error}`);
    else if (!view.remote.complete) out('Warning: not all Jira comments could be read.');
  }
  if (view.entries.some((e) => e.record.state === 'publishing' || e.record.state === 'confirmed')) {
    out('Some reports are not settled; run "git2jira recover".');
  }
}

function historyJson(view: HistoryView) {
  return {
    issueKey: view.issueKey,
    site: view.site.url,
    reports: view.entries.map(({ record, plan, commentUrl, inJira }) => ({
      reportId: record.reportId,
      sequence: record.sequence,
      state: record.state,
      status: plan?.status ?? null,
      commentId: record.publication?.commentId ?? null,
      commentUrl: commentUrl ?? null,
      publishedAt: record.publication?.publishedAt ?? null,
      snapshotTree: record.snapshot.tree,
      inJira: inJira ?? null,
    })),
    openPlans: view.openPlans.map((p) => ({ reportId: p.reportId, status: p.status })),
    remote: view.remote
      ? {
          complete: view.remote.complete,
          error: view.remote.error ?? null,
          reports: view.remote.reports.map((r) => ({
            reportId: r.reportId,
            sequence: r.sequence,
            commentId: r.commentId,
            source: r.source,
          })),
        }
      : null,
  };
}

/** `git2jira recover`: repairs local state and settles interrupted publications. Never posts comments. */
export function createRecoverCommand(ctx: CliContext): Command {
  return addTargetOptions(
    new Command('recover').description(
      'Reconcile interrupted publications with Jira and rebuild lost checkpoints. Never posts comments.',
    ),
  )
    .option('--json', 'print machine-readable JSON')
    .action(async (options: TargetOptions & { json?: boolean }) => {
      const summary = await ctx.container
        .resolve('publicationService')
        .recover(await targetSelection(ctx, options));
      if (options.json) {
        println(ctx.stdout, JSON.stringify({ ...summary, site: summary.site.url }, null, 2));
        return;
      }
      println(ctx.stdout, `Recovery for ${summary.issueKey} on ${summary.site.url}:`);
      if (summary.actions.length === 0) println(ctx.stdout, '  Nothing to repair.');
      for (const action of summary.actions) println(ctx.stdout, `  ${describeAction(action)}`);
      if (summary.remoteError) {
        println(
          ctx.stdout,
          `  Jira could not be checked (${summary.remoteError}); local repairs were applied.`,
        );
      }
    });
}

function describeAction(action: RecoveryAction): string {
  switch (action.kind) {
    case 'recovered':
      return `Report #${String(action.sequence)} was found in Jira and recorded: ${action.commentUrl}`;
    case 'not-published':
      return `Report #${String(action.sequence)} is not in Jira; it was marked FAILED and can be published again.`;
    case 'still-uncertain':
      return `Report #${String(action.sequence)} is still UNCERTAIN (${action.reason}). Nothing was re-sent.`;
    case 'promoted':
      return `Checkpoint promoted for report ${action.reportId}.`;
    case 'property-restored':
      return `Restored report metadata on comment ${action.commentId}.`;
    case 'plan-synced':
      return `Report ${action.reportId} marked ${action.status}.`;
    case 'duplicate':
      return `Report ${action.reportId} appears in several comments (${action.commentIds.join(', ')}); the earliest is used. Delete the others in Jira if they are unwanted.`;
    case 'remote-only':
      return `Jira has report #${String(action.sequence)} (comment ${action.commentId}) that this repository has no record of (another clone or machine?).`;
    case 'missing-in-jira':
      return `Comment ${action.commentId} of report ${action.reportId} is no longer in Jira (deleted?). Local history is kept.`;
    case 'rebuilt-journal':
      return 'Rebuilt report history from checkpoint refs.';
    case 'quarantined':
      return `Moved a corrupted history file aside: ${action.file}`;
    case 'removed-candidate':
      return `Removed abandoned snapshot ref ${action.ref}.`;
    case 'unreadable-ref':
      return `Could not read checkpoint ref ${action.ref}; left untouched.`;
  }
}
