import { randomUUID } from 'node:crypto';
import {
  CheckpointCorruptedError,
  CheckpointUnavailableError,
  BranchChangedError,
  DuplicateReportIdError,
  JournalMissingError,
  MultipleSitesError,
  PendingPublicationError,
  StaleReportError,
  UnknownReportError,
} from '../checkpoints/errors';
import { candidateRef, checkpointRef, lineageRefPrefix, type GitRefs } from '../checkpoints/refs';
import type { LineageStore } from '../checkpoints/store';
import {
  ReportRecordSchema,
  isCheckpoint,
  latestCheckpoint,
  unresolvedRecords,
  type Baseline,
  type BranchIdentity,
  type Checkpoint,
  type ConfirmationMethod,
  type JiraSite,
  type LineageJournal,
  type RepositoryIdentity,
  type ReportRecord,
} from '../checkpoints/types';
import type { BaseBranchResolver, ResolvedBase } from '../git/base';
import {
  AmbiguousIssueKeyError,
  DetachedHeadError,
  IssueKeyNotFoundError,
  OperationInProgressError,
} from '../git/errors';
import { parseIssueKey } from '../git/issue-key';
import { operationInProgress } from '../git/repository';
import type {
  GitRepositoryLocator,
  IssueKey,
  IssueKeyDetector,
  RepositoryInfo,
} from '../git/types';
import { emptyTree } from '../snapshots/engine';
import type { GitCommandRunner } from '../git/types';
import {
  isEmptyChangeSet,
  type ChangeSet,
  type DiffOptions,
  type IncrementalDiffEngine,
  type Snapshot,
  type SnapshotEngine,
} from '../snapshots/types';

export interface LifecycleDependencies {
  git: GitCommandRunner;
  locator: GitRepositoryLocator;
  issueKeys: IssueKeyDetector;
  baseResolver: BaseBranchResolver;
  snapshots: SnapshotEngine;
  diff: IncrementalDiffEngine;
  store: LineageStore;
  refs: GitRefs;
  now?: () => Date;
  /**
   * Candidate refs that open reports (plans and drafts not yet in the journal) still
   * need. Recovery never removes them, however old they are: a manual report may wait
   * days for the user's confirmation.
   */
  openCandidates?: (repository: RepositoryInfo) => Promise<readonly string[]>;
}

export interface AnalysisRequest {
  cwd: string;
  /** `--issue`; overrides branch detection. */
  issue?: string | undefined;
  /** `--base`; used only for the first report of an issue. */
  base?: string | undefined;
  /** `base.branch` from repository configuration. */
  configuredBase?: string | undefined;
  /** `issue.projectKeys` from repository configuration. */
  projectKeys?: readonly string[] | undefined;
  /** Jira site. Required to prepare; optional for read-only analysis. */
  site?: JiraSite | undefined;
  /** Continue a lineage whose last report was made on another branch. */
  acceptBranchChange?: boolean | undefined;
  diffOptions?: Partial<DiffOptions> | undefined;
}

export interface ReportContext {
  repository: RepositoryInfo;
  branch: BranchIdentity;
  issueKey: IssueKey;
  issueSource: 'option' | 'branch';
  site: JiraSite | undefined;
  journal: LineageJournal | undefined;
  previous: Checkpoint | undefined;
  /** Publications from earlier runs whose outcome is not settled yet. */
  unresolved: ReportRecord[];
  branchChange?: { from: string; renamed: boolean };
}

export interface Analysis {
  context: ReportContext;
  baseline: Baseline;
  /** Base branch used for a first report. */
  base?: ResolvedBase;
  snapshot: Snapshot;
  changeSet: ChangeSet;
  hasChanges: boolean;
  nextSequence: number;
}

export interface PreparedReport extends Analysis {
  reportId: string;
  site: JiraSite;
  /** Candidate ref that keeps the snapshot alive until promotion or cancellation. */
  snapshotRef: string;
}

