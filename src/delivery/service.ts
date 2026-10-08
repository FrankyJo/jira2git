import path from 'node:path';
import { z } from 'zod';
import type { AdfRenderer, ReportFile } from '../adf/types';
import { validateAdfDocument } from '../adf/validate';
import { StaleReportError } from '../checkpoints/errors';
import { withFileLock, type LockOptions } from '../checkpoints/lock';
import type { GitRefs } from '../checkpoints/refs';
import type { LineageStore } from '../checkpoints/store';
import { isCheckpoint, latestCheckpoint, type JiraSite } from '../checkpoints/types';
import { Git2JiraError, UsageError } from '../core/errors';
import { terminalSafeLine } from '../core/sanitize';
import { VERSION } from '../core/version';
import type { GitRepositoryLocator, IssueKey, RepositoryInfo } from '../git/types';
import { IssueKeyMismatchError } from '../jira/client/errors';
import type { LabelCatalog } from '../localization/catalog';
import type { Language } from '../localization/languages';
import { McpReconcileInputSchema, McpWriteResultSchema, type McpWriteResult } from '../mcp/bridge';
import {
  classifyMcpError,
  parseAccountId,
  parseCommentListing,
  parseCreatedComment,
  parseIssueLookup,
  singleMarker,
  type CommentListing,
  type ParsedComment,
} from '../mcp/results';
import { ATLASSIAN_TOOLS } from '../mcp/tools';
import { canonicalJson, changesDigest, sha256 } from '../publication/digest';
import {
  ApprovalMismatchError,
  PublicationMismatchError,
  ReportValidationError,
} from '../publication/errors';
import type {
  Analysis,
  LineageKey,
  PublicationCandidate,
  PublicationLifecycle,
} from '../publication/lifecycle';
import { commentUrl } from '../publication/service';
import { StructuredReportSchema } from '../report/schema';
import { stateDir } from '../snapshots/engine';
import type { ChangeSet, DiffOptions, FileChange, IncrementalDiffEngine } from '../snapshots/types';
import { isOpen, type Draft, type DraftStore, type ManualDraft, type McpDraft } from './draft';
import { markerLine, renderTextReport } from './render';

export interface DeliveryServiceDependencies {
  lifecycle: PublicationLifecycle;
  drafts: DraftStore;
  locator: GitRepositoryLocator;
  diff: IncrementalDiffEngine;
  refs: GitRefs;
  store: LineageStore;
  renderer: AdfRenderer;
  labels: LabelCatalog;
  now?: () => Date;
  toolVersion?: string;
  /** How long after an MCP write attempt "not found in Jira" may be trusted. */
  settleWindowMs?: number;
  lockOptions?: LockOptions;
}

export interface DraftPrepareRequest {
  mode: 'manual' | 'mcp';
  cwd: string;
  issue?: string | undefined;
  projectKeys?: readonly string[] | undefined;
  base?: string | undefined;
  configuredBase?: string | undefined;
  acceptBranchChange?: boolean | undefined;
  diffOptions?: Partial<DiffOptions> | undefined;
  language: Language;
  site: JiraSite;
  siteIsPlaceholder: boolean;
  userContext?: string | undefined;
  /** MCP mode only. */
  mcp?:
    | {
        server: string;
        cloudId: string;
        /** Raw result of the MCP issue lookup for this key. */
        issueLookup: unknown;
      }
    | undefined;
}

export type DraftPrepareOutcome =
  | { status: 'prepared'; draft: Draft; changeSet: ChangeSet }
  | { status: 'no-changes'; analysis: Analysis }
  /** An open draft already exists for this issue; resume or cancel it first. */
  | { status: 'pending'; draft: Draft };

export type ManualConfirmOutcome =
  | { state: 'MANUALLY_CONFIRMED'; draft: ManualDraft; sequence: number }
  | { state: 'RECOVERY_REQUIRED'; draft: ManualDraft; reason: string };

/** What the Skill must send with the comment creation tool, exactly. */
export interface McpPublishPayload {
  reportId: string;
  server: string;
  cloudId: string;
  issueKey: string;
  /** Documented tool name; the session's full name is `mcp__<server>__<tool>`. */
  tool: string;
  /** Use `markdown` or `adf`, whichever body format the tool's schema accepts. */
  body: { markdown: string; adf: unknown };
  marker: string;
  reportDigest: string;
}

export type McpResultOutcome =
  | {
      state: 'PUBLISHED' | 'RECOVERED';
      draft: McpDraft;
      commentId: string;
      commentUrl: string;
      warning?: string;
    }
  | { state: 'FAILED'; draft: McpDraft; retryable: boolean; reason: string }
  | { state: 'UNCERTAIN'; draft: McpDraft; reason: string; retryAfterMs: number };

export interface DraftRecoveryAction {
  reportId: string;
  sequence: number;
  mode: 'manual' | 'mcp';
  action:
    | 'confirmed'
    | 'resumed'
    | 'recovery-required'
    | 'needs-reconcile'
    | 'synced-published'
    | 'unchanged';
  detail?: string;
}

/**
 * Report drafts for manual and MCP delivery, on top of PublicationLifecycle.
 *
 * The CLI owns snapshots, checkpoints, report state, and validation. The Claude Code
 * session writes the report and, in MCP mode, calls the Atlassian tools. A checkpoint
 * moves only on (a) the user's own confirmation of the exact digest (manual,
 * user-attested), or (b) an MCP tool result or comment listing that carries this
 * report's marker (MCP). A bare "it worked" from the model never moves it.
 */
