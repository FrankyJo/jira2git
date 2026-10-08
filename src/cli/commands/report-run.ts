import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  TestResultsInputSchema,
  buildAnalysisPackage,
  reportDiffOptions,
  reportFacts,
  toReportFile,
  type AnalysisPackage,
  type TestEvidence,
} from '../../ai/analysis';
import { packageWarnings } from '../../ai/engine';
import { buildSessionRequest } from '../../ai/prompt';
import { runTestCommand } from '../../ai/test-runner';
import type { GenerationResult, ReportGenerator } from '../../ai/types';
import { Git2JiraError, UsageError } from '../../core/errors';
import { openInBrowser } from '../../delivery/browser';
import { copyToClipboard } from '../../delivery/clipboard';
import type { Draft, ManualDraft } from '../../delivery/draft';
import { resolveDeliveryMode, type DeliveryMode } from '../../delivery/mode';
import { renderTextReport } from '../../delivery/render';
import { resolveDeliverySite } from '../../delivery/site';
import type { Language } from '../../localization/languages';
import { resolveLanguage } from '../../localization/resolve';
import { DEFAULT_MCP_SERVER_NAME } from '../../mcp/tools';
import type { StoredPlan } from '../../publication/plan';
import type { ReviewContext } from '../../publication/service';
import { renderPreview } from '../../report/preview';
import { println, type CliContext } from '../context';
import { includeUncommittedSetting, testCommandsSetting } from '../../config/settings';
import { configs, draftSummary, nextSteps, readJson } from './report';

export interface ReportRunOptions {
  dryRun?: boolean;
  mode?: string;
  language?: string;
  issue?: string;
  base?: string;
  site?: string;
  connection?: string;
  context?: string;
  issueTitle?: string;
  issueDescription?: string;
  testCommand?: string[];
  testResults?: string;
  ai?: 'auto' | 'session' | 'headless';
  allowApiBilling?: boolean;
  model?: string;
  acceptBranchChange?: boolean;
  server?: string;
  cloudId?: string;
  issueLookup?: string;
  json?: boolean;
}

type Writer = 'session' | 'headless';

/**
 * `git2jira report`: the whole reporting workflow.
 *
 * 1. Resolve mode, language, site; collect optional issue details and test evidence.
 * 2. Capture the candidate snapshot (or resume the pending report for this issue).
 * 3. Write the report: inside Claude Code the session writes it (hand-off, no nested
 *    process); in a terminal the headless writer does.
 * 4. Validate and render it, show the preview, and offer the actions. Only an explicit
 *    confirmation (manual) or publication (API token) moves the checkpoint.
 */
