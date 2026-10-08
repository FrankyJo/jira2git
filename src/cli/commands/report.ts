import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command, Option } from 'commander';
import { findRepositoryRoot } from '../../config/paths';
import { includeUncommittedSetting } from '../../config/settings';
import type { GlobalConfig, RepoConfig } from '../../config/schema';
import { packageWarnings } from '../../ai/engine';
import { buildSessionRequest } from '../../ai/prompt';
import { redactSecrets } from '../../ai/redact';
import { Git2JiraError, UsageError } from '../../core/errors';
import { terminalSafe, terminalSafeLine } from '../../core/sanitize';
import { openInBrowser } from '../../delivery/browser';
import { copyToClipboard } from '../../delivery/clipboard';
import { isOpen, type Draft, type ManualDraft, type McpDraft } from '../../delivery/draft';
import { DELIVERY_MODES, resolveDeliveryMode } from '../../delivery/mode';
import type { DraftRecoveryAction, McpResultOutcome } from '../../delivery/service';
import { resolveDeliverySite } from '../../delivery/site';
import { SUPPORTED_LANGUAGES } from '../../localization/languages';
import { resolveLanguage } from '../../localization/resolve';
import type { RepositoryInfo } from '../../git/types';
import { DEFAULT_MCP_SERVER_NAME } from '../../mcp/tools';
import { mcpPublicationBlocker } from '../../mcp/verification';
import { stateDir } from '../../snapshots/engine';
import { println, type CliContext } from '../context';
import { exportDraft, runReport, type ReportRunOptions } from './report-run';

const MAX_INPUT_BYTES = 10 * 1024 * 1024;

/**
 * `git2jira report …`: the Skill-to-CLI bridge for manual and MCP delivery.
 *
 * The CLI owns snapshots, checkpoints, report state, and validation. The report text
 * is written by the user's Claude Code session (or any other source) and handed in
 * with `submit`. In MCP mode the session also calls the Atlassian tools and hands
 * their results back. Commands that move a checkpoint or authorize a Jira write
 * (`confirm`, `publish`, `record-result`, `reconcile`, `revoke`) must never be
 * pre-approved in a Skill: Claude Code's permission prompt is the user's approval.
 */
