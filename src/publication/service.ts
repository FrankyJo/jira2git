import path from 'node:path';
import { findReportMarkers } from '../adf/footer';
import { adfToPlainText } from '../adf/text';
import type { AdfDocument, AdfRenderer, ReportFile } from '../adf/types';
import { validateAdfDocument } from '../adf/validate';
import { withFileLock, type LockOptions } from '../checkpoints/lock';
import type { GitRefs } from '../checkpoints/refs';
import type { LineageStore } from '../checkpoints/store';
import {
  isCheckpoint,
  type Checkpoint,
  type JiraSite,
  type ReportRecord,
} from '../checkpoints/types';
import { Git2JiraError } from '../core/errors';
import { terminalSafeLine } from '../core/sanitize';
import { VERSION } from '../core/version';
import type { GitRepositoryLocator, IssueKey, RepositoryInfo } from '../git/types';
import { JiraClientError, JiraNotFoundError, JiraRequestError } from '../jira/client/errors';
import type { JiraClient, JiraComment } from '../jira/client/types';
import type { ConnectionCriteria, JiraConnectionManager, JiraSession } from '../jira/connections';
import type { LabelCatalog } from '../localization/catalog';
import type { StoredReport, StructuredReport } from '../report/schema';
import { finalizeReport, parseReportInput } from '../report/validate';
import {
  buildAnalysisPackage,
  reportDiffOptions,
  reportFacts,
  snapshotChangeSet,
  type AnalysisPackage,
  type TestEvidence,
} from '../ai/analysis';
import { stateDir } from '../snapshots/engine';
import type { FileChange, IncrementalDiffEngine } from '../snapshots/types';
import { changesDigest, reportDigest } from './digest';
import {
  ApprovalMismatchError,
  IssueNotFoundError,
  NotApprovedError,
  PublicationInProgressError,
  PublicationMismatchError,
} from './errors';
import type {
  IssueIdentity,
  LineageKey,
  PublicationCandidate,
  PublicationLifecycle,
} from './lifecycle';
import { REPORT_PROPERTY_KEY, ReportMetadataSchema, type ReportMetadata } from './metadata';
import { TERMINAL_STATUSES, type PlanStore, type StoredPlan } from './plan';
import { scanRemoteReports, type RemoteReport, type RemoteScan } from './remote-history';
import type {
  HistoryView,
  PrepareOutcome,
  PrepareRequest,
  PublicationOutcome,
  RecoveryAction,
  RecoverySummary,
  ReviewResult,
  TargetSelection,
} from './types';

/** What a review may cite besides Git: test results and the (untrusted) issue text. */
export interface ReviewContext {
  tests?: readonly TestEvidence[] | undefined;
  issue?: { title?: string | undefined; description?: string | undefined } | undefined;
  userContext?: string | undefined;
}

export interface PublicationServiceDependencies {
  lifecycle: PublicationLifecycle;
  plans: PlanStore;
  connections: JiraConnectionManager;
  locator: GitRepositoryLocator;
  diff: IncrementalDiffEngine;
  refs: GitRefs;
  store: LineageStore;
  renderer: AdfRenderer;
  labels: LabelCatalog;
  now?: () => Date;
  toolVersion?: string;
  /**
   * A comment request that timed out may still be processed by Jira afterwards.
   * "Not in Jira" is only trusted once the attempt is at least this old.
   */
  settleWindowMs?: number;
  lockOptions?: LockOptions;
}

/**
 * When "not found in Jira" may be taken as "not published":
 * - `conclusive`: the last attempt failed definitely, so absence is expected.
 * - `never`: right after an ambiguous request, which Jira may still be processing.
 * - `{ since }`: only once the attempt is older than the settle window.
 */
type AbsencePolicy = 'conclusive' | 'never' | { since: string };

interface Finalized {
  plan: StoredPlan | undefined;
  commentId: string;
  commentUrl: string;
  checkpoint: Checkpoint | undefined;
  propertyStored: boolean;
  duplicateCommentIds: string[];
  warning?: string;
}

type Reconciliation =
  | { kind: 'found'; comment: RemoteReport; duplicates: string[] }
  | { kind: 'absent' }
  | { kind: 'unknown'; reason: string; retryAfterMs: number };

/**
 * Publishes approved reports as new Jira comments, at most once per report id
 * as far as Jira's API allows. Jira offers no idempotency key for comment
 * creation, so exactly-once delivery is not guaranteed: instead, a POST is
 * never repeated while its outcome is unknown, and unknown outcomes are
 * reconciled by looking for the report id in the issue's comments.
 */
export class JiraPublicationService {
  private readonly now: () => Date;
  private readonly toolVersion: string;
  private readonly settleWindowMs: number;

  constructor(private readonly deps: PublicationServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.toolVersion = deps.toolVersion ?? VERSION;
    this.settleWindowMs = deps.settleWindowMs ?? 120_000;
  }

  // ---------------------------------------------------------------------------
  // DRAFT → READY_FOR_REVIEW → APPROVED