export async function runReport(ctx: CliContext, options: ReportRunOptions): Promise<void> {
  const { repoConfig, globalConfig } = await configs(ctx);
  const { mode } = resolveDeliveryMode({ override: options.mode, repoConfig, globalConfig });
  const { language } = resolveLanguage({ override: options.language, repoConfig, globalConfig });
  const writer = resolveWriter(ctx, options.ai);

  if (mode === 'api-token') {
    if (writer === 'session') {
      throw new UsageError(
        'API-token publication needs an interactive terminal confirmation, so it does not run inside a ' +
          'Claude Code session. Inside Claude Code use --mode manual or --mode mcp.',
      );
    }
    await runApiToken(ctx, options, language);
    return;
  }
  if (mode === 'mcp' && writer === 'headless') {
    throw new UsageError(
      'MCP mode publishes through the Atlassian MCP tools of your Claude Code session; a standalone ' +
        'terminal cannot use that authorization. Run /jira-report inside Claude Code, or use --mode manual ' +
        '(no Jira access needed). Nothing was prepared.',
    );
  }

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
  const issueContext = await readIssueContext(ctx, options);
  const tests = await collectTests(ctx, {
    ...options,
    testCommand: testCommandsSetting(options.testCommand, globalConfig),
  });

  if (options.dryRun) {
    await dryRun(ctx, options, {
      mode,
      language,
      writer,
      site: resolved.site,
      placeholder: resolved.placeholder,
      issueContext,
      tests,
      projectKeys: repoConfig.issue?.projectKeys,
      configuredBase: repoConfig.base?.branch,
      includeUncommitted: includeUncommittedSetting(repoConfig, globalConfig),
    });
    return;
  }

  const service = ctx.container.resolve('deliveryService');
  const outcome = await service.prepare({
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
    issueContext,
    tests,
    mcp: mode === 'mcp' ? await mcpLookup(ctx, options, globalConfig.mcp?.server) : undefined,
  });

  if (outcome.status === 'no-changes') {
    if (options.json) println(ctx.stdout, JSON.stringify({ result: 'no-changes' }));
    else println(ctx.stdout, 'No changes since the last confirmed report. Nothing to report.');
    return;
  }

  let draft = outcome.draft;
  if (outcome.status === 'pending') {
    println(
      ctx.stderr,
      `Resuming pending report #${String(draft.sequence)} for ${draft.issueKey} (${draft.status}, ${draft.mode}). ` +
        'It describes the snapshot taken when it was prepared; later changes go into the next report.',
    );
    if (draft.language !== language && !draft.report) {
      println(ctx.stderr, `It is written in "${draft.language}" as prepared.`);
    }
  }

  if (writer === 'session') {
    if (draft.rendered && !(draft.mode === 'manual' && draft.status === 'DRAFT')) {
      printDraft(ctx, draft, options.json);
      return;
    }
    const pkg = await service.analysis(ctx.cwd, draft.reportId);
    printHandoff(ctx, draft, pkg);
    return;
  }

  // Headless: write the report now unless the pending draft already has one.
  if (!draft.rendered) draft = await generateInto(ctx, options, draft);
  if (draft.mode !== 'manual' || options.json) {
    printDraft(ctx, draft, options.json);
    return;
  }
  await manualActions(ctx, options, draft);
}

// ---------------------------------------------------------------------------
// Writers

function resolveWriter(ctx: CliContext, option: ReportRunOptions['ai']): Writer {
  const inSession = Boolean(ctx.env?.CLAUDECODE);
  if (option === 'session') return 'session';
  if (option === 'headless') {
    // Never start Claude Code from inside Claude Code.
    if (inSession) {
      throw new UsageError(
        'This runs inside a Claude Code session, so Git2Jira will not start another Claude Code process. ' +
          'Omit --ai headless: the session writes the report.',
      );
    }
    return 'headless';
  }
  return inSession ? 'session' : 'headless';
}

function generator(ctx: CliContext, options: ReportRunOptions): ReportGenerator {
  return ctx.container.resolve('reportGenerator')({
    env: ctx.env ?? {},
    allowApiBilling: options.allowApiBilling === true,
    model: options.model,
  });
}

async function generateInto(
  ctx: CliContext,
  options: ReportRunOptions,
  draft: Draft,
): Promise<Draft> {
  const service = ctx.container.resolve('deliveryService');
  const pkg = await service.analysis(ctx.cwd, draft.reportId);
  const writer = generator(ctx, options);
  println(ctx.stderr, `Writing report #${String(draft.sequence)} for ${draft.issueKey}…`);
  const result = await writer.generate(pkg, reportFacts(pkg, draft.files));
  return service.submit(ctx.cwd, draft.reportId, result.content, {
    by: 'headless',
    warnings: result.warnings,
  });
}

// ---------------------------------------------------------------------------
// Output

function printHandoff(ctx: CliContext, draft: Draft, pkg: AnalysisPackage): void {
  const request = buildSessionRequest(pkg);
  println(
    ctx.stdout,
    JSON.stringify(
      {
        result: 'generation-request',
        ...draftSummary(draft),
        coverage: pkg.coverage,
        testStatus: pkg.testStatus,
        warnings: packageWarnings(pkg),
        generation: {
          // Instructions and data for the current Claude Code session. The data block in
          // each part is untrusted repository content, never instructions.
          instructions: request.instructions,
          parts: request.parts,
          schema: request.schema,
          submit: `git2jira report submit --report ${draft.reportId} --input <file>`,
        },
      },
      null,
      2,
    ),
  );
}