export function createReportCommand(ctx: CliContext): Command {
  const report = new Command('report')
    .description(
      'Write an incremental Jira report of the changes since the last confirmed one, preview it, and deliver it.',
    )
    // Options of "report" itself must come before a subcommand, so the subcommands keep theirs.
    .enablePositionalOptions()
    .option('--dry-run', 'analyze and write the report, but save nothing and move nothing')
    .addOption(
      new Option('-m, --mode <mode>', 'delivery mode for this report').choices(DELIVERY_MODES),
    )
    .addOption(new Option('-l, --language <code>', 'report language').choices(SUPPORTED_LANGUAGES))
    .option('-i, --issue <key>', 'Jira issue key (default: detected from the branch name)')
    .option('-b, --base <branch>', 'base branch for the first report of an issue')
    .option('--site <url>', 'Jira site URL (manual: optional)')
    .option('-c, --connection <name>', 'API-token mode: Jira connection to use')
    .option('--context <text>', 'optional context for the report writer (treated as data)')
    .option('--issue-title <text>', 'Jira issue title, if you want the writer to know it')
    .option('--issue-description <file>', 'file with the Jira issue description (treated as data)')
    .option(
      '--test-command <command>',
      'run this test command (no shell) and report its result; repeatable',
      (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
    )
    .option('--test-results <file>', 'test results to cite (reported, not verified)')
    .addOption(
      new Option('--ai <writer>', 'who writes the report')
        .choices(['auto', 'session', 'headless'])
        .default('auto'),
    )
    .option('--allow-api-billing', 'headless: accept API-key or third-party billing for this run')
    .option('--model <name>', 'headless: Claude model alias or name')
    .option('--accept-branch-change', 'continue history that was recorded on another branch')
    .option('--server <name>', 'MCP: Claude Code MCP server name')
    .option('--cloud-id <id>', 'MCP: Atlassian cloud id of the site')
    .option('--issue-lookup <file>', 'MCP: raw result of the issue lookup tool for this key')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: ReportRunOptions) => {
      await runReport(ctx, options);
    });
  const service = () => ctx.container.resolve('deliveryService');

  report
    .command('prepare')
    .description('Capture a snapshot of the changes since the last confirmed report.')
    .addOption(
      new Option('-m, --mode <mode>', 'delivery mode for this report').choices(DELIVERY_MODES),
    )
    .addOption(new Option('-l, --language <code>', 'report language').choices(SUPPORTED_LANGUAGES))
    .option('-i, --issue <key>', 'Jira issue key (default: detected from the branch name)')
    .option('-b, --base <branch>', 'base branch for the first report of an issue')
    .option('--site <url>', 'Jira site URL (manual: optional; MCP: required unless configured)')
    .option('--context <text>', 'optional context for the report writer')
    .option('--accept-branch-change', 'continue history that was recorded on another branch')
    .option('--server <name>', 'MCP: Claude Code MCP server name')
    .option('--cloud-id <id>', 'MCP: Atlassian cloud id of the site')
    .option('--issue-lookup <file>', 'MCP: raw result of the issue lookup tool for this key')
    .option('--json', 'print the generation request as JSON')
    .action(async (options: PrepareOptions) => {
      const { repoConfig, globalConfig } = await configs(ctx);
      const { mode } = resolveDeliveryMode({
        override: options.mode,
        repoConfig,
        globalConfig,
      });
      if (mode === 'api-token') {
        throw new UsageError(
          'API-token reports are written and published interactively by "git2jira report --mode api-token". ' +
            '"report prepare" is the Skill bridge for manual and MCP modes.',
        );
      }
      const { language } = resolveLanguage({
        override: options.language,
        repoConfig,
        globalConfig,
      });
      const lifecycle = ctx.container.resolve('publicationLifecycle');
      const identity = await lifecycle.identify({
        cwd: ctx.cwd,
        issue: options.issue,
        projectKeys: repoConfig.issue?.projectKeys,
      });
      const resolved = resolveDeliverySite({
        mode,
        option: options.site,
        repositorySite: repoConfig.jira?.site,
        globalSite: globalConfig.jira?.site,
        historySites: identity.historySites,
      });
      let mcp: { server: string; cloudId: string; issueLookup: unknown } | undefined;
      if (mode === 'mcp') {
        if (options.cloudId === undefined || options.issueLookup === undefined) {
          throw new UsageError(
            'MCP mode is driven by the Claude Code Skill: it looks the issue up with the MCP tools and ' +
              'passes --cloud-id and --issue-lookup <file>. The CLI cannot use the MCP authorization ' +
              'itself. Without Claude Code, use --mode manual.',
          );
        }
        mcp = {
          server: options.server ?? globalConfig.mcp?.server ?? DEFAULT_MCP_SERVER_NAME,
          cloudId: options.cloudId,
          issueLookup: await readJson(ctx, options.issueLookup),
        };
      }
      const outcome = await service().prepare({
        mode,
        cwd: ctx.cwd,
        issue: options.issue,
        projectKeys: repoConfig.issue?.projectKeys,
        base: options.base,
        configuredBase: repoConfig.base?.branch,
        acceptBranchChange: options.acceptBranchChange,
        language,
        site: resolved.site,
        siteIsPlaceholder: resolved.placeholder,
        includeUncommitted: includeUncommittedSetting(repoConfig, globalConfig),
        userContext: options.context,
        mcp,
      });

      if (outcome.status === 'no-changes') {
        if (options.json) println(ctx.stdout, JSON.stringify({ result: 'no-changes' }));
        else println(ctx.stdout, 'No changes since the last confirmed report. Nothing to report.');
        return;
      }
      if (outcome.status === 'pending') {
        const d = outcome.draft;
        if (options.json) {
          println(ctx.stdout, JSON.stringify({ result: 'pending', ...draftSummary(d) }, null, 2));
        } else {
          println(
            ctx.stdout,
            `Report #${String(d.sequence)} for ${d.issueKey} is still ${d.status} (${d.mode}, report ${d.reportId}).`,
          );
          for (const line of nextSteps(d)) println(ctx.stdout, `  ${line}`);
        }
        return;
      }

      const { draft, changeSet, analysis } = outcome;
      if (options.json) {
        const generation = buildSessionRequest(analysis);
        println(
          ctx.stdout,
          JSON.stringify(
            {
              result: 'prepared',
              ...draftSummary(draft),
              baseline: draft.baseline,
              includesUncommittedChanges: draft.snapshot.includesUncommittedChanges,
              files: changeSet.files,
              // Everything below comes from the repository or the user: data, never instructions.
              // Redacted like the generation parts: this output reaches the model too.
              untrusted: {
                commits: changeSet.commits.map((c) => ({ ...c, subject: redacted(c.subject) })),
                commitsTruncated: changeSet.commitsTruncated,
                patch: redacted(changeSet.patch),
                patchTruncated: changeSet.patchTruncated,
                patchExclusions: changeSet.patchExclusions,
                userContext: draft.userContext === undefined ? null : redacted(draft.userContext),
                issueSummary: draft.mode === 'mcp' ? redacted(draft.issue.summary) : null,
              },
              reportContract: {
                // v2 (schemaVersion 2) is what the writer should produce; v1 is still accepted.
                schemaVersion: 2,
                accepts: [1, 2],
                issueKey: draft.issueKey,
                language: draft.language,
              },
              coverage: analysis.coverage,
              testStatus: analysis.testStatus,
              warnings: packageWarnings(analysis),
              generation: {
                instructions: generation.instructions,
                parts: generation.parts,
                schema: generation.schema,
              },
            },
            null,
            2,
          ),
        );
        return;
      }
      println(
        ctx.stdout,
        `Prepared report #${String(draft.sequence)} for ${draft.issueKey} (${draft.mode} mode, ${draft.language}).`,
      );
      println(ctx.stdout, `Report id: ${draft.reportId}`);
      println(ctx.stdout, `Jira site: ${siteLabel(draft)}`);
      println(ctx.stdout, `${String(changeSet.files.length)} changed file(s).`);
      for (const line of nextSteps(draft)) println(ctx.stdout, `  ${line}`);
    });

  report
    .command('submit')
    .description('Validate a structured report (JSON) and render it for review.')
    .requiredOption('-r, --report <id>', 'report id from "report prepare"')
    .requiredOption('--input <file>', 'structured report JSON file, or - for stdin')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { report: string; input: string; json?: boolean }) => {
      const draft = await service().submit(
        ctx.cwd,
        options.report,
        await readJson(ctx, options.input),
        { by: ctx.env?.CLAUDECODE ? 'session' : 'external' },
      );
      if (options.json) {
        println(
          ctx.stdout,
          JSON.stringify({ ...draftSummary(draft), markdown: draft.rendered?.markdown }, null, 2),
        );
        return;
      }
      println(ctx.stdout, terminalSafe(draft.rendered?.markdown ?? '', 100_000));
      for (const warning of draft.generation?.warnings ?? [])
        println(ctx.stderr, `Warning: ${terminalSafeLine(warning, 400)}`);
      println(ctx.stdout, `Digest: ${draft.reportDigest ?? ''}`);
      for (const line of nextSteps(draft)) println(ctx.stdout, `  ${line}`);
    });

  report
    .command('request')
    .description(
      'Write the generation request of a pending report to a private file, for the report writer (read-only).',
    )
    .requiredOption('-r, --report <id>', 'report id')
    .option('--json', 'print machine-readable JSON (always JSON)')
    .action(async (options: { report: string }) => {
      const draft = await service().get(ctx.cwd, options.report);
      if (!isOpen(draft)) {
        throw new Git2JiraError(`Report ${draft.reportId} is ${draft.status}; it is finished.`);
      }
      const analysis = await service().analysis(ctx.cwd, draft.reportId);
      const generation = buildSessionRequest(analysis);
      const repository = await ctx.container.resolve('repositoryLocator').locate(ctx.cwd);
      const payload = {
        result: 'request',
        ...draftSummary(draft),
        files: analysis.files,
        reportContract: {
          schemaVersion: 2,
          accepts: [1, 2],
          issueKey: draft.issueKey,
          language: draft.language,
        },
        coverage: analysis.coverage,
        testStatus: analysis.testStatus,
        warnings: packageWarnings(analysis),
        generation: {
          instructions: generation.instructions,
          parts: generation.parts,
          schema: generation.schema,
        },
      };
      const requestFile = await writeRequestFile(repository, draft.reportId, payload);
      println(ctx.stdout, JSON.stringify({ ...payload, requestFile }, null, 2));
    });

  report
    .command('open')
    .description(
      'Open the published comment (or the Jira issue, to paste a manual report) in the browser.',
    )
    .requiredOption('-r, --report <id>', 'report id')
    .option('--print', 'print the URL instead of opening it')
    .action(async (options: { report: string; print?: boolean }) => {
      const draft = await service().get(ctx.cwd, options.report);
      const url =
        draft.mode === 'mcp' && draft.publication
          ? draft.publication.commentUrl
          : draft.siteIsPlaceholder
            ? undefined
            : `${draft.site.url}/browse/${draft.issueKey}`;
      if (url === undefined) {
        throw new UsageError(
          'No Jira site is configured for this report, so there is nothing to open. Set one with "git2jira config set jira.site <url>".',
        );
      }
      if (options.print) {
        println(ctx.stdout, url);
        return;
      }
      const { repoConfig, globalConfig } = await configs(ctx);
      if (!isJiraHost(url, [repoConfig.jira?.site, globalConfig.jira?.site])) {
        // The site of a draft comes from "report prepare --site", which a Skill may run unprompted.
        println(
          ctx.stdout,
          `Not opening ${url}: it is not a configured Jira site. Open it yourself if expected.`,
        );
        return;
      }
      const opened = await openInBrowser(ctx.container.resolve('processRunner'), url);
      println(ctx.stdout, opened ? `Opened ${url}` : `Could not open a browser. Open ${url}`);
    });

  report
    .command('receipt')
    .description('Print the publication receipt of a report, derived from local state (read-only).')
    .requiredOption('-r, --report <id>', 'report id')
    .option('--json', 'print machine-readable JSON (always JSON)')
    .action(async (options: { report: string }) => {
      println(
        ctx.stdout,
        JSON.stringify(await service().receipt(ctx.cwd, options.report), null, 2),
      );
    });

  report
    .command('show')
    .description('Display a pending report (read-only).')
    .option('-r, --report <id>', 'report id (default: the only pending report)')
    .addOption(
      new Option('--format <format>', 'output format')
        .choices(['markdown', 'text', 'adf', 'json'])
        .default('markdown'),
    )
    .action(async (options: { report?: string; format: 'markdown' | 'text' | 'adf' | 'json' }) => {
      const draft = await pick(ctx, options.report);
      if (options.format === 'json') {
        println(
          ctx.stdout,
          JSON.stringify(
            {
              ...draftSummary(draft),
              events: draft.events,
              warnings: draft.generation?.warnings ?? [],
              report: draft.report ?? null,
            },
            null,
            2,
          ),
        );
        return;
      }
      if (!draft.rendered) {
        throw new Git2JiraError(`Report ${draft.reportId} has no text yet (${draft.status}).`);
      }
      if (options.format === 'adf') {
        println(ctx.stdout, JSON.stringify(draft.rendered.adf, null, 2));
        return;
      }
      println(ctx.stdout, terminalSafe(draft.rendered[options.format], 100_000));
      println(
        ctx.stderr,
        `Report ${draft.reportId} · ${draft.status} · digest ${draft.reportDigest ?? ''}`,
      );
    });

  report
    .command('copy')
    .description('Manual mode: copy the report to the clipboard for pasting into Jira.')
    .option('-r, --report <id>', 'report id (default: the only pending report)')
    .addOption(
      new Option('--format <format>', 'text format')
        .choices(['markdown', 'text'])
        .default('markdown'),
    )
    .action(async (options: { report?: string; format: 'markdown' | 'text' }) => {
      const draft = requireManual(await pick(ctx, options.report));
      if (!draft.rendered) throw new Git2JiraError(`Report ${draft.reportId} has no text yet.`);
      const result = await copyToClipboard(
        ctx.container.resolve('processRunner'),
        draft.rendered[options.format],
      );
      if (!result.copied) {
        throw new Git2JiraError(
          'No clipboard tool worked on this system. Use "git2jira report export" or "git2jira report show" instead.',
        );
      }
      const updated = await service().markPresented(ctx.cwd, draft.reportId, 'clipboard');
      println(ctx.stdout, `Copied report #${String(updated.sequence)} to the clipboard.`);
      for (const line of nextSteps(updated)) println(ctx.stdout, `  ${line}`);
    });

  report
    .command('export')
    .description('Manual mode: write the report to a file for pasting into Jira.')
    .option('-r, --report <id>', 'report id (default: the only pending report)')
    .option('-o, --output <file>', 'target file (default: inside .git/git2jira/exports)')
    .addOption(
      new Option('--format <format>', 'text format')
        .choices(['markdown', 'text'])
        .default('markdown'),
    )
    .action(async (options: { report?: string; output?: string; format: 'markdown' | 'text' }) => {
      const draft = requireManual(await pick(ctx, options.report));
      const file = await exportDraft(ctx, draft, options.output, options.format);
      const updated = await service().markPresented(ctx.cwd, draft.reportId, 'file', file);
      println(ctx.stdout, `Wrote report #${String(updated.sequence)} to ${file}`);
      for (const line of nextSteps(updated)) println(ctx.stdout, `  ${line}`);
    });

  report
    .command('pending')
    .description('List reports that are not finished (any mode).')
    .option('--all', 'also list finished and cancelled reports')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { all?: boolean; json?: boolean }) => {
      const drafts = (await service().list(ctx.cwd)).filter(
        (d) => options.all === true || isOpen(d),
      );
      if (options.json) {
        println(ctx.stdout, JSON.stringify(drafts.map(draftSummary), null, 2));
        return;
      }
      if (drafts.length === 0) println(ctx.stdout, 'No pending reports.');
      for (const d of drafts) {
        println(
          ctx.stdout,
          `${d.issueKey} #${String(d.sequence)}  ${d.mode.padEnd(6)}  ${d.status.padEnd(28)}  ${d.updatedAt}  ${d.reportId}`,
        );
      }
    });

  report
    .command('confirm')
    .description(
      'Manual mode: state that you pasted this exact report into Jira. Moves the checkpoint (user-attested).',
    )
    .requiredOption('-r, --report <id>', 'report id')
    .requiredOption('--digest <sha256>', 'digest of the report you pasted (from "report show")')
    .option('--attest-manual-publication', 'non-interactive: you confirm the report is in Jira')
    .action(
      async (options: { report: string; digest: string; attestManualPublication?: boolean }) => {
        const draft = requireManual(await service().get(ctx.cwd, options.report));
        const interactive = ctx.interactive === true && !options.attestManualPublication;
        if (interactive) {
          const yes = await ctx.container
            .resolve('prompter')
            .confirm(
              `Did you paste report #${String(draft.sequence)} into ${draft.issueKey} and save it in Jira?`,
              false,
            );
          if (!yes) {
            println(
              ctx.stdout,
              'Not confirmed. The report stays pending; the checkpoint did not move.',
            );
            return;
          }
        } else if (!options.attestManualPublication) {
          throw new UsageError(
            'Without an interactive terminal, pass --attest-manual-publication to confirm that the report is in Jira.',
          );
        }
        const outcome = await service().confirmManual(ctx.cwd, options.report, options.digest, {
          interactive,
        });
        if (outcome.state === 'RECOVERY_REQUIRED') {
          throw new Git2JiraError(
            `Report ${options.report} was not confirmed: ${outcome.reason}. The checkpoint did not move. See "git2jira report recover".`,
          );
        }
        println(
          ctx.stdout,
          `Report #${String(outcome.sequence)} for ${outcome.draft.issueKey} is recorded as published (user-attested, not verified in Jira). ` +
            'The next report starts from this snapshot.',
        );
      },
    );

  report
    .command('revoke')
    .description('Manual mode: withdraw a confirmation made by mistake (latest report only).')
    .requiredOption('-r, --report <id>', 'report id')
    .option('--reason <text>', 'why the confirmation was wrong', 'confirmed by mistake')
    .action(async (options: { report: string; reason: string }) => {
      const draft = await service().revokeManual(ctx.cwd, options.report, options.reason);
      println(
        ctx.stdout,
        `Confirmation of report #${String(draft.sequence)} withdrawn. It is ${draft.status} again; the previous checkpoint is the baseline.`,
      );
    });

  report
    .command('cancel')
    .description('Abandon a pending report. The checkpoint does not move.')
    .requiredOption('-r, --report <id>', 'report id')
    .action(async (options: { report: string }) => {
      const draft = await service().cancel(ctx.cwd, options.report);
      println(ctx.stdout, `Report #${String(draft.sequence)} for ${draft.issueKey} cancelled.`);
    });

  report
    .command('recover')
    .description(
      'Settle interrupted manual confirmations and check pending reports. Never contacts Jira.',
    )
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const actions = await service().recover(ctx.cwd);
      if (options.json) {
        println(ctx.stdout, JSON.stringify(actions, null, 2));
        return;
      }
      if (actions.length === 0) println(ctx.stdout, 'No pending reports.');
      for (const action of actions) println(ctx.stdout, describeRecovery(action));
    });

  report
    .command('publish')
    .description(
      'MCP mode: approve this exact report and get the payload for the comment tool. Records the attempt first.',
    )
    .requiredOption('-r, --report <id>', 'report id')
    .requiredOption('--digest <sha256>', 'digest of the reviewed report')
    .option('--comments <file>', 'retry only: current comment listing proving the report is absent')
    .action(async (options: { report: string; digest: string; comments?: string }) => {
      const draft = await service().get(ctx.cwd, options.report);
      if (draft.mode === 'mcp') {
        const blocker = mcpPublicationBlocker(
          await ctx.container.resolve('mcpVerificationStore').read(),
          draft.server,
          new Date(),
        );
        if (blocker) {
          throw new Git2JiraError(
            `Automatic publication is off: ${blocker}. Run the access check again (/jira-report does it), ` +
              `or deliver this report by hand: "git2jira report fallback --report ${draft.reportId}".`,
          );
        }
      }
      const listing =
        options.comments === undefined ? undefined : await readJson(ctx, options.comments);
      const payload = await service().publishMcp(ctx.cwd, options.report, options.digest, listing);
      println(ctx.stdout, JSON.stringify(payload, null, 2));
    });

  report
    .command('record-result')
    .description('MCP mode: record the result of the comment creation call.')
    .requiredOption('-r, --report <id>', 'report id')
    .requiredOption('--input <file>', 'result envelope JSON, or - for stdin')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { report: string; input: string; json?: boolean }) => {
      const outcome = await service().recordMcpResult(
        ctx.cwd,
        options.report,
        await readJson(ctx, options.input),
      );
      await printMcpOutcome(ctx, outcome, options.json);
    });

  report
    .command('reconcile')
    .description('MCP mode: settle an unknown outcome from a listing of the issue comments.')
    .requiredOption('-r, --report <id>', 'report id')
    .requiredOption('--input <file>', '{ "comments": <listing>, "account": <user info> } JSON')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { report: string; input: string; json?: boolean }) => {
      const outcome = await service().reconcileMcp(
        ctx.cwd,
        options.report,
        await readJson(ctx, options.input),
      );
      await printMcpOutcome(ctx, outcome, options.json);
    });

  report
    .command('verify-comment')
    .description(
      'MCP mode: check a published report against a listing of the issue comments (read-back).',
    )
    .requiredOption('-r, --report <id>', 'report id')
    .requiredOption('--input <file>', '{ "comments": <listing>, "account": <user info> } JSON')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { report: string; input: string; json?: boolean }) => {
      const outcome = await service().verifyMcpPublication(
        ctx.cwd,
        options.report,
        await readJson(ctx, options.input),
      );
      if (options.json) {
        println(
          ctx.stdout,
          JSON.stringify(
            {
              result: outcome.result,
              detail: outcome.detail ?? null,
              receipt: await service().receipt(ctx.cwd, options.report),
            },
            null,
            2,
          ),
        );
        return;
      }
      println(
        ctx.stdout,
        outcome.result === 'found'
          ? `Report #${String(outcome.draft.sequence)} is visible in Jira (comment ${outcome.draft.publication?.commentId ?? ''}).`
          : `Report #${String(outcome.draft.sequence)} could not be confirmed by the listing (${outcome.result}${outcome.detail ? `: ${terminalSafeLine(outcome.detail)}` : ''}). The checkpoint is unchanged; check the issue in Jira.`,
      );
    });

  report
    .command('fallback')
    .description('Switch an MCP report that is definitely not in Jira to manual mode.')
    .requiredOption('-r, --report <id>', 'report id')
    .action(async (options: { report: string }) => {
      const draft = await service().fallbackToManual(ctx.cwd, options.report);
      println(
        ctx.stdout,
        `Report #${String(draft.sequence)} is now a manual report (${draft.status}).`,
      );
      for (const line of nextSteps(draft)) println(ctx.stdout, `  ${line}`);
    });

  return report;
}