export type PrepareResult =
  { status: 'prepared'; report: PreparedReport } | { status: 'no-changes'; analysis: Analysis };

export interface LineageKey {
  repository: RepositoryInfo;
  site: JiraSite;
  issueKey: IssueKey;
}

/** The fields of a prepared report that publication needs; PreparedReport satisfies it. */
export interface PublicationCandidate {
  reportId: string;
  site: JiraSite;
  snapshotRef: string;
  snapshot: Snapshot;
  baseline: Baseline;
  context: { repository: RepositoryInfo; issueKey: IssueKey; branch: BranchIdentity };
}

export interface IssueIdentity {
  repository: RepositoryInfo;
  issueKey: IssueKey;
  issueSource: 'option' | 'branch';
  /** Sites this issue already has a report journal for in this repository. */
  historySites: JiraSite[];
}

/**
 * - published: Jira created the comment.
 * - not published, `retryable`: Jira definitely did not create it; keep the snapshot
 *   (state `failed`) so the same approved report can be sent again.
 * - not published otherwise: abandon it (state `cancelled`, snapshot ref removed).
 */
export type PendingOutcome =
  ({ published: true } & PublicationEvidence) | { published: false; retryable?: boolean };

/** What establishes that a report reached Jira. See ConfirmationMethodSchema. */
export interface PublicationEvidence {
  /** Absent for user-attested (manual) publications. */
  commentId?: string | undefined;
  publishedAt: string;
  /** Defaults to `jira-api`. */
  confirmedBy?: ConfirmationMethod | undefined;
}

export interface RecoveryReport {
  rebuiltFromRefs: boolean;
  quarantinedJournal?: string;
  promoted: string[];
  /** `publishing` records whose Jira outcome must be checked (Phase 2) and settled via resolvePending. */
  unresolved: ReportRecord[];
  removedCandidates: string[];
  unreadableRefs: string[];
}

const CANDIDATE_ORPHAN_AGE_MS = 60 * 60 * 1000;

/**
 * Deterministic state machine for incremental reports. It decides the
 * baseline, captures snapshots, and records each publication step so that a
 * report is only considered done after Jira confirmed it and the checkpoint
 * was promoted. Jira calls themselves are made by the caller (Phase 2).
 */
export class PublicationLifecycle {
  private readonly now: () => Date;

