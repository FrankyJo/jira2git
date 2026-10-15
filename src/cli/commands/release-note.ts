import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command, Option } from 'commander';
import { Git2JiraError, UsageError } from '../../core/errors';
import { terminalSafe, terminalSafeLine } from '../../core/sanitize';
import { copyToClipboard } from '../../delivery/clipboard';
import { resolveDeliveryMode } from '../../delivery/mode';
import { resolveDeliverySite } from '../../delivery/site';
import { SUPPORTED_LANGUAGES, type Language } from '../../localization/languages';
import { DEFAULT_MCP_SERVER_NAME } from '../../mcp/tools';
import { mcpPublicationBlocker } from '../../mcp/verification';
import { isOpenReleaseNote, type ReleaseNoteDraft } from '../../release-note/draft';
import { buildReleaseNoteRequest } from '../../release-note/prompt';
import type { ReleaseNoteMcpOutcome } from '../../release-note/types';
import { factsToVerify } from '../../release-note/validate';
import { println, type CliContext } from '../context';
import { configs, readJson, writeRequestFile } from './report';

/** Release notes are written in Ukrainian unless asked otherwise. */
export const DEFAULT_RELEASE_NOTE_LANGUAGE: Language = 'uk';

/**
 * `git2jira release-note …`: the bridge for `/jira-release-note`.
 *
 * A release note describes the whole issue (merge-base of the branch → HEAD, committed
 * work only) for end users, and is delivered as a new Jira comment. It never moves a
 * checkpoint. `confirm`, `publish`, `record-result`, `reconcile`, and `cancel` must never
 * be pre-approved in a Skill: Claude Code's permission prompt is the user's approval.
 */