export class ReportDeliveryService {
  private readonly now: () => Date;
  private readonly toolVersion: string;
  private readonly settleWindowMs: number;

  constructor(private readonly deps: DeliveryServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.toolVersion = deps.toolVersion ?? VERSION;
    this.settleWindowMs = deps.settleWindowMs ?? 120_000;
  }

  // ---------------------------------------------------------------------------
  // Shared: prepare → submit

  async prepare(request: DraftPrepareRequest): Promise<DraftPrepareOutcome> {
    const { lifecycle } = this.deps;
    const identity = await lifecycle.identify(request);
    const { repository, issueKey } = identity;

    let issue: { id: string; summary: string } | undefined;
    if (request.mode === 'mcp') {
      if (!request.mcp)
        throw new UsageError('MCP mode needs the server, cloud id, and issue lookup.');
      const found = parseIssueLookup(request.mcp.issueLookup);
      if (!found) {
        throw new Git2JiraError(
          `The MCP issue lookup result for ${issueKey} could not be read. Nothing was prepared.`,
        );
      }
      // Never switch issues: the lookup must return exactly this key (not a moved issue).
      if (found.key !== issueKey) throw new IssueKeyMismatchError(issueKey, found.key);
      issue = { id: found.id, summary: found.summary.slice(0, 2000) };
    }

    const open = (await this.deps.drafts.list(repository)).find(
      (d) => isOpen(d) && d.site.id === request.site.id && d.issueKey === issueKey,
    );
    if (open) return { status: 'pending', draft: open };

    const result = await lifecycle.prepare({ ...request, site: request.site });
    if (result.status === 'no-changes') return { status: 'no-changes', analysis: result.analysis };
    const prepared = result.report;
    try {
      const files = prepared.changeSet.files.map(toReportFile);
      const timestamp = this.now().toISOString();
      const core = {
        schemaVersion: 1 as const,
        reportId: prepared.reportId,
        site: prepared.site,
        siteIsPlaceholder: request.siteIsPlaceholder,
        issueKey,
        repositoryId: (await this.deps.store.repositoryIdentity(repository)).id,
        branch: prepared.context.branch,
        baseline: prepared.baseline,
        snapshot: prepared.snapshot,
        snapshotRef: prepared.snapshotRef,
        sequence: prepared.nextSequence,
        language: request.language,
        files,
        changesDigest: changesDigest(files),
        ...(request.userContext ? { userContext: request.userContext.slice(0, 4000) } : {}),
        events: [{ at: timestamp, status: 'DRAFT' }],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const draft: Draft =
        request.mode === 'manual'
          ? { ...core, mode: 'manual', status: 'DRAFT', exports: [] }
          : {
              ...core,
              mode: 'mcp',
              status: 'DRAFT',
              server: request.mcp?.server ?? '',
              cloudId: request.mcp?.cloudId ?? '',
              issue: issue ?? { id: '0', summary: '' },
              attempts: [],
            };
      await this.deps.drafts.write(repository, draft);
      return { status: 'prepared', draft, changeSet: prepared.changeSet };
    } catch (error) {
      await lifecycle.cancel(prepared).catch(() => undefined);
      throw error;
    }
  }

  /** Validates a structured report and renders it (Markdown, plain text, ADF) with a digest. */
  async submit(cwd: string, reportId: string, input: unknown): Promise<Draft> {
    const repository = await this.deps.locator.locate(cwd);
    const draft = await this.deps.drafts.read(repository, reportId);
    const editable =
      draft.mode === 'manual'
        ? ['DRAFT', 'READY_TO_COPY', 'AWAITING_MANUAL_CONFIRMATION'].includes(draft.status)
        : ['DRAFT', 'READY_FOR_REVIEW', 'APPROVED'].includes(draft.status);
    if (!editable) {
      throw new Git2JiraError(
        `Report ${reportId} is ${draft.status}; its content can no longer change.`,
      );
    }
    const parsed = StructuredReportSchema.safeParse(input);
    if (!parsed.success) {
      throw new ReportValidationError(
        z.prettifyError(parsed.error).split('\n').slice(0, 6).join(' '),
      );
    }
    const report = parsed.data;
    // Which issue a report goes to is decided by Git and the user, never by model output.
    if (report.issueKey !== draft.issueKey) {
      throw new ReportValidationError(
        `it is for ${report.issueKey}, but was prepared for ${draft.issueKey}.`,
      );
    }
    if (report.language !== draft.language) {
      throw new ReportValidationError(
        `it is written in "${report.language}", expected "${draft.language}".`,
      );
    }
    const labels = this.deps.labels.labels(draft.language);
    const adf = validateAdfDocument(
      this.deps.renderer.render({
        report,
        files: draft.files,
        labels,
        footer: {
          reportId: draft.reportId,
          sequence: draft.sequence,
          baseTree: draft.baseline.tree,
          targetTree: draft.snapshot.tree,
          toolVersion: this.toolVersion,
        },
      }),
    );
    const text = renderTextReport({
      report,
      files: draft.files,
      labels,
      marker: { reportId: draft.reportId, sequence: draft.sequence },
    });
    const rendered = { ...text, adf };
    const reportDigest = draftDigest(draft, rendered);

    if (draft.mode === 'manual') {
      return this.deps.drafts.transition(
        repository,
        draft,
        { ...draft, status: 'READY_TO_COPY', report, rendered, reportDigest },
        this.now(),
      );
    }
    const { approval: _cleared, ...rest } = draft;
    return this.deps.drafts.transition(
      repository,
      draft,
      { ...rest, status: 'READY_FOR_REVIEW', report, rendered, reportDigest },
      this.now(),
    );
  }

  async get(cwd: string, reportId: string): Promise<Draft> {
    return this.deps.drafts.read(await this.deps.locator.locate(cwd), reportId);
  }

  async list(cwd: string): Promise<Draft[]> {
    return this.deps.drafts.list(await this.deps.locator.locate(cwd));
  }

  /** The single open draft for the current issue, when `--report` is not given. */
  async current(cwd: string, issueKey?: IssueKey): Promise<Draft> {
    const open = (await this.list(cwd)).filter(
      (d) => isOpen(d) && (issueKey === undefined || d.issueKey === issueKey),
    );
    if (open.length === 1 && open[0]) return open[0];
    if (open.length === 0)
      throw new Git2JiraError('There is no pending report. Run "git2jira report prepare".');
    throw new UsageError(
      `Several reports are pending (${open.map((d) => `${d.issueKey} #${String(d.sequence)} ${d.reportId}`).join(', ')}). Pass --report <id>.`,
    );
  }

  /** Abandons a draft that has not been (and is not being) published. The baseline does not move. */
  async cancel(cwd: string, reportId: string): Promise<Draft> {
    const repository = await this.deps.locator.locate(cwd);
    const draft = await this.deps.drafts.read(repository, reportId);
    const cancellable =
      draft.mode === 'manual'
        ? ['DRAFT', 'READY_TO_COPY', 'AWAITING_MANUAL_CONFIRMATION', 'RECOVERY_REQUIRED'].includes(
            draft.status,
          )
        : ['DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'FAILED'].includes(draft.status);
    if (!cancellable) {
      throw new Git2JiraError(
        draft.mode === 'mcp' && (draft.status === 'PUBLISHING' || draft.status === 'UNCERTAIN')
          ? `Report ${reportId} is ${draft.status}: it may already be in Jira. Settle it with "git2jira report reconcile" first.`
          : `Report ${reportId} is ${draft.status} and cannot be cancelled.`,
      );
    }
    return this.withLineageLock(repository, draft, async () => {
      await this.deps.lifecycle.cancel(this.candidate(repository, draft));
      return this.deps.drafts.transition(
        repository,
        draft,
        { ...draft, status: 'CANCELLED' },
        this.now(),
        'cancelled by the user',
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Manual mode

  /** Records that the report was handed to the user for pasting (clipboard or file). */
  async markPresented(
    cwd: string,
    reportId: string,
    via: 'clipboard' | 'file',
    file?: string,
  ): Promise<ManualDraft> {
    const repository = await this.deps.locator.locate(cwd);
    const draft = this.requireManual(await this.deps.drafts.read(repository, reportId));
    if (
      !draft.rendered ||
      (draft.status !== 'READY_TO_COPY' && draft.status !== 'AWAITING_MANUAL_CONFIRMATION')
    ) {
      throw new Git2JiraError(
        `Report ${reportId} is ${draft.status}; there is no finished report to copy.`,
      );
    }
    return this.deps.drafts.transition(
      repository,
      draft,
      {
        ...draft,
        status: 'AWAITING_MANUAL_CONFIRMATION',
        exports: [
          ...draft.exports,
          { at: this.now().toISOString(), via, ...(file ? { path: file } : {}) },
        ],
      },
      this.now(),
    );
  }

  /**
   * The user states that they pasted exactly this report (digest) into the issue.
   * User-attested: nothing is checked in Jira. The candidate snapshot captured at
   * preparation becomes the checkpoint, so later working-tree changes stay unreported.
   */
  async confirmManual(
    cwd: string,
    reportId: string,
    digest: string,
    options: { interactive: boolean },
  ): Promise<ManualConfirmOutcome> {
    const repository = await this.deps.locator.locate(cwd);
    const initial = this.requireManual(await this.deps.drafts.read(repository, reportId));
    return this.withLineageLock(repository, initial, async () => {
      let draft = this.requireManual(await this.deps.drafts.read(repository, reportId));
      if (draft.status === 'MANUALLY_CONFIRMED') {
        return { state: 'MANUALLY_CONFIRMED', draft, sequence: draft.sequence };
      }
      if (
        !['READY_TO_COPY', 'AWAITING_MANUAL_CONFIRMATION', 'RECOVERY_REQUIRED'].includes(
          draft.status,
        )
      ) {
        throw new Git2JiraError(`Report ${reportId} is ${draft.status} and cannot be confirmed.`);
      }
      if (!draft.rendered || !draft.reportDigest) {
        throw new Git2JiraError(`Report ${reportId} has no finished text yet; nothing to confirm.`);
      }
      if (digest !== draft.reportDigest || digest !== draftDigest(draft, draft.rendered)) {
        throw new ApprovalMismatchError();
      }

      try {
        await this.verifySnapshot(repository, draft);
        await this.verifyChanges(repository, draft);
      } catch (error) {
        return this.requireRecovery(repository, draft, messageOf(error));
      }

      // Write the attestation first: if the process dies after the journal entry,
      // recovery knows the user confirmed and finishes the promotion.
      draft = await this.deps.drafts.transition(
        repository,
        draft,
        {
          ...draft,
          attestation: {
            reportDigest: digest,
            attestedAt: this.now().toISOString(),
            method: 'user-attested',
            interactive: options.interactive,
          },
        },
        this.now(),
        'user confirmed manual publication',
      );
      const key = this.lineageKey(repository, draft);
      try {
        await this.deps.lifecycle.beginPublication(this.candidate(repository, draft), digest);
      } catch (error) {
        const { attestation: _undo, ...rest } = draft;
        const reason =
          error instanceof StaleReportError
            ? 'another report for this issue was confirmed after this one was prepared; cancel this one and prepare a new report'
            : messageOf(error);
        return this.requireRecovery(repository, rest, reason);
      }
      try {
        await this.deps.lifecycle.confirmPublication(key, reportId, {
          publishedAt: this.now().toISOString(),
          confirmedBy: 'user-attested',
        });
      } catch (error) {
        return this.requireRecovery(
          repository,
          draft,
          `the confirmation was recorded but the checkpoint was not saved (${messageOf(error)}); run "git2jira report recover"`,
        );
      }
      const confirmed = await this.deps.drafts.transition(
        repository,
        draft,
        { ...withoutRecovery(draft), status: 'MANUALLY_CONFIRMED' },
        this.now(),
      );
      return { state: 'MANUALLY_CONFIRMED', draft: confirmed, sequence: confirmed.sequence };
    });
  }

  /**
   * Withdraws a confirmation the user made by mistake. Only the latest checkpoint, and
   * only a user-attested one, can be withdrawn; the report returns to awaiting
   * confirmation with the same snapshot and text.
   */
  async revokeManual(cwd: string, reportId: string, reason: string): Promise<ManualDraft> {
    const repository = await this.deps.locator.locate(cwd);
    const initial = this.requireManual(await this.deps.drafts.read(repository, reportId));
    return this.withLineageLock(repository, initial, async () => {
      const draft = this.requireManual(await this.deps.drafts.read(repository, reportId));
      if (draft.status !== 'MANUALLY_CONFIRMED') {
        throw new Git2JiraError(`Report ${reportId} is ${draft.status}, not MANUALLY_CONFIRMED.`);
      }
      await this.deps.lifecycle.revokeCheckpoint(
        this.lineageKey(repository, draft),
        reportId,
        reason,
      );
      const { attestation: _removed, ...rest } = draft;
      return this.deps.drafts.transition(
        repository,
        draft,
        { ...rest, status: 'AWAITING_MANUAL_CONFIRMATION' },
        this.now(),
        `confirmation withdrawn: ${reason}`,
      );
    });
  }

  /**
   * Settles drafts with the journal after interruptions: finishes attested
   * confirmations, syncs drafts whose checkpoint exists, and flags drafts whose
   * snapshot or baseline no longer holds. MCP drafts that are in flight are listed:
   * they need a comment listing (`report reconcile`). Never contacts Jira.
   */
  async recover(cwd: string, issueKey?: IssueKey): Promise<DraftRecoveryAction[]> {
    const repository = await this.deps.locator.locate(cwd);
    const actions: DraftRecoveryAction[] = [];
    const drafts = (await this.deps.drafts.list(repository)).filter(
      (d) => isOpen(d) && (issueKey === undefined || d.issueKey === issueKey),
    );
    const lineages = new Map<string, Draft>();
    for (const draft of drafts) lineages.set(`${draft.site.id}/${draft.issueKey}`, draft);
    for (const draft of lineages.values()) {
      await this.deps.lifecycle.recover(this.lineageKey(repository, draft));
    }
    for (const listed of drafts) {
      const action = await this.withLineageLock(repository, listed, async () => {
        const draft = await this.deps.drafts.read(repository, listed.reportId);
        return draft.mode === 'manual'
          ? this.recoverManual(repository, draft)
          : this.recoverMcp(repository, draft);
      });
      actions.push(action);
    }
    return actions;
  }

  private async recoverManual(
    repository: RepositoryInfo,
    draft: ManualDraft,
  ): Promise<DraftRecoveryAction> {
    const base = { reportId: draft.reportId, sequence: draft.sequence, mode: 'manual' as const };
    const journal = await this.deps.store.read(repository, draft.site.id, draft.issueKey);
    const record = journal?.records.find((r) => r.reportId === draft.reportId);
    const key = this.lineageKey(repository, draft);

    if (record && isCheckpoint(record)) {
      await this.deps.drafts.transition(
        repository,
        draft,
        { ...withoutRecovery(draft), status: 'MANUALLY_CONFIRMED' },
        this.now(),
        'synced with the checkpoint',
      );
      return { ...base, action: 'synced-published' };
    }
    if (record && (record.state === 'publishing' || record.state === 'confirmed')) {
      if (draft.attestation?.reportDigest === record.reportDigest) {
        await this.deps.lifecycle.resolvePending(key, draft.reportId, {
          published: true,
          publishedAt: draft.attestation.attestedAt,
          confirmedBy: 'user-attested',
        });
        await this.deps.drafts.transition(
          repository,
          draft,
          { ...withoutRecovery(draft), status: 'MANUALLY_CONFIRMED' },
          this.now(),
          'finished an interrupted confirmation',
        );
        return { ...base, action: 'confirmed' };
      }
      // No attestation for this digest: the user never confirmed it, so it was not published.
      await this.deps.lifecycle.resolvePending(key, draft.reportId, {
        published: false,
        retryable: true,
      });
    }

    const problem = await this.problemWith(repository, draft);
    if (problem) {
      if (draft.status !== 'RECOVERY_REQUIRED')
        await this.requireRecovery(repository, draft, problem);
      return { ...base, action: 'recovery-required', detail: problem };
    }
    if (draft.status === 'RECOVERY_REQUIRED') {
      const resume = draft.resumeStatus ?? (draft.rendered ? 'READY_TO_COPY' : 'DRAFT');
      const { attestation: _drop, ...rest } = withoutRecovery(draft);
      await this.deps.drafts.transition(
        repository,
        draft,
        { ...rest, status: resume },
        this.now(),
        'recovered',
      );
      return { ...base, action: 'resumed', detail: resume };
    }
    return { ...base, action: 'unchanged' };
  }

  private async recoverMcp(
    repository: RepositoryInfo,
    draft: McpDraft,
  ): Promise<DraftRecoveryAction> {
    const base = { reportId: draft.reportId, sequence: draft.sequence, mode: 'mcp' as const };
    const journal = await this.deps.store.read(repository, draft.site.id, draft.issueKey);
    const record = journal?.records.find((r) => r.reportId === draft.reportId);
    if (record && isCheckpoint(record) && draft.publication) {
      await this.deps.drafts.transition(
        repository,
        draft,
        { ...draft, status: 'RECOVERED' },
        this.now(),
      );
      return { ...base, action: 'synced-published' };
    }
    if (draft.status === 'PUBLISHING' || draft.status === 'UNCERTAIN') {
      return {
        ...base,
        action: 'needs-reconcile',
        detail: `list the issue's comments with ${ATLASSIAN_TOOLS.listComments} and run "git2jira report reconcile"`,
      };
    }
    const problem = await this.problemWith(repository, draft);
    return problem
      ? {
          ...base,
          action: 'recovery-required',
          detail: `${problem}; cancel this report and prepare a new one`,
        }
      : { ...base, action: 'unchanged' };
  }

  // ---------------------------------------------------------------------------
  // MCP mode

  /**
   * The user's approval of the exact report, and the write-ahead record that a
   * comment is about to be created. Returns the exact payload for the MCP tool. A
   * second attempt for the same report requires a complete comment listing that
   * shows the report is not in Jira.
   */
  async publishMcp(
    cwd: string,
    reportId: string,
    digest: string,
    listing?: unknown,
  ): Promise<McpPublishPayload> {
    const repository = await this.deps.locator.locate(cwd);
    const initial = this.requireMcp(await this.deps.drafts.read(repository, reportId));
    return this.withLineageLock(repository, initial, async () => {
      let draft = this.requireMcp(await this.deps.drafts.read(repository, reportId));
      if (draft.status === 'PUBLISHING' || draft.status === 'UNCERTAIN') {
        throw new Git2JiraError(
          `Report ${reportId} is ${draft.status}: its outcome in Jira is not settled. Run "git2jira report reconcile" instead of publishing again.`,
        );
      }
      if (draft.status === 'FAILED' && draft.failure?.retryable === false) {
        throw new Git2JiraError(
          `Report ${reportId} failed permanently (${draft.failure.reason}). Prepare a new report.`,
        );
      }
      if (!['READY_FOR_REVIEW', 'APPROVED', 'FAILED'].includes(draft.status)) {
        throw new Git2JiraError(
          `Report ${reportId} is ${draft.status}; submit and review it first.`,
        );
      }
      if (!draft.rendered || !draft.reportDigest)
        throw new Git2JiraError(`Report ${reportId} has no finished text.`);
      if (digest !== draft.reportDigest || digest !== draftDigest(draft, draft.rendered)) {
        throw new ApprovalMismatchError();
      }
      await this.verifySnapshot(repository, draft);
      await this.verifyChanges(repository, draft);

      if (draft.attempts.length > 0) {
        if (listing === undefined) {
          throw new Git2JiraError(
            `Report ${reportId} was attempted before. To make sure it is not already in Jira, list the issue's ` +
              `comments with ${ATLASSIAN_TOOLS.listComments} and pass them with --comments.`,
          );
        }
        const found = this.findInListing(draft, McpReconcileInputSchema.parse(listing));
        if (found.kind === 'found') {
          throw new Git2JiraError(
            `Report ${reportId} is already in Jira (comment ${found.comment.id}). Run "git2jira report reconcile" to record it.`,
          );
        }
        if (found.kind === 'incomplete') {
          throw new Git2JiraError(
            `The comment listing is incomplete (${found.reason}); Git2Jira cannot rule out that the report is already in Jira. Nothing was authorized.`,
          );
        }
      }

      const at = this.now().toISOString();
      if (draft.status !== 'FAILED') {
        draft = await this.deps.drafts.transition(
          repository,
          draft,
          { ...draft, status: 'APPROVED', approval: { reportDigest: digest, approvedAt: at } },
          this.now(),
          'approved by the user',
        );
      }
      await this.deps.lifecycle.beginPublication(this.candidate(repository, draft), digest);
      const { failure: _failure, ...rest } = draft;
      draft = await this.deps.drafts.transition(
        repository,
        draft,
        {
          ...rest,
          status: 'PUBLISHING',
          approval: { reportDigest: digest, approvedAt: draft.approval?.approvedAt ?? at },
          attempts: [...draft.attempts, { startedAt: at }],
        },
        this.now(),
      );
      return {
        reportId,
        server: draft.server,
        cloudId: draft.cloudId,
        issueKey: draft.issueKey,
        tool: ATLASSIAN_TOOLS.writeComment,
        body: { markdown: draft.rendered?.markdown ?? '', adf: draft.rendered?.adf },
        marker: markerLine({ reportId, sequence: draft.sequence }),
        reportDigest: digest,
      };
    });
  }

  /** Records what the single authorized comment creation call returned. */
  async recordMcpResult(cwd: string, reportId: string, input: unknown): Promise<McpResultOutcome> {
    const result: McpWriteResult = McpWriteResultSchema.parse(input);
    const repository = await this.deps.locator.locate(cwd);
    const initial = this.requireMcp(await this.deps.drafts.read(repository, reportId));
    return this.withLineageLock(repository, initial, async () => {
      const draft = this.requireMcp(await this.deps.drafts.read(repository, reportId));
      if (draft.status !== 'PUBLISHING') {
        throw new Git2JiraError(
          `Report ${reportId} is ${draft.status}; no publication is in flight.`,
        );
      }
      const key = this.lineageKey(repository, draft);

      if (result.outcome === 'not-called') {
        await this.deps.lifecycle.resolvePending(key, reportId, {
          published: false,
          retryable: true,
        });
        return this.settleMcp(repository, draft, 'FAILED', `not sent: ${result.reason}`, true);
      }
      if (result.outcome === 'tool-error') {
        const kind = classifyMcpError(result.error);
        const reason = terminalSafeLine(result.error.message, 1000);
        if (kind.delivery === 'rejected') {
          await this.deps.lifecycle.resolvePending(key, reportId, {
            published: false,
            retryable: kind.retryable,
          });
          return this.settleMcp(
            repository,
            draft,
            'FAILED',
            `${kind.reason}: ${reason}`,
            kind.retryable,
          );
        }
        return this.settleMcp(repository, draft, 'UNCERTAIN', reason);
      }

      const comment = parseCreatedComment(result.toolResult);
      if (!comment) {
        return this.settleMcp(
          repository,
          draft,
          'UNCERTAIN',
          'the tool result does not contain a readable comment; list the comments and reconcile',
        );
      }
      if (singleMarker(comment.text)?.reportId !== reportId) {
        return this.settleMcp(
          repository,
          draft,
          'UNCERTAIN',
          `comment ${comment.id} returned by the tool does not carry this report's marker; list the comments and reconcile`,
        );
      }
      return this.finalizeMcp(repository, draft, comment, 'PUBLISHED', []);
    });
  }

  /**
   * Looks for the report in a comment listing the Skill fetched through MCP. Found →
   * recorded (and the checkpoint promoted). Not found in a complete listing after the
   * settle window → FAILED (retryable). Otherwise it stays UNCERTAIN; nothing is re-sent.
   */
  async reconcileMcp(cwd: string, reportId: string, input: unknown): Promise<McpResultOutcome> {
    const parsed = McpReconcileInputSchema.parse(input);
    const repository = await this.deps.locator.locate(cwd);
    const initial = this.requireMcp(await this.deps.drafts.read(repository, reportId));
    return this.withLineageLock(repository, initial, async () => {
      const draft = this.requireMcp(await this.deps.drafts.read(repository, reportId));
      if (!['PUBLISHING', 'UNCERTAIN', 'FAILED'].includes(draft.status)) {
        throw new Git2JiraError(
          `Report ${reportId} is ${draft.status}; there is nothing to reconcile.`,
        );
      }
      const found = this.findInListing(draft, parsed);
      if (found.kind === 'found') {
        return this.finalizeMcp(repository, draft, found.comment, 'RECOVERED', found.duplicates);
      }
      if (draft.status === 'FAILED') {
        return {
          state: 'FAILED',
          draft,
          retryable: draft.failure?.retryable ?? true,
          reason: draft.failure?.reason ?? '',
        };
      }
      if (found.kind === 'incomplete') {
        return this.settleMcp(repository, draft, 'UNCERTAIN', found.reason);
      }
      const since = draft.attempts.at(-1)?.startedAt ?? draft.updatedAt;
      const age = this.now().getTime() - Date.parse(since);
      if (age < this.settleWindowMs) {
        const wait = this.settleWindowMs - age;
        return this.settleMcp(
          repository,
          draft,
          'UNCERTAIN',
          `not visible yet; Jira may still be processing the request. Check again in ${String(Math.ceil(wait / 1000))} s`,
          true,
          wait,
        );
      }
      await this.deps.lifecycle.resolvePending(this.lineageKey(repository, draft), reportId, {
        published: false,
        retryable: true,
      });
      return this.settleMcp(
        repository,
        draft,
        'FAILED',
        'not found in a complete comment listing',
        true,
      );
    });
  }

  /**
   * Moves an MCP draft that is definitely not in Jira to manual mode, keeping its
   * snapshot and text. Never for a draft whose publication outcome is unknown.
   */
  async fallbackToManual(cwd: string, reportId: string): Promise<ManualDraft> {
    const repository = await this.deps.locator.locate(cwd);
    const initial = this.requireMcp(await this.deps.drafts.read(repository, reportId));
    return this.withLineageLock(repository, initial, async () => {
      const draft = this.requireMcp(await this.deps.drafts.read(repository, reportId));
      if (!['DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'FAILED'].includes(draft.status)) {
        throw new Git2JiraError(
          draft.status === 'PUBLISHING' || draft.status === 'UNCERTAIN'
            ? `Report ${reportId} is ${draft.status}: it may already be in Jira. Reconcile it before switching to manual mode.`
            : `Report ${reportId} is ${draft.status} and cannot switch to manual mode.`,
        );
      }
      const {
        mode: _mode,
        status: _status,
        server: _server,
        cloudId: _cloudId,
        issue: _issue,
        approval: _approval,
        attempts: _attempts,
        failure: _failure,
        publication: _publication,
        duplicateCommentIds: _duplicates,
        ...core
      } = draft;
      const status = core.rendered ? 'READY_TO_COPY' : 'DRAFT';
      const at = this.now().toISOString();
      const manual: ManualDraft = {
        ...core,
        mode: 'manual',
        status,
        exports: [],
        events: [...core.events, { at, status, note: 'switched from MCP to manual mode' }],
        updatedAt: at,
      };
      await this.deps.drafts.write(repository, manual);
      return manual;
    });
  }

  // ---------------------------------------------------------------------------

  private findInListing(
    draft: McpDraft,
    input: { comments: unknown; account?: unknown },
  ):
    | { kind: 'found'; comment: ParsedComment; duplicates: string[] }
    | { kind: 'absent' }
    | { kind: 'incomplete'; reason: string } {
    const listing: CommentListing = parseCommentListing(input.comments);
    const accountId = input.account === undefined ? undefined : parseAccountId(input.account);
    if (input.account !== undefined && accountId === undefined) {
      return { kind: 'incomplete', reason: 'the account information could not be read' };
    }
    // Only the signed-in account's comments count when it is known: anyone can paste a marker.
    const matches = listing.comments
      .filter((c) => singleMarker(c.text)?.reportId === draft.reportId)
      .filter((c) => accountId === undefined || c.authorAccountId === accountId)
      .sort(
        (a, b) => (a.created ?? '').localeCompare(b.created ?? '') || Number(a.id) - Number(b.id),
      );
    const [first, ...rest] = matches;
    if (first) return { kind: 'found', comment: first, duplicates: rest.map((c) => c.id) };
    if (!listing.complete) {
      return {
        kind: 'incomplete',
        reason:
          listing.unreadable > 0
            ? `${String(listing.unreadable)} comment(s) could not be read`
            : 'the listing does not show that it covers every comment (no total, or more pages)',
      };
    }
    return { kind: 'absent' };
  }

  private async finalizeMcp(
    repository: RepositoryInfo,
    draft: McpDraft,
    comment: ParsedComment,
    state: 'PUBLISHED' | 'RECOVERED',
    duplicates: string[],
  ): Promise<McpResultOutcome> {
    const publishedAt = isoTime(comment.created, this.now());
    let warning: string | undefined;
    try {
      await this.deps.lifecycle.confirmPublication(
        this.lineageKey(repository, draft),
        draft.reportId,
        {
          commentId: comment.id,
          publishedAt,
          confirmedBy: 'mcp-tool',
        },
      );
    } catch (error) {
      warning = `The comment exists, but the local checkpoint was not saved (${messageOf(error)}). Run "git2jira report recover".`;
    }
    const url = commentUrl(draft.site, draft.issueKey, comment.id);
    const attempts =
      draft.attempts.length > 0 ? draft.attempts : [{ startedAt: this.now().toISOString() }];
    const last = attempts.at(-1) ?? { startedAt: this.now().toISOString() };
    const { failure: _failure, ...rest } = draft;
    const settled = await this.deps.drafts.transition(
      repository,
      draft,
      {
        ...rest,
        status: state,
        attempts: [
          ...attempts.slice(0, -1),
          {
            ...last,
            finishedAt: this.now().toISOString(),
            result: state === 'PUBLISHED' ? 'published' : 'recovered',
          },
        ],
        publication: {
          commentId: comment.id,
          commentUrl: url,
          publishedAt,
          evidence: state === 'PUBLISHED' ? 'tool-result' : 'read-back',
        },
        ...(duplicates.length > 0 ? { duplicateCommentIds: duplicates } : {}),
      },
      this.now(),
    );
    return {
      state,
      draft: settled,
      commentId: comment.id,
      commentUrl: url,
      ...(warning ? { warning } : {}),
    };
  }

  private async settleMcp(
    repository: RepositoryInfo,
    draft: McpDraft,
    status: 'FAILED' | 'UNCERTAIN',
    reason: string,
    retryable = true,
    retryAfterMs = this.settleWindowMs,
  ): Promise<McpResultOutcome> {
    const safe = terminalSafeLine(reason, 1000);
    const attempts = [...draft.attempts];
    const last = attempts.pop();
    if (last) {
      attempts.push({
        ...last,
        finishedAt: this.now().toISOString(),
        result: status === 'FAILED' ? 'failed' : 'uncertain',
        error: safe,
      });
    }
    const { failure: _failure, ...rest } = draft;
    const next = await this.deps.drafts.transition(
      repository,
      draft,
      {
        ...rest,
        status,
        attempts,
        ...(status === 'FAILED' ? { failure: { retryable, reason: safe } } : {}),
      },
      this.now(),
      safe,
    );
    return status === 'FAILED'
      ? { state: 'FAILED', draft: next, retryable, reason: safe }
      : { state: 'UNCERTAIN', draft: next, reason: safe, retryAfterMs };
  }

  private async requireRecovery(
    repository: RepositoryInfo,
    draft: ManualDraft,
    reason: string,
  ): Promise<ManualConfirmOutcome> {
    const current = await this.deps.drafts.read(repository, draft.reportId);
    const safe = terminalSafeLine(reason, 1000);
    const next = await this.deps.drafts.transition(
      repository,
      current,
      {
        ...draft,
        status: 'RECOVERY_REQUIRED',
        resumeStatus: draft.status === 'RECOVERY_REQUIRED' ? draft.resumeStatus : draft.status,
        recovery: { reason: safe },
        events: current.events,
      },
      this.now(),
      safe,
    );
    return { state: 'RECOVERY_REQUIRED', draft: this.requireManual(next), reason: safe };
  }

  /** Why a draft can no longer become the next checkpoint, if it cannot. */
  private async problemWith(repository: RepositoryInfo, draft: Draft): Promise<string | undefined> {
    try {
      await this.verifySnapshot(repository, draft);
    } catch (error) {
      return messageOf(error);
    }
    const journal = await this.deps.store
      .read(repository, draft.site.id, draft.issueKey)
      .catch(() => undefined);
    const latest = latestCheckpoint(journal);
    const expected = draft.baseline.kind === 'checkpoint' ? draft.baseline.reportId : undefined;
    if (latest?.reportId !== expected) {
      return 'the last confirmed report changed after this one was prepared';
    }
    return undefined;
  }

  private async verifySnapshot(repository: RepositoryInfo, draft: Draft): Promise<void> {
    const identity = await this.deps.store.repositoryIdentity(repository);
    if (identity.id !== draft.repositoryId) {
      throw new PublicationMismatchError('the report was prepared in a different repository');
    }
    const commit = await this.deps.refs.resolve(repository, draft.snapshotRef);
    if (commit !== draft.snapshot.commit) {
      throw new PublicationMismatchError(
        'the snapshot this report describes is no longer recorded',
      );
    }
    if ((await this.deps.refs.treeOf(repository, commit)) !== draft.snapshot.tree) {
      throw new PublicationMismatchError('the snapshot commit does not match the previewed tree');
    }
  }

  private async verifyChanges(repository: RepositoryInfo, draft: Draft): Promise<void> {
    const changeSet = await this.deps.diff.diff(
      repository,
      {
        baseTree: draft.baseline.tree,
        targetTree: draft.snapshot.tree,
        fromCommit: null,
        toCommit: null,
      },
      { maxPatchBytes: 1, maxCommits: 0 },
    );
    if (
      changesDigest(draft.files) !== draft.changesDigest ||
      changesDigest(changeSet.files.map(toReportFile)) !== draft.changesDigest
    ) {
      throw new PublicationMismatchError('the changed files differ from the previewed report');
    }
  }

  private requireManual(draft: Draft): ManualDraft {
    if (draft.mode !== 'manual') {
      throw new UsageError(
        `Report ${draft.reportId} is an MCP report; this command is for manual reports.`,
      );
    }
    return draft;
  }

  private requireMcp(draft: Draft): McpDraft {
    if (draft.mode !== 'mcp') {
      throw new UsageError(
        `Report ${draft.reportId} is a manual report; this command is for MCP reports.`,
      );
    }
    return draft;
  }

  private lineageKey(repository: RepositoryInfo, draft: Draft): LineageKey {
    return { repository, site: draft.site, issueKey: draft.issueKey };
  }

  private candidate(repository: RepositoryInfo, draft: Draft): PublicationCandidate {
    return {
      reportId: draft.reportId,
      site: draft.site,
      snapshotRef: draft.snapshotRef,
      snapshot: draft.snapshot,
      baseline: draft.baseline,
      context: { repository, issueKey: draft.issueKey, branch: draft.branch },
    };
  }

  /** Same lock as the API-token publisher, so no two modes publish on one lineage at once. */
  private withLineageLock<T>(
    repository: RepositoryInfo,
    draft: Draft,
    fn: () => Promise<T>,
  ): Promise<T> {
    const file = path.join(
      stateDir(repository),
      'locks',
      `publish-${draft.site.id}-${draft.issueKey}.lock`,
    );
    return withFileLock(file, fn, { timeoutMs: 60_000, ...this.deps.lockOptions });
  }
}

/** Approval and attestation digest: binds the exact texts to the exact issue and snapshot. */
export function draftDigest(
  draft: Pick<Draft, 'site' | 'issueKey' | 'reportId' | 'sequence' | 'baseline' | 'snapshot'>,
  rendered: { markdown: string; text: string; adf: unknown },
): string {
  return sha256(
    canonicalJson({
      v: 1,
      kind: 'draft',
      siteId: draft.site.id,
      issueKey: draft.issueKey,
      reportId: draft.reportId,
      sequence: draft.sequence,
      baseTree: draft.baseline.tree,
      targetTree: draft.snapshot.tree,
      snapshotCommit: draft.snapshot.commit,
      markdown: rendered.markdown,
      text: rendered.text,
      adf: rendered.adf,
    }),
  );
}

/** Candidate refs of open drafts; recovery must not remove them. */
export async function openDraftRefs(
  drafts: DraftStore,
  repository: RepositoryInfo,
): Promise<string[]> {
  return (await drafts.list(repository)).filter(isOpen).map((d) => d.snapshotRef);
}

function withoutRecovery(draft: ManualDraft): ManualDraft {
  const { recovery: _recovery, resumeStatus: _resume, ...rest } = draft;
  return rest;
}

function toReportFile(file: FileChange): ReportFile {
  return {
    status: file.status,
    path: file.path,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isoTime(value: string | undefined, fallback: Date): string {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? fallback.toISOString() : new Date(parsed).toISOString();
}