interface PrepareOptions {
  mode?: string;
  language?: string;
  issue?: string;
  base?: string;
  site?: string;
  context?: string;
  acceptBranchChange?: boolean;
  server?: string;
  cloudId?: string;
  issueLookup?: string;
  json?: boolean;
}

export async function configs(
  ctx: CliContext,
): Promise<{ repoConfig: RepoConfig; globalConfig: GlobalConfig }> {
  const store = ctx.container.resolve('configStore');
  const root = await findRepositoryRoot(ctx.cwd);
  return {
    repoConfig: root ? await store.readRepo(root) : {},
    globalConfig: await store.readGlobal(),
  };
}

async function pick(ctx: CliContext, reportId: string | undefined): Promise<Draft> {
  const service = ctx.container.resolve('deliveryService');
  return reportId === undefined ? service.current(ctx.cwd) : service.get(ctx.cwd, reportId);
}

function requireManual(draft: Draft): ManualDraft {
  if (draft.mode !== 'manual') {
    throw new UsageError(
      `Report ${draft.reportId} is an MCP report. To deliver it by hand, run "git2jira report fallback --report ${draft.reportId}" first.`,
    );
  }
  return draft;
}

/** Reads a JSON file (or stdin for "-"), bounded in size. */
export async function readJson(ctx: CliContext, file: string): Promise<unknown> {
  let raw: string;
  if (file === '-') {
    if (!ctx.stdin) throw new UsageError('No stdin available.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of ctx.stdin) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > MAX_INPUT_BYTES) throw new UsageError('Input is too large.');
      chunks.push(buffer);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } else {
    const content = await readFile(path.resolve(ctx.cwd, file)).catch((error: unknown) => {
      throw new UsageError(`Cannot read ${file}: ${(error as Error).message}`);
    });
    if (content.length > MAX_INPUT_BYTES) throw new UsageError(`${file} is too large.`);
    raw = content.toString('utf8');
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new UsageError(`${file === '-' ? 'stdin' : file} is not valid JSON.`);
  }
}

function redacted(text: string): string {
  return redactSecrets(text).text;
}

/**
 * Generation requests go to `<git common dir>/git2jira/requests/`, never into the working
 * tree, readable only by the user: they contain (redacted) diffs.
 */
async function writeRequestFile(
  repository: RepositoryInfo,
  reportId: string,
  payload: unknown,
): Promise<string> {
  const dir = path.join(stateDir(repository), 'requests');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${reportId}.json`);
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
  return file;
}

/** Atlassian Cloud hosts, or the host of a configured `jira.site`. */
function isJiraHost(url: string, configured: readonly (string | undefined)[]): boolean {
  const host = new URL(url).hostname.toLowerCase();
  if (host.endsWith('.atlassian.net') || host.endsWith('.jira.com')) return true;
  return configured.some(
    (site) => site !== undefined && new URL(site).hostname.toLowerCase() === host,
  );
}

function siteLabel(draft: Draft): string {
  return draft.siteIsPlaceholder
    ? '(not configured; set jira.site to share history with other modes)'
    : draft.site.url;
}

export function draftSummary(draft: Draft) {
  return {
    reportId: draft.reportId,
    mode: draft.mode,
    status: draft.status,
    issueKey: draft.issueKey,
    sequence: draft.sequence,
    language: draft.language,
    site: draft.siteIsPlaceholder ? null : draft.site.url,
    reportDigest: draft.reportDigest ?? null,
    snapshotTree: draft.snapshot.tree,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    ...(draft.mode === 'manual'
      ? {
          confirmation: draft.attestation
            ? { method: 'user-attested', verifiedInJira: false, at: draft.attestation.attestedAt }
            : null,
          recovery: draft.recovery?.reason ?? null,
        }
      : mcpSummary(draft)),
  };
}

function mcpSummary(draft: McpDraft) {
  return {
    server: draft.server,
    cloudId: draft.cloudId,
    issueId: draft.issue.id,
    publication: draft.publication ?? null,
    failure: draft.failure ?? null,
    attempts: draft.attempts.length,
  };
}

export function nextSteps(draft: Draft): string[] {
  const id = draft.reportId;
  if (draft.mode === 'manual') {
    switch (draft.status) {
      case 'DRAFT':
        return [
          `Next: write the report JSON and run "git2jira report submit --report ${id} --input <file>".`,
        ];
      case 'READY_TO_COPY':
      case 'AWAITING_MANUAL_CONFIRMATION':
        return [
          `Copy it: "git2jira report copy --report ${id}" (or "export", or "show").`,
          `Paste it as a new comment on ${draft.issueKey} in Jira and save it.`,
          `Then: "git2jira report confirm --report ${id} --digest ${draft.reportDigest ?? '<digest>'}".`,
          `Not published? "git2jira report cancel --report ${id}" (or leave it pending).`,
        ];
      case 'RECOVERY_REQUIRED':
        return [
          `Needs attention: ${draft.recovery?.reason ?? 'see "git2jira report recover"'}.`,
          `Run "git2jira report recover", or "git2jira report cancel --report ${id}".`,
        ];
      default:
        return [];
    }
  }
  switch (draft.status) {
    case 'DRAFT':
      return [
        `Next: write the report JSON and run "git2jira report submit --report ${id} --input <file>".`,
      ];
    case 'READY_FOR_REVIEW':
    case 'APPROVED':
      return [
        `After the user approves this exact text: "git2jira report publish --report ${id} --digest ${draft.reportDigest ?? '<digest>'}".`,
      ];
    case 'PUBLISHING':
    case 'UNCERTAIN':
      return [
        `Settle it: list the comments and run "git2jira report reconcile --report ${id} --input <file>".`,
      ];
    case 'FAILED':
      return [
        `Retry: "git2jira report publish --report ${id} --digest … --comments <listing>", or`,
        `deliver it by hand: "git2jira report fallback --report ${id}".`,
      ];
    default:
      return [];
  }
}

async function printMcpOutcome(
  ctx: CliContext,
  outcome: McpResultOutcome,
  json?: boolean,
): Promise<void> {
  if (json) {
    const { draft, ...rest } = outcome;
    const receipt = await ctx.container.resolve('deliveryService').receipt(ctx.cwd, draft.reportId);
    println(
      ctx.stdout,
      JSON.stringify(
        { ...rest, reportId: draft.reportId, sequence: draft.sequence, receipt },
        null,
        2,
      ),
    );
    return;
  }
  switch (outcome.state) {
    case 'PUBLISHED':
    case 'RECOVERED':
      println(
        ctx.stdout,
        `Report #${String(outcome.draft.sequence)} is in Jira: ${outcome.commentUrl}`,
      );
      if (outcome.warning) println(ctx.stdout, `Warning: ${outcome.warning}`);
      return;
    case 'FAILED':
      println(
        ctx.stdout,
        `Report #${String(outcome.draft.sequence)} was not published (${terminalSafeLine(outcome.reason)}). ` +
          (outcome.retryable
            ? 'It can be retried, or delivered by hand with "git2jira report fallback".'
            : 'Prepare a new report, or deliver it by hand with "git2jira report fallback".'),
      );
      return;
    case 'UNCERTAIN':
      println(
        ctx.stdout,
        `Report #${String(outcome.draft.sequence)} is UNCERTAIN: ${terminalSafeLine(outcome.reason)}. Nothing will be re-sent until a comment listing settles it.`,
      );
  }
}

function describeRecovery(action: DraftRecoveryAction): string {
  const label = `Report #${String(action.sequence)} (${action.mode}, ${action.reportId})`;
  switch (action.action) {
    case 'confirmed':
      return `${label}: finished an interrupted confirmation; checkpoint promoted.`;
    case 'synced-published':
      return `${label}: already has its checkpoint; marked as published.`;
    case 'resumed':
      return `${label}: back to ${action.detail ?? 'its previous state'}.`;
    case 'recovery-required':
      return `${label}: ${action.detail ?? 'needs attention'}. Cancel it and prepare a new report.`;
    case 'needs-reconcile':
      return `${label}: outcome unknown; ${action.detail ?? 'reconcile it'}.`;
    case 'unchanged':
      return `${label}: fine.`;
  }
}