  /** Verifies the issue in Jira, captures the snapshot, and creates a DRAFT plan. */
  async prepare(request: PrepareRequest): Promise<PrepareOutcome> {
    const { lifecycle, connections } = this.deps;
    const identity = await lifecycle.identify(request);
    const selected = await connections.select(criteria(request, identity));
    const session = connections.session(selected.connection);
    const issue = await this.verifyIssue(session, identity.issueKey);

    const result = await lifecycle.prepare({
      ...request,
      site: selected.connection.site,
      diffOptions: request.diffOptions ?? reportDiffOptions(),
    });
    if (result.status === 'no-changes') return { status: 'no-changes', analysis: result.analysis };
    const prepared = result.report;
    try {
      const repository = prepared.context.repository;
      const files = prepared.changeSet.files.map(toReportFile);
      const timestamp = this.now().toISOString();
      const plan: StoredPlan = {
        schemaVersion: 1,
        reportId: prepared.reportId,
        status: 'DRAFT',
        connection: selected.connection.name,
        site: prepared.site,
        issueKey: prepared.context.issueKey,
        issue: { id: issue.id, summary: issue.summary.slice(0, 2000) },
        repositoryId: (await this.deps.store.repositoryIdentity(repository)).id,
        branch: prepared.context.branch,
        baseline: prepared.baseline,
        snapshot: prepared.snapshot,
        snapshotRef: prepared.snapshotRef,
        sequence: prepared.nextSequence,
        language: request.language,
        files,
        changesDigest: changesDigest(files),
        attempts: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.deps.plans.write(repository, plan);
      return {
        status: 'prepared',
        plan,
        issue,
        changeSet: prepared.changeSet,
        connectionReason: selected.reason,
      };
    } catch (error) {
      await lifecycle.cancel(prepared).catch(() => undefined);
      throw error;
    }
  }

  /** Validates a structured report, renders and validates the ADF comment, and computes its digest. */
  async review(
    cwd: string,
    reportId: string,
    input: unknown,
    context: ReviewContext = {},
  ): Promise<ReviewResult> {
    const repository = await this.deps.locator.locate(cwd);
    const plan = await this.deps.plans.read(repository, reportId);
    if (!['DRAFT', 'READY_FOR_REVIEW', 'APPROVED'].includes(plan.status)) {
      throw new Git2JiraError(
        `Report ${reportId} is ${plan.status}; its content can no longer change.`,
      );
    }
    const { content, legacy } = parseReportInput(input);
    const pkg = await this.analysis(cwd, reportId, context);
    const report = finalizeReport(content, reportFacts(pkg, plan.files), { legacy });
    const document = validateAdfDocument(this.render(plan, report));
    const digest = this.digestOf(plan, document);
    const { approval: _cleared, ...rest } = plan;
    const next = await this.deps.plans.transition(
      repository,
      plan,
      { ...rest, status: 'READY_FOR_REVIEW', report, document, reportDigest: digest },
      this.now(),
    );
    return { plan: next, document, reportDigest: digest };
  }

  /**
   * The analysis package of a plan, rebuilt from its two trees (never the working tree).
   * Issue details come from Jira at preparation and are passed back in by the caller.
   */
  async analysis(
    cwd: string,
    reportId: string,
    context: ReviewContext = {},
  ): Promise<AnalysisPackage> {
    const repository = await this.deps.locator.locate(cwd);
    const plan = await this.deps.plans.read(repository, reportId);
    const changeSet = await snapshotChangeSet(
      this.deps.diff,
      repository,
      plan.baseline,
      plan.snapshot,
    );
    return buildAnalysisPackage({
      reportId: plan.reportId,
      issueKey: plan.issueKey,
      language: plan.language,
      deliveryMode: 'api-token',
      repositoryId: plan.repositoryId,
      repositoryRoot: repository.root,
      branch: plan.branch.name,
      sequence: plan.sequence,
      baseline: plan.baseline,
      snapshot: plan.snapshot,
      changeSet,
      tests: context.tests,
      issue: context.issue ?? { title: plan.issue.summary },
      userContext: context.userContext,
    });
  }

  /** Records explicit user approval of exactly one previewed digest. */
  async approve(cwd: string, reportId: string, digest: string): Promise<StoredPlan> {
    const repository = await this.deps.locator.locate(cwd);
    const plan = await this.deps.plans.read(repository, reportId);
    if (plan.status === 'APPROVED' && plan.approval?.reportDigest === digest) return plan;
    if (plan.status !== 'READY_FOR_REVIEW') throw new NotApprovedError(reportId, plan.status);
    if (!plan.reportDigest || plan.reportDigest !== digest) throw new ApprovalMismatchError();
    return this.deps.plans.transition(
      repository,
      plan,
      {
        ...plan,
        status: 'APPROVED',
        approval: { reportDigest: digest, approvedAt: this.now().toISOString() },
      },
      this.now(),
    );
  }

  /** Abandons a report that is not in flight. The baseline does not move. */
  async cancel(cwd: string, reportId: string): Promise<void> {
    const repository = await this.deps.locator.locate(cwd);
    const plan = await this.deps.plans.read(repository, reportId);
    if (!['DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'FAILED'].includes(plan.status)) {
      throw new PublicationInProgressError(reportId, plan.status);
    }
    await this.deps.lifecycle.cancel({
      reportId,
      site: plan.site,
      snapshotRef: plan.snapshotRef,
      context: { repository, issueKey: plan.issueKey, branch: plan.branch },
    });
    await this.deps.plans.delete(repository, reportId);
  }

  async getPlan(cwd: string, reportId: string): Promise<StoredPlan> {
    return this.deps.plans.read(await this.deps.locator.locate(cwd), reportId);
  }

  // ---------------------------------------------------------------------------
  // APPROVED → PUBLISHING → PUBLISHED | FAILED | UNCERTAIN

  /**
   * Publishes an approved report. Before anything is sent: site, issue,
   * snapshot, change list, lock, existing records, and approval are checked.
   * The comment request is sent once; an unknown outcome is reconciled, never
   * retried blindly.
   */
  async publish(
    cwd: string,
    reportId: string,
    digest: string,
    signal?: AbortSignal,
  ): Promise<PublicationOutcome> {
    const repository = await this.deps.locator.locate(cwd);
    const initial = await this.deps.plans.read(repository, reportId);
    return this.withPublicationLock(repository, initial.site, initial.issueKey, async () => {
      let plan = await this.deps.plans.read(repository, reportId);
      if (TERMINAL_STATUSES.includes(plan.status) && plan.publication) {
        // Already done: report it, never post again.
        return this.alreadyPublished(plan);
      }
      if (plan.status === 'PUBLISHING' || plan.status === 'UNCERTAIN') {
        throw new PublicationInProgressError(reportId, plan.status);
      }
      if (plan.status === 'FAILED' && plan.failure?.retryable === false) {
        throw new Git2JiraError(
          `Report ${reportId} failed permanently (${plan.failure.reason}). Prepare a new report.`,
        );
      }
      if (plan.status !== 'APPROVED' && plan.status !== 'FAILED') {
        throw new NotApprovedError(reportId, plan.status);
      }
      const { report, document } = this.verifyApproval(plan, digest);

      // 1. Jira site: the connection still points at the site the report was prepared for.
      const connection = await this.deps.connections.get(plan.connection);
      if (connection.site.id !== plan.site.id) {
        throw new PublicationMismatchError(
          `connection "${plan.connection}" now points to ${connection.site.url}, not ${plan.site.url}`,
        );
      }
      const session = this.deps.connections.session(connection);
      // 2. Issue key: same key, same issue (this also verifies authentication).
      if (report.issueKey !== plan.issueKey) {
        throw new PublicationMismatchError('the report targets a different issue');
      }
      const issue = await this.verifyIssue(session, plan.issueKey, signal);
      if (issue.id !== plan.issue.id) {
        throw new PublicationMismatchError(
          `${plan.issueKey} is no longer the issue that was previewed`,
        );
      }
      // 3. Snapshot identity and repository.
      await this.verifySnapshot(repository, plan);
      // 4. The change list still matches what was previewed.
      await this.verifyChanges(repository, plan);
      // 5. (lock held) 6. Existing publication records: local journal, and Jira on a retry.
      const key: LineageKey = { repository, site: plan.site, issueKey: plan.issueKey };
      const existing = (
        await this.deps.store.read(repository, plan.site.id, plan.issueKey)
      )?.records.find((r) => r.reportId === reportId);
      if (existing && existing.state !== 'failed') {
        throw new PublicationInProgressError(reportId, `recorded as ${existing.state}`);
      }
      if (plan.attempts.length > 0 || existing) {
        const found = await this.reconcile(session, plan.issueKey, reportId, 'conclusive', signal);
        if (found.kind === 'found') {
          return published(
            'RECOVERED',
            await this.finalize(
              repository,
              key,
              plan,
              session,
              found.comment,
              'RECOVERED',
              found.duplicates,
            ),
          );
        }
        if (found.kind === 'unknown') {
          throw new Git2JiraError(
            `Could not confirm that report ${reportId} is not already in Jira (${found.reason}). ` +
              'Nothing was sent; try again later.',
          );
        }
      }
      // 7. Explicit approval, re-read under the lock.
      this.verifyApproval(plan, digest);

      await this.deps.lifecycle.beginPublication(this.candidate(repository, plan), digest);
      plan = await this.deps.plans.transition(
        repository,
        plan,
        {
          ...withoutFailure(plan),
          status: 'PUBLISHING',
          attempts: [...plan.attempts, { startedAt: this.now().toISOString() }],
        },
        this.now(),
      );

      let comment: JiraComment;
      try {
        comment = await session.client.addComment(
          plan.issueKey,
          document,
          [{ key: REPORT_PROPERTY_KEY, value: this.metadata(plan) }],
          signal,
        );
      } catch (error) {
        return this.afterSendFailure(repository, key, plan, session, toError(error), signal);
      }

      // Verify the returned id belongs to this report before recording it.
      if (!(await this.commentCarriesReport(session.client, plan, comment, signal))) {
        const error = new Git2JiraError(
          `Jira returned comment ${comment.id}, but it does not carry report ${reportId}.`,
        );
        return this.markUncertain(repository, plan, error);
      }
      return published(
        'PUBLISHED',
        await this.finalize(repository, key, plan, session, comment, 'PUBLISHED', []),
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Recovery and history

  /**
   * Repairs local state and settles interrupted publications: rebuilds the
   * journal from checkpoint refs, promotes confirmed reports, looks up
   * unsettled reports in Jira, restores missing comment properties, and syncs
   * plan states. Never sends a comment.
   */
  async recover(selection: TargetSelection, signal?: AbortSignal): Promise<RecoverySummary> {
    const identity = await this.deps.lifecycle.identify(selection);
    const { repository, issueKey } = identity;
    const selected = await this.deps.connections.select(criteria(selection, identity));
    const site = selected.connection.site;
    const key: LineageKey = { repository, site, issueKey };

    return this.withPublicationLock(repository, site, issueKey, async () => {
      const actions: RecoveryAction[] = [];
      const local = await this.deps.lifecycle.recover(key);
      if (local.rebuiltFromRefs) actions.push({ kind: 'rebuilt-journal' });
      if (local.quarantinedJournal)
        actions.push({ kind: 'quarantined', file: local.quarantinedJournal });
      for (const reportId of new Set(local.promoted)) actions.push({ kind: 'promoted', reportId });
      for (const ref of local.removedCandidates) actions.push({ kind: 'removed-candidate', ref });
      for (const ref of local.unreadableRefs) actions.push({ kind: 'unreadable-ref', ref });

      const session = this.deps.connections.session(selected.connection);
      let scan: RemoteScan | undefined;
      let accountId: string | undefined;
      let remoteError: string | undefined;
      try {
        accountId = (await session.client.getCurrentUser(signal)).accountId;
        scan = await scanRemoteReports(session.client, issueKey, signal ? { signal } : {});
        if (scan.error) remoteError = scan.error.message;
        else if (!scan.complete) remoteError = 'not all comments could be read';
      } catch (error) {
        remoteError = toError(error).message;
      }

      for (const record of local.unresolved) {
        const plan = await this.deps.plans.readOptional(repository, record.reportId);
        const outcome = this.classify(
          scan,
          accountId,
          record.reportId,
          { since: record.updatedAt },
          remoteError,
        );
        if (outcome.kind === 'found') {
          const result = await this.finalize(
            repository,
            key,
            plan,
            session,
            outcome.comment,
            'RECOVERED',
            outcome.duplicates,
            record,
          );
          actions.push({
            kind: 'recovered',
            reportId: record.reportId,
            sequence: record.sequence,
            commentId: result.commentId,
            commentUrl: result.commentUrl,
          });
        } else if (outcome.kind === 'absent') {
          await this.deps.lifecycle.resolvePending(key, record.reportId, {
            published: false,
            retryable: true,
          });
          if (plan)
            await this.settlePlan(
              repository,
              plan,
              'FAILED',
              'Jira has no comment for this report; it can be published again.',
            );
          actions.push({
            kind: 'not-published',
            reportId: record.reportId,
            sequence: record.sequence,
          });
        } else {
          if (plan && plan.status !== 'UNCERTAIN')
            await this.settlePlan(repository, plan, 'UNCERTAIN', outcome.reason);
          actions.push({
            kind: 'still-uncertain',
            reportId: record.reportId,
            sequence: record.sequence,
            reason: outcome.reason,
          });
        }
      }

      const journal = await this.deps.store.read(repository, site.id, issueKey);
      const records = journal?.records ?? [];
      await this.syncPlans(repository, site, issueKey, records, actions);
      if (scan)
        await this.repairRemote(
          session.client,
          repository,
          records,
          scan,
          accountId,
          actions,
          signal,
        );

      return { site, issueKey, actions, ...(remoteError ? { remoteError } : {}) };
    });
  }

  /** Local report history for the selected site, optionally cross-checked against Jira. */
  async history(
    selection: TargetSelection,
    options: { remote: boolean; signal?: AbortSignal },
  ): Promise<HistoryView> {
    const identity = await this.deps.lifecycle.identify(selection);
    const { repository, issueKey } = identity;
    const selected = await this.deps.connections.select(criteria(selection, identity));
    const site = selected.connection.site;
    const journal = await this.deps.store.read(repository, site.id, issueKey);
    const plans = (await this.deps.plans.list(repository)).filter(
      (p) => p.site.id === site.id && p.issueKey === issueKey,
    );

    let remote: HistoryView['remote'];
    if (options.remote) {
      const session = this.deps.connections.session(selected.connection);
      const scan = await scanRemoteReports(
        session.client,
        issueKey,
        options.signal ? { signal: options.signal } : {},
      );
      remote = {
        complete: scan.complete,
        reports: scan.reports,
        ...(scan.error ? { error: scan.error.message } : {}),
      };
    }
    const seen = new Set(remote?.reports.map((r) => r.commentId));
    const records = [...(journal?.records ?? [])].sort((a, b) => a.sequence - b.sequence);
    return {
      site,
      issueKey,
      entries: records.map((record) => {
        const commentId = record.publication?.commentId;
        return {
          record,
          plan: plans.find((p) => p.reportId === record.reportId),
          commentUrl: commentId ? commentUrl(site, issueKey, commentId) : undefined,
          inJira: remote && commentId && remote.complete ? seen.has(commentId) : undefined,
        };
      }),
      openPlans: plans.filter((p) => !records.some((r) => r.reportId === p.reportId)),
      ...(remote ? { remote } : {}),
    };
  }

  // ---------------------------------------------------------------------------

  private async verifyIssue(session: JiraSession, issueKey: IssueKey, signal?: AbortSignal) {
    try {
      return await session.client.getIssue(issueKey, signal);
    } catch (error) {
      if (error instanceof JiraNotFoundError)
        throw new IssueNotFoundError(issueKey, session.connection.site.url);
      throw error;
    }
  }

  private verifyApproval(
    plan: StoredPlan,
    digest: string,
  ): { report: StoredReport; document: AdfDocument } {
    if (!plan.report || !plan.document || !plan.reportDigest || !plan.approval) {
      throw new NotApprovedError(plan.reportId, plan.status);
    }
    const recomputed = this.digestOf(plan, plan.document);
    if (
      digest !== plan.approval.reportDigest ||
      digest !== plan.reportDigest ||
      digest !== recomputed
    ) {
      throw new ApprovalMismatchError();
    }
    return { report: plan.report, document: validateAdfDocument(plan.document) };
  }

  private async verifySnapshot(repository: RepositoryInfo, plan: StoredPlan): Promise<void> {
    const identity = await this.deps.store.repositoryIdentity(repository);
    if (identity.id !== plan.repositoryId) {
      throw new PublicationMismatchError('the report was prepared in a different repository');
    }
    const commit = await this.deps.refs.resolve(repository, plan.snapshotRef);
    if (commit !== plan.snapshot.commit) {
      throw new PublicationMismatchError(
        'the snapshot this report describes is no longer recorded',
      );
    }
    if ((await this.deps.refs.treeOf(repository, commit)) !== plan.snapshot.tree) {
      throw new PublicationMismatchError('the snapshot commit does not match the previewed tree');
    }
  }

  private async verifyChanges(repository: RepositoryInfo, plan: StoredPlan): Promise<void> {
    const changeSet = await this.deps.diff.diff(
      repository,
      {
        baseTree: plan.baseline.tree,
        targetTree: plan.snapshot.tree,
        fromCommit: null,
        toCommit: null,
      },
      { maxPatchBytes: 1, maxCommits: 0 },
    );
    // Both the list that was previewed and rendered, and Git's own list, must match.
    if (
      changesDigest(plan.files) !== plan.changesDigest ||
      changesDigest(changeSet.files.map(toReportFile)) !== plan.changesDigest
    ) {
      throw new PublicationMismatchError('the changed files differ from the approved preview');
    }
  }

  private async afterSendFailure(
    repository: RepositoryInfo,
    key: LineageKey,
    plan: StoredPlan,
    session: JiraSession,
    error: Error,
    signal?: AbortSignal,
  ): Promise<PublicationOutcome> {
    const delivery = error instanceof JiraRequestError ? error.delivery : 'unknown';
    if (delivery === 'not-sent' || delivery === 'rejected') {
      // Jira did not create the comment. A malformed request will not succeed later.
      const retryable = !(
        error instanceof JiraClientError && [400, 413].includes(error.status ?? 0)
      );
      await this.deps.lifecycle.resolvePending(key, plan.reportId, { published: false, retryable });
      const failed = await this.settlePlan(repository, plan, 'FAILED', error.message, retryable);
      return { state: 'FAILED', plan: failed, error, retryable };
    }

    // Outcome unknown: record that first, then look for the comment once.
    const uncertain = await this.markUncertain(repository, plan, error);
    if (uncertain.state !== 'UNCERTAIN') return uncertain;
    const found = await this.reconcile(session, plan.issueKey, plan.reportId, 'never', signal);
    if (found.kind === 'found') {
      return published(
        'RECOVERED',
        await this.finalize(
          repository,
          key,
          uncertain.plan,
          session,
          found.comment,
          'RECOVERED',
          found.duplicates,
        ),
      );
    }
    return uncertain;
  }

  private async markUncertain(
    repository: RepositoryInfo,
    plan: StoredPlan,
    error: Error,
  ): Promise<PublicationOutcome> {
    const next = await this.settlePlan(repository, plan, 'UNCERTAIN', error.message);
    return { state: 'UNCERTAIN', plan: next, error, retryAfterMs: this.settleWindowMs };
  }

  /** Looks for a report in Jira. With `recordUpdatedAt`, absence may be concluded. */
  private async reconcile(
    session: JiraSession,
    issueKey: IssueKey,
    reportId: string,
    absence: AbsencePolicy,
    signal?: AbortSignal,
  ): Promise<Reconciliation> {
    try {
      const accountId = (await session.client.getCurrentUser(signal)).accountId;
      const scan = await scanRemoteReports(session.client, issueKey, signal ? { signal } : {});
      return this.classify(scan, accountId, reportId, absence, scan.error?.message);
    } catch (error) {
      return { kind: 'unknown', reason: toError(error).message, retryAfterMs: this.settleWindowMs };
    }
  }

  private classify(
    scan: RemoteScan | undefined,
    accountId: string | undefined,
    reportId: string,
    absence: AbsencePolicy,
    remoteError: string | undefined,
  ): Reconciliation {
    if (!scan || accountId === undefined) {
      return {
        kind: 'unknown',
        reason: remoteError ?? 'Jira is not reachable',
        retryAfterMs: this.settleWindowMs,
      };
    }
    // Only comments written by this account count; anyone can paste a marker into a comment.
    const matches = scan.reports
      .filter((r) => r.reportId === reportId && r.authorAccountId === accountId)
      .sort(
        (a, b) => a.created.localeCompare(b.created) || Number(a.commentId) - Number(b.commentId),
      );
    const [first, ...rest] = matches;
    if (first) return { kind: 'found', comment: first, duplicates: rest.map((r) => r.commentId) };
    if (!scan.complete) {
      return {
        kind: 'unknown',
        reason: remoteError ?? 'not all comments could be read',
        retryAfterMs: this.settleWindowMs,
      };
    }
    if (absence === 'conclusive') return { kind: 'absent' };
    if (absence === 'never') {
      return {
        kind: 'unknown',
        reason: 'the comment is not visible in Jira yet',
        retryAfterMs: this.settleWindowMs,
      };
    }
    const age = this.now().getTime() - Date.parse(absence.since);
    if (age < this.settleWindowMs) {
      const wait = this.settleWindowMs - age;
      return {
        kind: 'unknown',
        reason: `the request may still be processed by Jira; check again in ${String(Math.ceil(wait / 1000))} s`,
        retryAfterMs: wait,
      };
    }
    return { kind: 'absent' };
  }

  /**
   * Records a confirmed comment: journal + checkpoint promotion, the metadata
   * property, and the plan. Used for fresh publications and reconciliations.
   */
  private async finalize(
    repository: RepositoryInfo,
    key: LineageKey,
    plan: StoredPlan | undefined,
    session: JiraSession,
    comment: { commentId: string; created: string } | JiraComment,
    status: 'PUBLISHED' | 'RECOVERED',
    duplicates: string[],
    record?: ReportRecord,
  ): Promise<Finalized> {
    const commentId = 'commentId' in comment ? comment.commentId : comment.id;
    const reportId = plan?.reportId ?? record?.reportId ?? '';
    const publishedAt = isoTime(comment.created, this.now());
    let checkpoint: Checkpoint | undefined;
    let warning: string | undefined;
    try {
      checkpoint = await this.deps.lifecycle.confirmPublication(key, reportId, {
        commentId,
        publishedAt,
      });
    } catch (error) {
      warning = `The comment exists, but the local checkpoint was not saved (${toError(error).message}). Run "git2jira recover".`;
    }
    const metadata = plan
      ? this.metadata(plan)
      : record
        ? this.metadataFromRecord(record)
        : undefined;
    const propertyStored = metadata
      ? await this.ensureProperty(session.client, commentId, metadata)
      : false;
    const url = commentUrl(key.site, key.issueKey, commentId);

    let settled = plan;
    if (plan) {
      const attempts =
        plan.attempts.length > 0 ? plan.attempts : [{ startedAt: this.now().toISOString() }];
      const last = attempts.at(-1) ?? { startedAt: this.now().toISOString() };
      settled = await this.deps.plans.transition(
        repository,
        plan,
        {
          ...withoutFailure(plan),
          status,
          attempts: [
            ...attempts.slice(0, -1),
            {
              ...last,
              finishedAt: this.now().toISOString(),
              result: status === 'PUBLISHED' ? 'published' : 'recovered',
            },
          ],
          publication: { commentId, commentUrl: url, publishedAt, propertyStored },
          ...(duplicates.length > 0 ? { duplicateCommentIds: duplicates } : {}),
        },
        this.now(),
      );
    }
    return {
      plan: settled,
      commentId,
      commentUrl: url,
      checkpoint,
      propertyStored,
      duplicateCommentIds: duplicates,
      ...(warning ? { warning } : {}),
    };
  }

  private alreadyPublished(plan: StoredPlan): PublicationOutcome {
    const publication = plan.publication;
    if (!publication) throw new Error('unreachable');
    return {
      state: plan.status === 'RECOVERED' ? 'RECOVERED' : 'PUBLISHED',
      plan,
      commentId: publication.commentId,
      commentUrl: publication.commentUrl,
      checkpoint: undefined,
      propertyStored: publication.propertyStored,
      duplicateCommentIds: plan.duplicateCommentIds ?? [],
    };
  }

  private async settlePlan(
    repository: RepositoryInfo,
    plan: StoredPlan,
    status: 'FAILED' | 'UNCERTAIN',
    reason: string,
    retryable = true,
  ): Promise<StoredPlan> {
    const safeReason = terminalSafeLine(reason, 1000);
    const attempts = [...plan.attempts];
    const last = attempts.pop();
    if (last) {
      attempts.push({
        ...last,
        finishedAt: this.now().toISOString(),
        result: status === 'FAILED' ? 'failed' : 'uncertain',
        error: safeReason,
      });
    }
    const base = withoutFailure(plan);
    return this.deps.plans.transition(
      repository,
      plan,
      {
        ...base,
        status,
        attempts,
        ...(status === 'FAILED' ? { failure: { retryable, reason: safeReason } } : {}),
      },
      this.now(),
    );
  }

  /** Aligns plan states with the journal after local recovery. */
  private async syncPlans(
    repository: RepositoryInfo,
    site: JiraSite,
    issueKey: IssueKey,
    records: ReportRecord[],
    actions: RecoveryAction[],
  ): Promise<void> {
    const plans = (await this.deps.plans.list(repository)).filter(
      (p) => p.site.id === site.id && p.issueKey === issueKey,
    );
    for (const plan of plans) {
      const record = records.find((r) => r.reportId === plan.reportId);
      const commentId = record?.publication?.commentId;
      if (
        record &&
        isCheckpoint(record) &&
        commentId !== undefined &&
        !TERMINAL_STATUSES.includes(plan.status)
      ) {
        await this.deps.plans.transition(
          repository,
          plan,
          {
            ...withoutFailure(plan),
            status: 'RECOVERED',
            publication: {
              commentId,
              commentUrl: commentUrl(site, issueKey, commentId),
              publishedAt: record.publication.publishedAt,
              propertyStored: plan.publication?.propertyStored ?? false,
            },
          },
          this.now(),
        );
        actions.push({ kind: 'plan-synced', reportId: plan.reportId, status: 'RECOVERED' });
      } else if (
        (plan.status === 'PUBLISHING' || plan.status === 'UNCERTAIN') &&
        (!record || ['failed', 'cancelled', 'revoked'].includes(record.state))
      ) {
        // No journal entry means the request was never sent (the entry precedes it).
        const retryable = !record || record.state === 'failed';
        await this.settlePlan(
          repository,
          plan,
          'FAILED',
          'The publication did not reach Jira.',
          retryable,
        );
        actions.push({ kind: 'plan-synced', reportId: plan.reportId, status: 'FAILED' });
      }
    }
  }

  /** Restores missing metadata properties and reports Jira-side anomalies. */
  private async repairRemote(
    client: JiraClient,
    repository: RepositoryInfo,
    records: ReportRecord[],
    scan: RemoteScan,
    accountId: string | undefined,
    actions: RecoveryAction[],
    signal?: AbortSignal,
  ): Promise<void> {
    const byReport = new Map<string, RemoteReport[]>();
    for (const report of scan.reports) {
      if (report.authorAccountId !== accountId) continue;
      byReport.set(report.reportId, [...(byReport.get(report.reportId) ?? []), report]);
    }
    for (const [reportId, comments] of byReport) {
      if (comments.length > 1) {
        actions.push({ kind: 'duplicate', reportId, commentIds: comments.map((c) => c.commentId) });
      }
      const record = records.find((r) => r.reportId === reportId);
      if (!record) {
        const [first] = comments;
        if (first)
          actions.push({
            kind: 'remote-only',
            reportId,
            commentId: first.commentId,
            sequence: first.sequence,
          });
      }
    }
    for (const record of records) {
      const commentId = record.publication?.commentId;
      if (!isCheckpoint(record) || !commentId) continue;
      const remote = scan.reports.find((r) => r.commentId === commentId);
      if (!remote) {
        if (scan.complete)
          actions.push({ kind: 'missing-in-jira', reportId: record.reportId, commentId });
        continue;
      }
      if (remote.metadata?.reportId === record.reportId) continue;
      const plan = await this.deps.plans.readOptional(repository, record.reportId);
      const metadata = plan ? this.metadata(plan) : this.metadataFromRecord(record);
      if (await this.ensureProperty(client, commentId, metadata, signal)) {
        actions.push({ kind: 'property-restored', reportId: record.reportId, commentId });
        if (plan?.publication && !plan.publication.propertyStored) {
          await this.deps.plans.write(repository, {
            ...plan,
            publication: { ...plan.publication, propertyStored: true },
            updatedAt: this.now().toISOString(),
          });
        }
      }
    }
  }

  /** Makes sure the comment carries Git2Jira's metadata property. Returns false if it could not. */
  private async ensureProperty(
    client: JiraClient,
    commentId: string,
    metadata: ReportMetadata,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const current = ReportMetadataSchema.safeParse(
        await client.getCommentProperty(commentId, REPORT_PROPERTY_KEY, signal),
      );
      if (current.success && current.data.reportId === metadata.reportId) return true;
      await client.setCommentProperty(commentId, REPORT_PROPERTY_KEY, metadata, signal);
      return true;
    } catch {
      return false;
    }
  }

  private async commentCarriesReport(
    client: JiraClient,
    plan: StoredPlan,
    comment: JiraComment,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const carries = (body: unknown) =>
      findReportMarkers(adfToPlainText(body)).some((m) => m.reportId === plan.reportId);
    if (carries(comment.body)) return true;
    try {
      return carries((await client.getComment(plan.issueKey, comment.id, signal)).body);
    } catch {
      return false;
    }
  }

  private render(plan: StoredPlan, report: StructuredReport) {
    return this.deps.renderer.render({
      report,
      files: plan.files,
      labels: this.deps.labels.labels(plan.language),
      footer: {
        reportId: plan.reportId,
        sequence: plan.sequence,
        baseTree: plan.baseline.tree,
        targetTree: plan.snapshot.tree,
        toolVersion: this.toolVersion,
      },
    });
  }

  private digestOf(plan: StoredPlan, document: AdfDocument): string {
    return reportDigest({
      siteId: plan.site.id,
      issueKey: plan.issueKey,
      reportId: plan.reportId,
      sequence: plan.sequence,
      baseTree: plan.baseline.tree,
      targetTree: plan.snapshot.tree,
      snapshotCommit: plan.snapshot.commit,
      document,
    });
  }

  private metadata(plan: StoredPlan): ReportMetadata {
    return {
      schemaVersion: 1,
      reportId: plan.reportId,
      sequence: plan.sequence,
      issueKey: plan.issueKey,
      siteId: plan.site.id,
      repositoryId: plan.repositoryId,
      baseTree: plan.baseline.tree,
      targetTree: plan.snapshot.tree,
      snapshotCommit: plan.snapshot.commit,
      reportDigest: plan.reportDigest ?? '0'.repeat(64),
      language: plan.language,
      toolVersion: this.toolVersion,
    };
  }

  private metadataFromRecord(record: ReportRecord): ReportMetadata {
    return {
      schemaVersion: 1,
      reportId: record.reportId,
      sequence: record.sequence,
      issueKey: record.issueKey,
      siteId: record.site.id,
      repositoryId: record.repository.id,
      baseTree: record.baseline.tree,
      targetTree: record.snapshot.tree,
      snapshotCommit: record.snapshot.commit,
      reportDigest: record.reportDigest,
      // The language is not part of the journal; plans carry it. Defaults to English.
      language: 'en',
      toolVersion: this.toolVersion,
    };
  }

  private candidate(repository: RepositoryInfo, plan: StoredPlan): PublicationCandidate {
    return {
      reportId: plan.reportId,
      site: plan.site,
      snapshotRef: plan.snapshotRef,
      snapshot: plan.snapshot,
      baseline: plan.baseline,
      context: { repository, issueKey: plan.issueKey, branch: plan.branch },
    };
  }

  private withPublicationLock<T>(
    repository: RepositoryInfo,
    site: JiraSite,
    issueKey: IssueKey,
    fn: () => Promise<T>,
  ): Promise<T> {
    const file = path.join(stateDir(repository), 'locks', `publish-${site.id}-${issueKey}.lock`);
    // Comment requests can take a while; wait longer than for journal writes.
    return withFileLock(file, fn, { timeoutMs: 60_000, ...this.deps.lockOptions });
  }
}

function published(state: 'PUBLISHED' | 'RECOVERED', result: Finalized): PublicationOutcome {
  if (!result.plan) throw new Error('A publication outcome needs its plan.');
  return { ...result, state, plan: result.plan };
}

function criteria(selection: TargetSelection, identity: IssueIdentity): ConnectionCriteria {
  return {
    connection: selection.connection,
    site: selection.site,
    repositorySite: selection.repositorySite,
    historySites: identity.historySites,
    issueKey: identity.issueKey,
  };
}

export function commentUrl(site: JiraSite, issueKey: IssueKey, commentId: string): string {
  return `${site.url}/browse/${issueKey}?focusedCommentId=${commentId}`;
}

function toReportFile(file: FileChange): ReportFile {
  return {
    status: file.status,
    path: file.path,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
  };
}

function withoutFailure(plan: StoredPlan): StoredPlan {
  const { failure: _failure, ...rest } = plan;
  return rest;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isoTime(value: string, fallback: Date): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback.toISOString() : new Date(parsed).toISOString();
}