export function createReleaseNoteCommand(ctx: CliContext): Command {
  const command = new Command('release-note').description(
    'Write a user-facing release note for a whole issue and deliver it as a Jira comment.',
  );
  const service = () => ctx.container.resolve('releaseNoteService');

  command
    .command('prepare')
    .description(
      'Collect the committed changes from the merge-base of the branch to HEAD (read-only for Git).',
    )
    .addOption(new Option('-m, --mode <mode>', 'delivery mode').choices(['manual', 'mcp'] as const))
    .addOption(
      new Option('-l, --language <code>', 'release note language (default: uk)').choices(
        SUPPORTED_LANGUAGES,
      ),
    )
    .option('-i, --issue <key>', 'Jira issue key (default: detected from the branch name)')
    .option('-b, --base <branch>', 'base branch the issue branch started from')
    .option('--site <url>', 'Jira site URL (manual: optional; MCP: required unless configured)')
    .option('--server <name>', 'MCP: Claude Code MCP server name')
    .option('--cloud-id <id>', 'MCP: Atlassian cloud id of the site')
    .option('--issue-lookup <file>', 'MCP: raw result of the issue lookup tool for this key')
    .option('--json', 'print the generation request as JSON')
    .action(async (options: PrepareOptions) => {
      const { repoConfig, globalConfig } = await configs(ctx);
      const configured = resolveDeliveryMode({ repoConfig, globalConfig }).mode;
      const mode = options.mode ?? (configured === 'mcp' ? 'mcp' : 'manual');
      const lifecycle = ctx.container.resolve('publicationLifecycle');
      const identity = await lifecycle.identify({
        cwd: ctx.cwd,
        issue: options.issue,
        projectKeys: repoConfig.issue?.projectKeys,
      });
      const site = resolveDeliverySite({
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
            'MCP mode is driven by /jira-release-note: it looks the issue up with the MCP tools and passes ' +
              '--cloud-id and --issue-lookup <file>. Without Claude Code, use --mode manual.',
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
        language: (options.language as Language | undefined) ?? DEFAULT_RELEASE_NOTE_LANGUAGE,
        site: site.site,
        siteIsPlaceholder: site.placeholder,
        mcp,
      });

      if (outcome.status === 'no-changes') {
        if (options.json) println(ctx.stdout, JSON.stringify({ result: 'no-changes' }));
        else println(ctx.stdout, 'The branch has no committed changes since its base branch.');
        return;
      }
      if (outcome.status === 'pending') {
        const d = outcome.draft;
        if (options.json) {
          println(ctx.stdout, JSON.stringify({ result: 'pending', ...noteSummary(d) }, null, 2));
        } else {
          println(
            ctx.stdout,
            `A release note for ${d.issueKey} is still ${d.status} (${d.mode}, ${d.noteId}).`,
          );
          for (const line of nextSteps(d)) println(ctx.stdout, `  ${line}`);
        }
        return;
      }
      const { draft, changeSet, analysis, context, delivered } = outcome;
      if (options.json) {
        const generation = buildReleaseNoteRequest(analysis, context);
        println(
          ctx.stdout,
          JSON.stringify(
            {
              result: 'prepared',
              ...noteSummary(draft),
              base: draft.base,
              head: draft.head,
              files: changeSet.files,
              commits: changeSet.commits.length,
              earlierReports: context.earlierReports.length,
              issue: issueFacts(draft),
              delivered: delivered.map(noteSummary),
              contract: { schemaVersion: 1, issueKey: draft.issueKey, language: draft.language },
              coverage: analysis.coverage,
              warnings: [],
              generation,
            },
            null,
            2,
          ),
        );
        return;
      }
      println(
        ctx.stdout,
        `Prepared a release note for ${draft.issueKey} (${draft.mode} mode, ${draft.language}): ` +
          `${String(changeSet.files.length)} changed file(s) since ${draft.base.name}.`,
      );
      println(ctx.stdout, `Release note id: ${draft.noteId}`);
      if (delivered.length > 0) {
        println(
          ctx.stdout,
          `Note: ${String(delivered.length)} release note(s) of ${draft.issueKey} are already in Jira; this one becomes a new comment.`,
        );
      }
      for (const line of nextSteps(draft)) println(ctx.stdout, `  ${line}`);
    });

  command
    .command('request')
    .description(
      'Write the generation request of an open release note to a private file, for the writer (read-only).',
    )
    .requiredOption('-n, --note <id>', 'release note id')
    .option('--json', 'print machine-readable JSON (always JSON)')
    .action(async (options: { note: string }) => {
      const { draft, analysis, context } = await service().analysis(ctx.cwd, options.note);
      if (!isOpenReleaseNote(draft)) {
        throw new Git2JiraError(`Release note ${draft.noteId} is ${draft.status}; it is finished.`);
      }
      const repository = await ctx.container.resolve('repositoryLocator').locate(ctx.cwd);
      const payload = {
        result: 'request',
        ...noteSummary(draft),
        files: analysis.files,
        contract: { schemaVersion: 1, issueKey: draft.issueKey, language: draft.language },
        coverage: analysis.coverage,
        issue: issueFacts(draft),
        generation: buildReleaseNoteRequest(analysis, context),
      };
      const requestFile = await writeRequestFile(
        repository,
        `release-note-${draft.noteId}`,
        payload,
      );
      println(ctx.stdout, JSON.stringify({ ...payload, requestFile }, null, 2));
    });

  command
    .command('parent')
    .description(
      'MCP mode: add the parent issue (usually the epic) as context, when the issue does not state its goal.',
    )
    .requiredOption('-n, --note <id>', 'release note id')
    .requiredOption(
      '--issue-lookup <file>',
      'raw result of the issue lookup tool for the parent, or -',
    )
    .option('--json', 'print the updated generation request as JSON')
    .action(async (options: { note: string; issueLookup: string; json?: boolean }) => {
      await service().addParent(ctx.cwd, options.note, await readJson(ctx, options.issueLookup));
      const { draft, analysis, context } = await service().analysis(ctx.cwd, options.note);
      if (options.json) {
        println(
          ctx.stdout,
          JSON.stringify(
            {
              result: 'parent-added',
              ...noteSummary(draft),
              issue: issueFacts(draft),
              generation: buildReleaseNoteRequest(analysis, context),
            },
            null,
            2,
          ),
        );
        return;
      }
      const parent = draft.issueContext?.parent;
      println(
        ctx.stdout,
        `Added ${parent?.key ?? 'the parent issue'} as context for the release note of ${draft.issueKey}.`,
      );
    });

  command
    .command('submit')
    .description('Validate a release note (JSON) and render it for review. Writes nothing to Jira.')
    .requiredOption('-n, --note <id>', 'release note id')
    .requiredOption('--input <file>', 'release note JSON file, or - for stdin')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { note: string; input: string; json?: boolean }) => {
      const draft = await service().submit(
        ctx.cwd,
        options.note,
        await readJson(ctx, options.input),
      );
      const verify = draft.note ? factsToVerify(draft.note) : [];
      if (options.json) {
        println(
          ctx.stdout,
          JSON.stringify(
            {
              ...noteSummary(draft),
              markdown: draft.rendered?.markdown,
              toVerify: verify,
              openQuestions: draft.note?.openQuestions ?? [],
              warnings: draft.warnings,
            },
            null,
            2,
          ),
        );
        return;
      }
      println(ctx.stdout, terminalSafe(draft.rendered?.markdown ?? '', 100_000));
      for (const line of verify) println(ctx.stdout, `To verify: ${terminalSafeLine(line, 400)}`);
      for (const warning of draft.warnings)
        println(ctx.stderr, `Warning: ${terminalSafeLine(warning, 400)}`);
      println(ctx.stdout, `Digest: ${draft.noteDigest ?? ''}`);
      for (const line of nextSteps(draft)) println(ctx.stdout, `  ${line}`);
    });

  command
    .command('show')
    .description('Display a release note (read-only).')
    .option('-n, --note <id>', 'release note id (default: the only open one)')
    .addOption(
      new Option('--format <format>', 'output format')
        .choices(['markdown', 'text', 'adf', 'json'])
        .default('markdown'),
    )
    .action(async (options: { note?: string; format: 'markdown' | 'text' | 'adf' | 'json' }) => {
      const draft = await pick(ctx, options.note);
      if (options.format === 'json') {
        println(
          ctx.stdout,
          JSON.stringify(
            {
              ...noteSummary(draft),
              events: draft.events,
              warnings: draft.warnings,
              note: draft.note ?? null,
              toVerify: draft.note ? factsToVerify(draft.note) : [],
            },
            null,
            2,
          ),
        );
        return;
      }
      if (!draft.rendered) {
        throw new Git2JiraError(`Release note ${draft.noteId} has no text yet (${draft.status}).`);
      }
      if (options.format === 'adf') {
        println(ctx.stdout, JSON.stringify(draft.rendered.adf, null, 2));
        return;
      }
      println(ctx.stdout, terminalSafe(draft.rendered[options.format], 100_000));
      println(
        ctx.stderr,
        `Release note ${draft.noteId} · ${draft.status} · digest ${draft.noteDigest ?? ''}`,
      );
    });

  command
    .command('copy')
    .description('Copy the release note to the clipboard for pasting into Jira.')
    .option('-n, --note <id>', 'release note id (default: the only open one)')
    .addOption(
      new Option('--format <format>', 'text format')
        .choices(['markdown', 'text'])
        .default('markdown'),
    )
    .action(async (options: { note?: string; format: 'markdown' | 'text' }) => {
      const draft = await pick(ctx, options.note);
      if (!draft.rendered) throw new Git2JiraError(`Release note ${draft.noteId} has no text yet.`);
      const result = await copyToClipboard(
        ctx.container.resolve('processRunner'),
        draft.rendered[options.format],
      );
      if (!result.copied) {
        throw new Git2JiraError(
          'No clipboard tool worked on this system. Use "git2jira release-note export" or "show" instead.',
        );
      }
      println(ctx.stdout, `Copied the release note for ${draft.issueKey} to the clipboard.`);
      for (const line of nextSteps(draft)) println(ctx.stdout, `  ${line}`);
    });

  command
    .command('export')
    .description('Write the release note to a file in .git/git2jira/exports for pasting into Jira.')
    .option('-n, --note <id>', 'release note id (default: the only open one)')
    .addOption(
      new Option('--format <format>', 'text format')
        .choices(['markdown', 'text'])
        .default('markdown'),
    )
    .action(async (options: { note?: string; format: 'markdown' | 'text' }) => {
      const draft = await pick(ctx, options.note);
      if (!draft.rendered) throw new Git2JiraError(`Release note ${draft.noteId} has no text yet.`);
      const repository = await ctx.container.resolve('repositoryLocator').locate(ctx.cwd);
      // Pre-approved in the Skill: the target is always chosen by Git2Jira, never by the caller.
      const file = path.join(
        ctx.container.resolve('releaseNoteStore').exportDir(repository),
        `${draft.issueKey}-release-note-${draft.noteId.slice(0, 8)}-${draft.language}.${options.format === 'markdown' ? 'md' : 'txt'}`,
      );
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, draft.rendered[options.format], { encoding: 'utf8', mode: 0o600 });
      println(ctx.stdout, `Wrote the release note for ${draft.issueKey} to ${file}`);
    });

  command
    .command('pending')
    .description('List release notes that are not finished.')
    .option('--all', 'also list delivered and cancelled release notes')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { all?: boolean; json?: boolean }) => {
      const drafts = (await service().list(ctx.cwd)).filter(
        (d) => options.all === true || isOpenReleaseNote(d),
      );
      if (options.json) {
        println(ctx.stdout, JSON.stringify(drafts.map(noteSummary), null, 2));
        return;
      }
      if (drafts.length === 0) println(ctx.stdout, 'No open release notes.');
      for (const d of drafts) {
        println(
          ctx.stdout,
          `${d.issueKey}  ${d.mode.padEnd(6)}  ${d.status.padEnd(10)}  ${d.updatedAt}  ${d.noteId}`,
        );
      }
    });

  command
    .command('confirm')
    .description('Manual mode: state that you pasted this exact release note into Jira.')
    .requiredOption('-n, --note <id>', 'release note id')
    .requiredOption('--digest <sha256>', 'digest of the release note you pasted')
    .action(async (options: { note: string; digest: string }) => {
      const draft = await service().confirmManual(ctx.cwd, options.note, options.digest);
      println(
        ctx.stdout,
        `The release note for ${draft.issueKey} is recorded as published (user-attested, not verified in Jira).`,
      );
    });

  command
    .command('cancel')
    .description('Abandon a release note that is not in Jira.')
    .requiredOption('-n, --note <id>', 'release note id')
    .action(async (options: { note: string }) => {
      const draft = await service().cancel(ctx.cwd, options.note);
      println(ctx.stdout, `Release note ${draft.noteId} for ${draft.issueKey} cancelled.`);
    });

  command
    .command('publish')
    .description(
      'MCP mode: approve this exact release note and get the payload for the comment tool.',
    )
    .requiredOption('-n, --note <id>', 'release note id')
    .requiredOption('--digest <sha256>', 'digest of the reviewed release note')
    .option('--comments <file>', 'retry only: current comment listing proving it is absent')
    .action(async (options: { note: string; digest: string; comments?: string }) => {
      const draft = await service().get(ctx.cwd, options.note);
      if (draft.mcp) {
        const blocker = mcpPublicationBlocker(
          await ctx.container.resolve('mcpVerificationStore').read(),
          draft.mcp.server,
          new Date(),
        );
        if (blocker) {
          throw new Git2JiraError(
            `Automatic publication is off: ${blocker}. Run the access check again (/jira-release-note does it), ` +
              'or cancel this release note and prepare it in manual mode.',
          );
        }
      }
      const listing =
        options.comments === undefined ? undefined : await readJson(ctx, options.comments);
      const payload = await service().publishMcp(ctx.cwd, options.note, options.digest, listing);
      println(ctx.stdout, JSON.stringify(payload, null, 2));
    });

  command
    .command('record-result')
    .description('MCP mode: record the result of the comment creation call.')
    .requiredOption('-n, --note <id>', 'release note id')
    .requiredOption('--input <file>', 'result envelope JSON, or - for stdin')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { note: string; input: string; json?: boolean }) => {
      const outcome = await service().recordMcpResult(
        ctx.cwd,
        options.note,
        await readJson(ctx, options.input),
      );
      printOutcome(ctx, outcome, options.json);
    });

  command
    .command('reconcile')
    .description('MCP mode: settle an unknown outcome from a listing of the issue comments.')
    .requiredOption('-n, --note <id>', 'release note id')
    .requiredOption('--input <file>', '{ "comments": <listing>, "account": <user info> } JSON')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { note: string; input: string; json?: boolean }) => {
      const outcome = await service().reconcileMcp(
        ctx.cwd,
        options.note,
        await readJson(ctx, options.input),
      );
      printOutcome(ctx, outcome, options.json);
    });

  return command;
}