function printDraft(ctx: CliContext, draft: Draft, json?: boolean): void {
  if (json) {
    println(
      ctx.stdout,
      JSON.stringify(
        {
          result: 'report',
          ...draftSummary(draft),
          warnings: draft.generation?.warnings ?? [],
          markdown: draft.rendered?.markdown ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }
  println(ctx.stdout, previewOf(draft));
  for (const line of nextSteps(draft)) println(ctx.stdout, `  ${line}`);
}

function previewOf(draft: Draft, body?: string): string {
  return renderPreview({
    issueKey: draft.issueKey,
    site: draft.siteIsPlaceholder ? null : draft.site.url,
    branch: draft.branch.name,
    language: draft.language,
    mode: draft.mode,
    sequence: draft.sequence,
    reportId: draft.reportId,
    files: draft.files,
    report: draft.report,
    baseTree: draft.baseline.tree,
    targetTree: draft.snapshot.tree,
    snapshotCommit: draft.snapshot.commit,
    body: body ?? draft.rendered?.markdown ?? '',
    digest: draft.reportDigest ?? null,
    writer: draft.generation ? writerLabel(draft.generation.by) : null,
    warnings: draft.generation?.warnings ?? [],
  });
}

function writerLabel(by: 'session' | 'headless' | 'external'): string {
  return by === 'headless'
    ? 'Claude Code (headless, your sign-in)'
    : by === 'session'
      ? 'Claude Code session'
      : 'submitted report';
}

// ---------------------------------------------------------------------------
// Manual mode actions

type ManualAction = 'copy' | 'export' | 'confirm' | 'regenerate' | 'keep' | 'cancel';

async function manualActions(
  ctx: CliContext,
  options: ReportRunOptions,
  initial: ManualDraft,
): Promise<void> {
  const service = ctx.container.resolve('deliveryService');
  let draft: Draft = initial;
  println(ctx.stdout, previewOf(draft));
  if (!ctx.interactive) {
    println(ctx.stdout, 'The report is saved as a pending draft. Nothing was published.');
    for (const line of nextSteps(draft)) println(ctx.stdout, `  ${line}`);
    return;
  }
  const prompter = ctx.container.resolve('prompter');
  for (;;) {
    if (draft.mode !== 'manual' || !draft.reportDigest) return;
    const action = await prompter.select<ManualAction>('What next?', [
      { value: 'copy', label: 'Copy the report to the clipboard' },
      { value: 'export', label: 'Save the report to a file' },
      {
        value: 'confirm',
        label: 'I pasted it into Jira: confirm publication',
        hint: 'moves the checkpoint (user-attested)',
      },
      { value: 'regenerate', label: 'Regenerate the report', hint: 'same snapshot' },
      { value: 'keep', label: 'Keep it pending and exit' },
      { value: 'cancel', label: 'Cancel this report', hint: 'the checkpoint does not move' },
    ]);
    switch (action) {
      case 'copy': {
        const copied = await copyToClipboard(
          ctx.container.resolve('processRunner'),
          draft.rendered?.markdown ?? '',
        );
        if (!copied.copied) {
          println(ctx.stdout, 'No clipboard tool worked here. Save the report to a file instead.');
          break;
        }
        draft = await service.markPresented(ctx.cwd, draft.reportId, 'clipboard');
        println(
          ctx.stdout,
          `Copied. Paste it as a new comment on ${draft.issueKey}, save it in Jira, then confirm. Copying is not a confirmation.`,
        );
        break;
      }
      case 'export': {
        const file = await exportDraft(ctx, draft, undefined, 'markdown');
        draft = await service.markPresented(ctx.cwd, draft.reportId, 'file', file);
        println(ctx.stdout, `Saved to ${file}. Saving is not a confirmation.`);
        break;
      }
      case 'confirm': {
        const yes = await prompter.confirm(
          `Did you paste report #${String(draft.sequence)} into ${draft.issueKey} and save it in Jira?`,
          false,
        );
        if (!yes) {
          println(ctx.stdout, 'Not confirmed. The report stays pending.');
          break;
        }
        const outcome = await service.confirmManual(ctx.cwd, draft.reportId, draft.reportDigest, {
          interactive: true,
        });
        if (outcome.state === 'RECOVERY_REQUIRED') {
          throw new Git2JiraError(
            `Report ${draft.reportId} was not confirmed: ${outcome.reason}. The checkpoint did not move. See "git2jira report recover".`,
          );
        }
        println(
          ctx.stdout,
          `Report #${String(outcome.sequence)} is recorded as published (user-attested, not verified in Jira). ` +
            'The next report starts from this snapshot.',
        );
        return;
      }
      case 'regenerate':
        draft = await generateInto(ctx, options, draft);
        println(ctx.stdout, previewOf(draft));
        break;
      case 'keep':
        println(
          ctx.stdout,
          'Kept as a pending draft. Nothing was published; the checkpoint did not move.',
        );
        for (const line of nextSteps(draft)) println(ctx.stdout, `  ${line}`);
        return;
      case 'cancel':
        if (await prompter.confirm(`Cancel report #${String(draft.sequence)}?`, false)) {
          await service.cancel(ctx.cwd, draft.reportId);
          println(ctx.stdout, 'Report cancelled. The last confirmed checkpoint is unchanged.');
          return;
        }
        break;
    }
  }
}

/** Writes the report text (UTF-8) for pasting; never inside the working tree by default. */
export async function exportDraft(
  ctx: CliContext,
  draft: Draft,
  output: string | undefined,
  format: 'markdown' | 'text',
): Promise<string> {
  if (!draft.rendered) throw new Git2JiraError(`Report ${draft.reportId} has no text yet.`);
  const repository = await ctx.container.resolve('repositoryLocator').locate(ctx.cwd);
  const extension = format === 'markdown' ? 'md' : 'txt';
  if (output !== undefined) {
    // `report export` is pre-approved in the Skill, so inside Claude Code it must not be able
    // to write anywhere the session chooses.
    if (ctx.env?.CLAUDECODE) {
      throw new UsageError(
        'Inside Claude Code, "report export" writes only to .git/git2jira/exports. Use --output from a terminal.',
      );
    }
    if (!/\.(md|txt)$/i.test(output)) {
      throw new UsageError('--output must name a .md or .txt file.');
    }
  }
  const file = output
    ? path.resolve(ctx.cwd, output)
    : path.join(
        ctx.container.resolve('draftStore').exportDir(repository),
        `${draft.issueKey}-report-${String(draft.sequence)}-${draft.language}.${extension}`,
      );
  await mkdir(path.dirname(file), { recursive: true });
  try {
    // An explicit --output never replaces an existing file; the default export file is ours.
    await writeFile(file, draft.rendered[format], {
      encoding: 'utf8',
      mode: 0o600,
      flag: output === undefined ? 'w' : 'wx',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new UsageError(`${file} already exists; Git2Jira does not overwrite it.`);
    }
    throw error;
  }
  return file;
}

// ---------------------------------------------------------------------------
// Dry run: analyze and write, save nothing

async function dryRun(
  ctx: CliContext,
  options: ReportRunOptions,
  input: {
    mode: DeliveryMode;
    language: Language;
    writer: Writer;
    site: ReturnType<typeof resolveDeliverySite>['site'];
    placeholder: boolean;
    issueContext: { title?: string; description?: string } | undefined;
    tests: TestEvidence[];
    projectKeys: readonly string[] | undefined;
    configuredBase: string | undefined;
    includeUncommitted: boolean;
  },
): Promise<void> {
  const lifecycle = ctx.container.resolve('publicationLifecycle');
  const analysis = await lifecycle.analyze({
    cwd: ctx.cwd,
    issue: options.issue,
    projectKeys: input.projectKeys,
    base: options.base,
    configuredBase: input.configuredBase,
    site: input.site,
    acceptBranchChange: options.acceptBranchChange,
    diffOptions: reportDiffOptions(),
    includeUncommitted: input.includeUncommitted,
  });
  if (!analysis.hasChanges) {
    println(ctx.stdout, 'No changes since the last confirmed report. Nothing to report.');
    return;
  }
  const repository = analysis.context.repository;
  const repositoryId = (await ctx.container.resolve('lineageStore').repositoryIdentity(repository))
    .id;
  const files = analysis.changeSet.files.map(toReportFile);
  const pkg = buildAnalysisPackage({
    reportId: randomUUID(),
    issueKey: analysis.context.issueKey,
    language: input.language,
    deliveryMode: input.mode,
    repositoryId,
    repositoryRoot: repository.root,
    branch: analysis.context.branch.name,
    sequence: analysis.nextSequence,
    baseline: analysis.baseline,
    snapshot: analysis.snapshot,
    changeSet: analysis.changeSet,
    tests: input.tests,
    issue: input.issueContext,
    userContext: options.context,
  });
  if (input.writer === 'session') {
    const request = buildSessionRequest(pkg);
    println(
      ctx.stdout,
      JSON.stringify(
        {
          result: 'dry-run',
          issueKey: pkg.issueKey,
          sequence: pkg.snapshotIdentity.sequence,
          language: pkg.language,
          files: analysis.changeSet.files,
          coverage: pkg.coverage,
          warnings: packageWarnings(pkg),
          generation: {
            instructions: request.instructions,
            parts: request.parts,
            schema: request.schema,
          },
          note: 'Dry run: nothing was saved and no checkpoint moved. Run "git2jira report" to prepare a report.',
        },
        null,
        2,
      ),
    );
    return;
  }
  const result = await generator(ctx, options).generate(pkg, reportFacts(pkg, files));
  const labels = ctx.container.resolve('labelCatalog').labels(input.language);
  const body = renderTextReport({
    report: result.report,
    files,
    labels,
    marker: { reportId: pkg.reportId, sequence: pkg.snapshotIdentity.sequence },
  }).markdown;
  println(
    ctx.stdout,
    renderPreview({
      issueKey: pkg.issueKey,
      site: input.placeholder ? null : input.site.url,
      branch: pkg.branch,
      language: input.language,
      mode: input.mode,
      sequence: pkg.snapshotIdentity.sequence,
      reportId: null,
      files,
      report: result.report,
      baseTree: pkg.snapshotIdentity.baseTree,
      targetTree: pkg.snapshotIdentity.targetTree,
      snapshotCommit: pkg.snapshotIdentity.snapshotCommit,
      body,
      digest: null,
      writer: generatorLabel(result),
      warnings: result.warnings,
    }),
  );
  println(ctx.stdout, 'Dry run: nothing was saved, nothing was published, no checkpoint moved.');
}

function generatorLabel(result: GenerationResult): string {
  return `Claude Code (headless, ${String(result.calls)} call${result.calls === 1 ? '' : 's'})`;
}

// ---------------------------------------------------------------------------
// API-token mode (optional, standalone terminal only)

async function runApiToken(
  ctx: CliContext,
  options: ReportRunOptions,
  language: Language,
): Promise<void> {
  if (options.dryRun) {
    throw new UsageError('--dry-run is available for manual reports; use --mode manual --dry-run.');
  }
  const { repoConfig, globalConfig } = await configs(ctx);
  const publication = ctx.container.resolve('publicationService');
  const tests = await collectTests(ctx, {
    ...options,
    testCommand: testCommandsSetting(options.testCommand, globalConfig),
  });
  const outcome = await publication.prepare({
    cwd: ctx.cwd,
    issue: options.issue,
    projectKeys: repoConfig.issue?.projectKeys,
    connection: options.connection,
    site: options.site,
    repositorySite: repoConfig.jira?.site,
    language,
    base: options.base,
    configuredBase: repoConfig.base?.branch,
    includeUncommitted: includeUncommittedSetting(repoConfig, globalConfig),
    acceptBranchChange: options.acceptBranchChange,
  });
  if (outcome.status === 'no-changes') {
    println(ctx.stdout, 'No changes since the last published report. Nothing to report.');
    return;
  }
  let plan = outcome.plan;
  const review: ReviewContext = {
    tests,
    issue: { title: outcome.issue.summary, description: outcome.issue.description },
    userContext: options.context,
  };
  const write = async (): Promise<{ digest: string; warnings: string[] }> => {
    const pkg = await publication.analysis(ctx.cwd, plan.reportId, review);
    println(ctx.stderr, `Writing report #${String(plan.sequence)} for ${plan.issueKey}…`);
    const result = await generator(ctx, options).generate(pkg, reportFacts(pkg, plan.files));
    const reviewed = await publication.review(ctx.cwd, plan.reportId, result.content, review);
    plan = reviewed.plan;
    println(ctx.stdout, planPreview(ctx, plan, result.warnings));
    return { digest: reviewed.reportDigest, warnings: result.warnings };
  };

  try {
    let { digest } = await write();
    if (!ctx.interactive) {
      await publication.cancel(ctx.cwd, plan.reportId);
      println(
        ctx.stdout,
        'Publishing with an API token needs an interactive confirmation in a terminal. Nothing was sent; ' +
          'the report was discarded and the checkpoint did not move.',
      );
      return;
    }
    const prompter = ctx.container.resolve('prompter');
    for (;;) {
      const action = await prompter.select<'publish' | 'regenerate' | 'save' | 'cancel'>(
        `Publish report #${String(plan.sequence)} to ${plan.issueKey} on ${plan.site.url}?`,
        [
          { value: 'publish', label: 'Publish this exact report as a new Jira comment' },
          { value: 'regenerate', label: 'Regenerate the report', hint: 'same snapshot' },
          { value: 'save', label: 'Save the text to a file and cancel' },
          { value: 'cancel', label: 'Cancel', hint: 'nothing is sent' },
        ],
      );
      if (action === 'regenerate') {
        ({ digest } = await write());
        continue;
      }
      if (action === 'save') {
        const file = await savePlanText(ctx, plan);
        await publication.cancel(ctx.cwd, plan.reportId);
        println(
          ctx.stdout,
          `Saved to ${file}. The report was not published; the checkpoint did not move.`,
        );
        return;
      }
      if (action === 'cancel') {
        await publication.cancel(ctx.cwd, plan.reportId);
        println(ctx.stdout, 'Cancelled. Nothing was sent; the checkpoint did not move.');
        return;
      }
      await publication.approve(ctx.cwd, plan.reportId, digest);
      const result = await publication.publish(ctx.cwd, plan.reportId, digest);
      switch (result.state) {
        case 'PUBLISHED':
        case 'RECOVERED':
          println(ctx.stdout, `Published report #${String(plan.sequence)}: ${result.commentUrl}`);
          if (result.warning) println(ctx.stdout, `Warning: ${result.warning}`);
          if (globalConfig.jira?.openAfterPublish === true) {
            await openInBrowser(ctx.container.resolve('processRunner'), result.commentUrl);
          }
          return;
        case 'FAILED':
          throw new Git2JiraError(
            `Jira did not create the comment (${result.error.message}). ${result.retryable ? 'Run "git2jira report" again to retry.' : ''}`,
          );
        case 'UNCERTAIN':
          throw new Git2JiraError(
            `The outcome is unknown (${result.error.message}). Run "git2jira recover"; nothing will be re-sent until it is settled.`,
          );
      }
    }
  } catch (error) {
    // A plan that never reached the journal can be discarded safely; anything later is kept.
    const current = await publication.getPlan(ctx.cwd, plan.reportId).catch(() => undefined);
    if (current && ['DRAFT', 'READY_FOR_REVIEW', 'APPROVED'].includes(current.status)) {
      await publication.cancel(ctx.cwd, plan.reportId).catch(() => undefined);
    }
    throw error;
  }
}

function planPreview(ctx: CliContext, plan: StoredPlan, warnings: readonly string[]): string {
  const labels = ctx.container.resolve('labelCatalog').labels(plan.language);
  const body =
    plan.report?.schemaVersion === 2
      ? renderTextReport({
          report: plan.report,
          files: plan.files,
          labels,
          marker: { reportId: plan.reportId, sequence: plan.sequence },
        }).markdown
      : '';
  return renderPreview({
    issueKey: plan.issueKey,
    site: plan.site.url,
    branch: plan.branch.name,
    language: plan.language,
    mode: 'api-token',
    sequence: plan.sequence,
    reportId: plan.reportId,
    files: plan.files,
    report: plan.report,
    baseTree: plan.baseline.tree,
    targetTree: plan.snapshot.tree,
    snapshotCommit: plan.snapshot.commit,
    body,
    digest: plan.reportDigest ?? null,
    writer: 'Claude Code (headless, your sign-in)',
    warnings,
  });
}

async function savePlanText(ctx: CliContext, plan: StoredPlan): Promise<string> {
  const repository = await ctx.container.resolve('repositoryLocator').locate(ctx.cwd);
  const labels = ctx.container.resolve('labelCatalog').labels(plan.language);
  if (plan.report?.schemaVersion !== 2) throw new Git2JiraError('No report text.');
  const text = renderTextReport({
    report: plan.report,
    files: plan.files,
    labels,
    marker: { reportId: plan.reportId, sequence: plan.sequence },
  }).markdown;
  const file = path.join(
    ctx.container.resolve('draftStore').exportDir(repository),
    `${plan.issueKey}-report-${String(plan.sequence)}-${plan.language}.md`,
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
  return file;
}

// ---------------------------------------------------------------------------
// Inputs

async function readIssueContext(
  ctx: CliContext,
  options: ReportRunOptions,
): Promise<{ title?: string; description?: string } | undefined> {
  let description: string | undefined;
  if (options.issueDescription !== undefined) {
    const file = path.resolve(ctx.cwd, options.issueDescription);
    const content = await readFile(file, 'utf8').catch((error: unknown) => {
      throw new UsageError(
        `Cannot read ${options.issueDescription ?? ''}: ${(error as Error).message}`,
      );
    });
    description = content.slice(0, 20_000);
  }
  const title = options.issueTitle?.slice(0, 2000);
  if (!title && !description) return undefined;
  return { ...(title ? { title } : {}), ...(description ? { description } : {}) };
}

/** Runs `--test-command`s (verified) and reads `--test-results` (reported). */
export async function collectTests(
  ctx: CliContext,
  options: Pick<ReportRunOptions, 'testCommand' | 'testResults'>,
): Promise<TestEvidence[]> {
  const evidence: TestEvidence[] = [];
  const commands = options.testCommand ?? [];
  if (commands.length > 0) {
    const repository = await ctx.container.resolve('repositoryLocator').locate(ctx.cwd);
    for (const command of commands.slice(0, 10)) {
      println(ctx.stderr, `Running tests: ${command}`);
      const result = await runTestCommand(ctx.container.resolve('processRunner'), command, {
        cwd: repository.root,
        ...(ctx.env ? { env: { ...ctx.env } } : {}),
      });
      println(ctx.stderr, `  ${result.outcome}`);
      evidence.push(result);
    }
  }
  if (options.testResults !== undefined) {
    const parsed = TestResultsInputSchema.safeParse(await readJson(ctx, options.testResults));
    if (!parsed.success) {
      throw new UsageError(
        `${options.testResults} is not a test results file ({ "schemaVersion": 1, "results": [{ "command", "outcome": "passed" | "failed", "summary"? }] }).`,
      );
    }
    for (const result of parsed.data.results) evidence.push({ ...result, source: 'reported' });
  }
  return evidence.slice(0, 20);
}

async function mcpLookup(
  ctx: CliContext,
  options: ReportRunOptions,
  configuredServer: string | undefined,
): Promise<{ server: string; cloudId: string; issueLookup: unknown }> {
  if (options.cloudId === undefined || options.issueLookup === undefined) {
    throw new UsageError(
      'MCP mode needs the issue looked up with the Atlassian MCP tools first: pass --site, --cloud-id, ' +
        'and --issue-lookup <file> (the Skill does this). If the MCP tools are not available, use --mode manual.',
    );
  }
  return {
    server: options.server ?? configuredServer ?? DEFAULT_MCP_SERVER_NAME,
    cloudId: options.cloudId,
    issueLookup: await readJson(ctx, options.issueLookup),
  };
}