  constructor(private readonly deps: LifecycleDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Read-only: locates the repository and issue key, and lists sites with history. */
  async identify(
    request: Pick<AnalysisRequest, 'cwd' | 'issue' | 'projectKeys'>,
  ): Promise<IssueIdentity> {
    const repository = await this.deps.locator.locate(request.cwd);
    if (repository.branch === null) throw new DetachedHeadError();
    const { issueKey, issueSource } = this.resolveIssue(repository.branch, request);
    const historySites: JiraSite[] = [];
    for (const siteId of await this.deps.store.sitesWithJournal(repository, issueKey)) {
      const journal = await this.deps.store
        .read(repository, siteId, issueKey)
        .catch(() => undefined);
      if (journal) historySites.push(journal.site);
    }
    return { repository, issueKey, issueSource, historySites };
  }

  /** Read-only: computes what the next report would contain. Creates no refs. */
  async analyze(request: AnalysisRequest): Promise<Analysis> {
    const context = await this.resolveContext(request, false);
    return this.computeAnalysis(context, request, undefined);
  }

  /** Captures a candidate snapshot under a private ref and computes its change set. */
  async prepare(request: AnalysisRequest & { site: JiraSite }): Promise<PrepareResult> {
    const context = await this.resolveContext(request, true);
    const first = context.unresolved[0];
    if (first) throw new PendingPublicationError(first.sequence, first.state);

    const reportId = randomUUID();
    const ref = candidateRef(request.site.id, context.issueKey, reportId);
    const analysis = await this.computeAnalysis(context, request, ref);
    if (!analysis.hasChanges) {
      await this.deps.refs.delete(context.repository, ref, analysis.snapshot.commit);
      return { status: 'no-changes', analysis };
    }
    return {
      status: 'prepared',
      report: { ...analysis, reportId, site: request.site, snapshotRef: ref },
    };
  }

  /**
   * Records that publication is about to happen. Must be called right before
   * the Jira request; from now on a crash leaves a `publishing` record that
   * recovery settles instead of publishing twice.
   */
  async beginPublication(
    report: PublicationCandidate,
    reportDigest: string,
  ): Promise<ReportRecord> {
    const { repository, issueKey } = report.context;
    return this.deps.store.withLock(repository, report.site.id, issueKey, async () => {
      const identity = await this.deps.store.repositoryIdentity(repository);
      const journal = await this.deps.store.read(repository, report.site.id, issueKey);
      const pending = unresolvedRecords(journal)[0];
      if (pending) throw new PendingPublicationError(pending.sequence, pending.state);
      // A report id is sent at most once, except to retry a definite failure or to
      // confirm again a manual publication the user withdrew.
      const existing = journal?.records.find((r) => r.reportId === report.reportId);
      if (existing && existing.state !== 'failed' && existing.state !== 'revoked') {
        throw new DuplicateReportIdError(report.reportId, existing.state);
      }
      if (existing && existing.reportDigest !== reportDigest) {
        throw new UnknownReportError(report.reportId, 'the report that was approved earlier');
      }

      const latest = latestCheckpoint(journal);
      const expectedPrevious =
        report.baseline.kind === 'checkpoint' ? report.baseline.reportId : undefined;
      if (latest?.reportId !== expectedPrevious) throw new StaleReportError();
      if (
        (await this.deps.refs.resolve(repository, report.snapshotRef)) !== report.snapshot.commit
      ) {
        throw new UnknownReportError(
          report.reportId,
          'backed by its candidate snapshot ref anymore',
        );
      }

      const timestamp = this.now().toISOString();
      const record = ReportRecordSchema.parse({
        schemaVersion: 1,
        reportId: report.reportId,
        sequence: (latest?.sequence ?? 0) + 1,
        site: report.site,
        issueKey,
        repository: identity,
        branch: report.context.branch,
        baseline: report.baseline,
        snapshot: report.snapshot,
        snapshotRef: report.snapshotRef,
        state: 'publishing',
        reportDigest,
        createdAt: timestamp,
        updatedAt: timestamp,
      } satisfies ReportRecord);

      const base = journal ?? newJournal(report.site, issueKey, identity);
      await this.deps.store.write(
        repository,
        existing
          ? replaceRecord(base, {
              ...record,
              createdAt: existing.createdAt,
              ...(existing.revocation ? { revocation: existing.revocation } : {}),
            })
          : { ...base, records: [...base.records, record] },
      );
      return record;
    });
  }

  /** Jira confirmed the comment: record it and promote the snapshot to the new checkpoint. */
  async confirmPublication(
    key: LineageKey,
    reportId: string,
    evidence: PublicationEvidence,
  ): Promise<Checkpoint> {
    const publication = {
      ...(evidence.commentId !== undefined ? { commentId: evidence.commentId } : {}),
      publishedAt: evidence.publishedAt,
      confirmedBy: evidence.confirmedBy ?? 'jira-api',
    };
    return this.deps.store.withLock(key.repository, key.site.id, key.issueKey, async () => {
      let journal = await this.requireJournal(key);
      const record = findRecord(journal, reportId);
      if (isCheckpoint(record)) return record;
      if (record.state === 'cancelled' || record.state === 'revoked')
        throw new UnknownReportError(reportId, 'awaiting publication');
      // A "failed" report that Jira turns out to have published is only promotable
      // while nothing newer was published on top of its baseline.
      if (
        record.state === 'failed' &&
        (latestCheckpoint(journal)?.sequence ?? 0) >= record.sequence
      )
        throw new StaleReportError();
      if (record.publication && record.publication.commentId !== publication.commentId) {
        throw new UnknownReportError(reportId, `confirmed with comment ${publication.commentId}`);
      }
      journal = replaceRecord(journal, {
        ...record,
        state: 'confirmed',
        publication,
        updatedAt: this.now().toISOString(),
      });
      await this.deps.store.write(key.repository, journal);
      return this.promote(key, journal, reportId);
    });
  }

  /** Settles a `publishing` record once the Jira outcome is known. */
  async resolvePending(
    key: LineageKey,
    reportId: string,
    outcome: PendingOutcome,
  ): Promise<ReportRecord> {
    if (outcome.published) {
      const { published: _published, ...evidence } = outcome;
      return this.confirmPublication(key, reportId, evidence);
    }
    return this.deps.store.withLock(key.repository, key.site.id, key.issueKey, async () => {
      const journal = await this.requireJournal(key);
      const record = findRecord(journal, reportId);
      if (record.state !== 'publishing')
        throw new UnknownReportError(reportId, 'in the publishing state');
      const settled: ReportRecord = {
        ...record,
        state: outcome.retryable ? 'failed' : 'cancelled',
        updatedAt: this.now().toISOString(),
      };
      await this.deps.store.write(key.repository, replaceRecord(journal, settled));
      if (!outcome.retryable) await this.deleteRefIfPresent(key.repository, record.snapshotRef);
      return settled;
    });
  }

  /** Abandons a prepared report that was never sent. The baseline does not move. */
  async cancel(
    report: Pick<PublicationCandidate, 'reportId' | 'site' | 'snapshotRef' | 'context'>,
  ): Promise<void> {
    const { repository, issueKey } = report.context;
    await this.deps.store.withLock(repository, report.site.id, issueKey, async () => {
      const journal = await this.deps.store.read(repository, report.site.id, issueKey);
      const record = journal?.records.find((r) => r.reportId === report.reportId);
      if (record && !['cancelled', 'failed', 'revoked'].includes(record.state)) {
        throw new UnknownReportError(
          report.reportId,
          'cancellable: publication has started; settle it with resolvePending',
        );
      }
      if (journal && (record?.state === 'failed' || record?.state === 'revoked')) {
        await this.deps.store.write(
          repository,
          replaceRecord(journal, {
            ...record,
            state: 'cancelled',
            updatedAt: this.now().toISOString(),
          }),
        );
      }
      await this.deleteRefIfPresent(repository, report.snapshotRef);
    });
  }

  /**
   * Withdraws the latest checkpoint when it was established only by the user's word
   * (manual mode) and the user says that was a mistake. The snapshot goes back under
   * its candidate ref, the checkpoint ref is removed, and the previous checkpoint is
   * the baseline again. API- or MCP-confirmed reports cannot be withdrawn: a comment
   * exists in Jira, and Git2Jira cannot delete comments.
   */
  async revokeCheckpoint(key: LineageKey, reportId: string, reason: string): Promise<ReportRecord> {
    return this.deps.store.withLock(key.repository, key.site.id, key.issueKey, async () => {
      const journal = await this.requireJournal(key);
      const record = findRecord(journal, reportId);
      if (!isCheckpoint(record)) throw new UnknownReportError(reportId, 'a published checkpoint');
      if (record.publication.confirmedBy !== 'user-attested') {
        throw new UnknownReportError(
          reportId,
          'a manual (user-attested) publication; it was confirmed by Jira and cannot be withdrawn',
        );
      }
      if (latestCheckpoint(journal)?.reportId !== reportId) {
        throw new UnknownReportError(
          reportId,
          'the latest checkpoint: newer reports were confirmed on top of it',
        );
      }
      const { repository } = key;
      // Keep the snapshot reachable before the checkpoint ref that protects it goes away.
      const candidate = await this.deps.refs.resolve(repository, record.snapshotRef);
      if (candidate !== record.snapshot.commit) {
        if (candidate) await this.deps.refs.delete(repository, record.snapshotRef, candidate);
        await this.deps.refs.create(
          repository,
          record.snapshotRef,
          record.snapshot.commit,
          'git2jira: revoke checkpoint',
        );
      }
      const {
        checkpointRef: _ref,
        checkpointCommit: _commit,
        publication: _publication,
        ...rest
      } = record;
      const now = this.now().toISOString();
      const revoked: ReportRecord = {
        ...rest,
        state: 'revoked',
        revocation: { revokedAt: now, reason: reason.slice(0, 500) },
        updatedAt: now,
      };
      await this.deps.store.write(repository, replaceRecord(journal, revoked));
      await this.deleteRefIfPresent(repository, record.checkpointRef);
      return revoked;
    });
  }

  /**
   * Repairs local state after crashes: rebuilds a missing or corrupted journal
   * from checkpoint refs, promotes confirmed publications, removes abandoned
   * candidate refs, and lists `publishing` records that need a Jira lookup.
   */
  async recover(key: LineageKey): Promise<RecoveryReport> {
    const { repository, site, issueKey } = key;
    return this.deps.store.withLock(repository, site.id, issueKey, async () => {
      const report: RecoveryReport = {
        rebuiltFromRefs: false,
        promoted: [],
        unresolved: [],
        removedCandidates: [],
        unreadableRefs: [],
      };
      const identity = await this.deps.store.repositoryIdentity(repository);

      let journal: LineageJournal | undefined;
      try {
        journal = await this.deps.store.read(repository, site.id, issueKey);
      } catch (error) {
        if (!(error instanceof CheckpointCorruptedError)) throw error;
        const moved = await this.deps.store.quarantine(repository, site.id, issueKey);
        if (moved) report.quarantinedJournal = moved;
      }

      // Merge in published checkpoints that exist as refs but not in the journal.
      const fromRefs = await this.readCheckpointRefs(repository, site, issueKey, report);
      const known = new Set(journal?.records.map((r) => r.reportId));
      const missing = fromRefs.filter(
        (r) => !known.has(r.reportId) && r.repository.id === identity.id,
      );
      if (missing.length > 0) {
        report.rebuiltFromRefs = true;
        journal = journal ?? newJournal(site, issueKey, identity);
        journal = {
          ...journal,
          records: [...journal.records, ...missing].sort((a, b) => a.sequence - b.sequence),
        };
      }
      // A journal record may lag behind its checkpoint ref (crash during promotion).
      for (const fromRef of fromRefs) {
        const record = journal?.records.find((r) => r.reportId === fromRef.reportId);
        if (journal && record && !isCheckpoint(record) && record.state !== 'cancelled') {
          journal = replaceRecord(journal, fromRef);
          report.promoted.push(record.reportId);
        }
      }
      if (journal) await this.deps.store.write(repository, journal);

      for (const record of journal?.records ?? []) {
        if (record.state === 'confirmed' && journal) {
          await this.promote(key, journal, record.reportId);
          journal = await this.requireJournal(key);
          report.promoted.push(record.reportId);
        } else if (record.state === 'publishing') {
          report.unresolved.push(record);
        }
      }

      const active = new Set([
        ...(journal?.records ?? [])
          .filter((r) => ['publishing', 'failed', 'revoked'].includes(r.state))
          .map((r) => r.snapshotRef),
        ...((await this.deps.openCandidates?.(repository)) ?? []),
      ]);
      const now = this.now().getTime();
      for (const candidate of await this.deps.refs.list(
        repository,
        `${lineageRefPrefix(site.id, issueKey)}/candidates/`,
      )) {
        if (active.has(candidate.ref)) continue;
        if (now - candidate.committerDate * 1000 < CANDIDATE_ORPHAN_AGE_MS) continue;
        await this.deps.refs.delete(repository, candidate.ref, candidate.oid);
        report.removedCandidates.push(candidate.ref);
      }
      return report;
    });
  }

  // ---------------------------------------------------------------------------

  private async resolveContext(
    request: AnalysisRequest,
    requireSite: boolean,
  ): Promise<ReportContext> {
    const repository = await this.deps.locator.locate(request.cwd);
    if (repository.branch === null) throw new DetachedHeadError();
    const operation = operationInProgress(repository);
    if (operation) throw new OperationInProgressError(operation);

    const { issueKey, issueSource } = this.resolveIssue(repository.branch, request);
    const site =
      request.site ?? (requireSite ? undefined : await this.discoverSite(repository, issueKey));
    if (requireSite && !site) throw new Error('A Jira site is required to prepare a report.');

    let journal: LineageJournal | undefined;
    let previous: Checkpoint | undefined;
    if (site) {
      journal = await this.deps.store.read(repository, site.id, issueKey);
      const refs = await this.deps.refs.list(
        repository,
        `${lineageRefPrefix(site.id, issueKey)}/checkpoints/`,
      );
      if (!journal && refs.length > 0) throw new JournalMissingError(refs.length);
      previous = latestCheckpoint(journal);
      // Published records own their checkpoint ref; a confirmed record may own one being promoted.
      const journalRefs = new Set(
        journal?.records.flatMap((r) => {
          if (isCheckpoint(r)) return [r.checkpointRef];
          return r.state === 'confirmed' ? [checkpointRef(site.id, issueKey, r.sequence)] : [];
        }),
      );
      const unknownRefs = refs.filter((r) => !journalRefs.has(r.ref));
      if (unknownRefs.length > 0) {
        throw new CheckpointCorruptedError(
          this.deps.store.journalPath(repository, site.id, issueKey),
          `checkpoint ref ${unknownRefs[0]?.ref ?? ''} is not recorded in the journal`,
        );
      }
      if (previous) await this.verifyCheckpoint(repository, previous);
    }

    const context: ReportContext = {
      repository,
      branch: { name: repository.branch, ref: `refs/heads/${repository.branch}` },
      issueKey,
      issueSource,
      site,
      journal,
      previous,
      unresolved: unresolvedRecords(journal),
    };

    if (previous && previous.branch.name !== repository.branch) {
      const renamed = await this.wasRenamed(repository, previous.branch.name, repository.branch);
      if (!renamed && !request.acceptBranchChange) {
        throw new BranchChangedError(previous.branch.name, repository.branch);
      }
      context.branchChange = { from: previous.branch.name, renamed };
    }
    return context;
  }

  private resolveIssue(
    branch: string,
    request: AnalysisRequest,
  ): { issueKey: IssueKey; issueSource: 'option' | 'branch' } {
    if (request.issue !== undefined)
      return { issueKey: parseIssueKey(request.issue), issueSource: 'option' };
    const detection = this.deps.issueKeys.detect(
      branch,
      request.projectKeys ? { projectKeys: request.projectKeys } : {},
    );
    if (detection.status === 'not-found') throw new IssueKeyNotFoundError(branch);
    if (detection.status === 'ambiguous')
      throw new AmbiguousIssueKeyError(branch, detection.candidates);
    return { issueKey: detection.issueKey, issueSource: 'branch' };
  }

  /** Without an explicit site, use the only site this issue has history for, if any. */
  private async discoverSite(
    repository: RepositoryInfo,
    issueKey: IssueKey,
  ): Promise<JiraSite | undefined> {
    const siteIds = new Set([
      ...(await this.deps.store.sitesWithJournal(repository, issueKey)),
      ...(await this.deps.refs.sitesWithRefs(repository, issueKey)),
    ]);
    if (siteIds.size === 0) return undefined;
    if (siteIds.size > 1) throw new MultipleSitesError([...siteIds]);
    const [siteId] = [...siteIds] as [string];
    const journal = await this.deps.store.read(repository, siteId, issueKey);
    if (!journal) {
      const refs = await this.deps.refs.list(
        repository,
        `${lineageRefPrefix(siteId, issueKey)}/checkpoints/`,
      );
      if (refs.length > 0) throw new JournalMissingError(refs.length);
      return undefined;
    }
    return journal.site;
  }

  private async verifyCheckpoint(
    repository: RepositoryInfo,
    checkpoint: Checkpoint,
  ): Promise<void> {
    const oid = await this.deps.refs.resolve(repository, checkpoint.checkpointRef);
    if (!oid)
      throw new CheckpointUnavailableError(
        checkpoint.sequence,
        `ref ${checkpoint.checkpointRef} is missing`,
      );
    if (oid !== checkpoint.checkpointCommit) {
      throw new CheckpointUnavailableError(
        checkpoint.sequence,
        `ref ${checkpoint.checkpointRef} was moved`,
      );
    }
    if (!(await this.deps.refs.objectExists(repository, checkpoint.snapshot.tree, 'tree'))) {
      throw new CheckpointUnavailableError(checkpoint.sequence, 'snapshot objects are missing');
    }
    if ((await this.deps.refs.treeOf(repository, oid)) !== checkpoint.snapshot.tree) {
      throw new CheckpointUnavailableError(
        checkpoint.sequence,
        'checkpoint commit does not match the snapshot',
      );
    }
  }

  private async wasRenamed(repository: RepositoryInfo, from: string, to: string): Promise<boolean> {
    if (await this.deps.refs.resolve(repository, `refs/heads/${from}`)) return false;
    const subjects = await this.deps.refs.reflogSubjects(repository, to);
    return subjects.some((s) => s.includes(`renamed refs/heads/${from} to refs/heads/${to}`));
  }

  private async computeAnalysis(
    context: ReportContext,
    request: AnalysisRequest,
    ref: string | undefined,
  ): Promise<Analysis> {
    const { repository, issueKey, previous } = context;
    let baseline: Baseline;
    let base: ResolvedBase | undefined;
    let fromCommit: string | null;

    if (previous) {
      baseline = {
        kind: 'checkpoint',
        reportId: previous.reportId,
        sequence: previous.sequence,
        tree: previous.snapshot.tree,
        headCommit: previous.snapshot.headCommit,
      };
      fromCommit = previous.snapshot.headCommit;
    } else if (repository.headCommit === null) {
      baseline = { kind: 'empty', tree: await emptyTree(this.deps.git, repository) };
      fromCommit = null;
    } else {
      base = await this.deps.baseResolver.resolve(repository, {
        explicit: request.base,
        configured: request.configuredBase,
      });
      baseline = {
        kind: 'merge-base',
        baseRef: base.ref,
        baseName: base.name,
        baseCommit: base.commit,
        mergeBase: base.mergeBase,
        tree: await this.deps.refs.treeOf(repository, base.mergeBase),
      };
      fromCommit = base.mergeBase;
    }

    const snapshot = await this.deps.snapshots.capture(repository, {
      message: `git2jira snapshot ${issueKey}`,
      ...(ref ? { ref } : {}),
    });
    const changeSet = await this.deps.diff.diff(
      repository,
      {
        baseTree: baseline.tree,
        targetTree: snapshot.tree,
        fromCommit,
        toCommit: snapshot.headCommit,
      },
      request.diffOptions,
    );

    return {
      context,
      baseline,
      ...(base ? { base } : {}),
      snapshot,
      changeSet,
      hasChanges: !isEmptyChangeSet(changeSet),
      nextSequence: (previous?.sequence ?? 0) + 1,
    };
  }

  /** Writes the checkpoint commit and ref, then marks the record published. Idempotent. */
  private async promote(
    key: LineageKey,
    journal: LineageJournal,
    reportId: string,
  ): Promise<Checkpoint> {
    const { repository } = key;
    const record = findRecord(journal, reportId);
    if (isCheckpoint(record)) return record;
    if (record.state !== 'confirmed' || !record.publication) {
      throw new UnknownReportError(reportId, 'confirmed');
    }
    const ref = checkpointRef(key.site.id, key.issueKey, record.sequence);
    const published = { ...record, state: 'published' as const, checkpointRef: ref };
    const { checkpointCommit: _omit, ...payload } = published;

    let commit = await this.deps.refs.resolve(repository, ref);
    if (commit) {
      const existing = parseCheckpointMessage(
        await this.deps.refs.commitMessage(repository, commit),
      );
      if (existing?.reportId !== reportId) {
        throw new CheckpointCorruptedError(ref, 'checkpoint ref belongs to a different report');
      }
    } else {
      commit = await this.deps.refs.commitTree(
        repository,
        record.snapshot.tree,
        record.snapshot.commit,
        `git2jira checkpoint ${key.issueKey} #${String(record.sequence)}\n\n${JSON.stringify(payload)}\n`,
        record.publication.publishedAt,
      );
      await this.deps.refs.create(repository, ref, commit, 'git2jira: checkpoint');
    }

    const checkpoint = {
      ...published,
      checkpointCommit: commit,
      updatedAt: this.now().toISOString(),
    };
    await this.deps.store.write(repository, replaceRecord(journal, checkpoint));
    await this.deleteRefIfPresent(repository, record.snapshotRef);
    return checkpoint as Checkpoint;
  }

  private async readCheckpointRefs(
    repository: RepositoryInfo,
    site: JiraSite,
    issueKey: IssueKey,
    report: RecoveryReport,
  ): Promise<Checkpoint[]> {
    const refs = await this.deps.refs.list(
      repository,
      `${lineageRefPrefix(site.id, issueKey)}/checkpoints/`,
    );
    const records: Checkpoint[] = [];
    for (const { ref, oid } of refs) {
      const parsed = parseCheckpointMessage(await this.deps.refs.commitMessage(repository, oid));
      const record = parsed ? { ...parsed, checkpointCommit: oid } : undefined;
      if (
        record &&
        isCheckpoint(record) &&
        record.checkpointRef === ref &&
        record.site.id === site.id
      ) {
        records.push(record);
      } else {
        report.unreadableRefs.push(ref);
      }
    }
    return records;
  }

  private async requireJournal(key: LineageKey): Promise<LineageJournal> {
    const journal = await this.deps.store.read(key.repository, key.site.id, key.issueKey);
    if (!journal) throw new UnknownReportError('(none)', 'recorded for this issue');
    return journal;
  }

  private async deleteRefIfPresent(repository: RepositoryInfo, ref: string): Promise<void> {
    const oid = await this.deps.refs.resolve(repository, ref);
    if (oid) await this.deps.refs.delete(repository, ref, oid);
  }
}

function newJournal(
  site: JiraSite,
  issueKey: IssueKey,
  repository: RepositoryIdentity,
): LineageJournal {
  return { schemaVersion: 1, site, issueKey, repository, records: [] };
}

function findRecord(journal: LineageJournal, reportId: string): ReportRecord {
  const record = journal.records.find((r) => r.reportId === reportId);
  if (!record) throw new UnknownReportError(reportId, 'recorded for this issue');
  return record;
}

function replaceRecord(journal: LineageJournal, record: ReportRecord): LineageJournal {
  return {
    ...journal,
    records: journal.records.map((r) => (r.reportId === record.reportId ? record : r)),
  };
}

/** Checkpoint commits carry their record as JSON after the subject line. */
function parseCheckpointMessage(message: string): ReportRecord | undefined {
  const body = message.slice(message.indexOf('\n\n') + 2).trim();
  try {
    const parsed = ReportRecordSchema.safeParse({
      ...(JSON.parse(body) as object),
      checkpointCommit: undefined,
    });
    if (!parsed.success) return undefined;
    const { checkpointCommit: _drop, ...record } = parsed.data;
    return record;
  } catch {
    return undefined;
  }
}