interface PrepareOptions {
  mode?: 'manual' | 'mcp';
  language?: string;
  issue?: string;
  base?: string;
  site?: string;
  server?: string;
  cloudId?: string;
  issueLookup?: string;
  json?: boolean;
}

/** What the Skill needs to decide whether the goal is known (MCP mode: from Jira). */
function issueFacts(draft: ReleaseNoteDraft) {
  const parent = draft.mcp?.issue.parent;
  const read = draft.issueContext?.parent;
  return {
    key: draft.issueKey,
    summary: draft.issueContext?.title ?? null,
    hasDescription: (draft.issueContext?.description ?? '').trim() !== '',
    parent: parent
      ? {
          key: parent.key,
          type: parent.type ?? null,
          summary: parent.summary ?? null,
          read: read !== undefined,
          hasDescription: (read?.description ?? '').trim() !== '',
        }
      : null,
  };
}

async function pick(ctx: CliContext, noteId: string | undefined): Promise<ReleaseNoteDraft> {
  const service = ctx.container.resolve('releaseNoteService');
  return noteId === undefined ? service.current(ctx.cwd) : service.get(ctx.cwd, noteId);
}

export function noteSummary(draft: ReleaseNoteDraft) {
  return {
    noteId: draft.noteId,
    mode: draft.mode,
    status: draft.status,
    issueKey: draft.issueKey,
    language: draft.language,
    site: draft.siteIsPlaceholder ? null : draft.site.url,
    base: draft.base.name,
    headCommit: draft.head.commit,
    noteDigest: draft.noteDigest ?? null,
    confirmation: draft.attestation
      ? { method: 'user-attested', verifiedInJira: false, at: draft.attestation.attestedAt }
      : null,
    publication: draft.publication ?? null,
    failure: draft.failure ?? null,
    attempts: draft.attempts.length,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

function nextSteps(draft: ReleaseNoteDraft): string[] {
  const id = draft.noteId;
  switch (draft.status) {
    case 'DRAFT':
      return [
        `Next: write the release note JSON and run "git2jira release-note submit --note ${id} --input <file>".`,
      ];
    case 'READY':
      return draft.mode === 'manual'
        ? [
            `Copy it: "git2jira release-note copy --note ${id}" (or "export", or "show").`,
            `Paste it as a new comment on ${draft.issueKey} in Jira, then: ` +
              `"git2jira release-note confirm --note ${id} --digest ${draft.noteDigest ?? '<digest>'}".`,
          ]
        : [
            `After the user approves this exact text: "git2jira release-note publish --note ${id} --digest ${draft.noteDigest ?? '<digest>'}".`,
          ];
    case 'PUBLISHING':
    case 'UNCERTAIN':
      return [
        `Settle it: list the comments and run "git2jira release-note reconcile --note ${id} --input <file>".`,
      ];
    case 'FAILED':
      return [
        `Retry: "git2jira release-note publish --note ${id} --digest … --comments <listing>", or cancel it.`,
      ];
    default:
      return [];
  }
}

function printOutcome(ctx: CliContext, outcome: ReleaseNoteMcpOutcome, json?: boolean): void {
  if (json) {
    const { draft, ...rest } = outcome;
    println(ctx.stdout, JSON.stringify({ ...rest, ...noteSummary(draft) }, null, 2));
    return;
  }
  switch (outcome.state) {
    case 'PUBLISHED':
    case 'RECOVERED':
      println(ctx.stdout, `The release note is in Jira: ${outcome.commentUrl}`);
      return;
    case 'FAILED':
      println(
        ctx.stdout,
        `The release note was not published (${terminalSafeLine(outcome.reason)}). ` +
          (outcome.retryable ? 'It can be retried.' : 'Prepare a new one.'),
      );
      return;
    case 'UNCERTAIN':
      println(
        ctx.stdout,
        `The release note is UNCERTAIN: ${terminalSafeLine(outcome.reason)}. Nothing will be re-sent until a comment listing settles it.`,
      );
  }
}
