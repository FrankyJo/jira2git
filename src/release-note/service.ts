import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ReportFile } from '../adf/types';
import { validateAdfDocument } from '../adf/validate';
import {
  buildAnalysisPackage,
  reportDiffOptions,
  toReportFile,
  type AnalysisPackage,
} from '../ai/analysis';
import { packageWarnings } from '../ai/engine';
import { redactSecrets } from '../ai/redact';
import { withFileLock, type LockOptions } from '../checkpoints/lock';
import type { GitRefs } from '../checkpoints/refs';
import type { LineageStore } from '../checkpoints/store';
import { Git2JiraError, UsageError } from '../core/errors';
import { terminalSafeLine } from '../core/sanitize';
import { VERSION } from '../core/version';
import type { DraftStore } from '../delivery/draft';
import type { BaseBranchResolver } from '../git/base';
import type { GitRepositoryLocator, RepositoryInfo } from '../git/types';
import { IssueKeyMismatchError } from '../jira/client/errors';
import { RELEASE_NOTE_LABELS } from '../localization/catalog';
import { McpReconcileInputSchema, McpWriteResultSchema } from '../mcp/bridge';
import {
  classifyMcpError,
  parseAccountId,
  parseCommentListing,
  parseCreatedComment,
  parseIssueLookup,
  type ParsedComment,
} from '../mcp/results';
import { ATLASSIAN_TOOLS } from '../mcp/tools';
import { canonicalJson, changesDigest, sha256 } from '../publication/digest';
import { ApprovalMismatchError, PublicationMismatchError } from '../publication/errors';
import type { PublicationLifecycle } from '../publication/lifecycle';
import { commentUrl } from '../publication/service';
import { stateDir } from '../snapshots/engine';
import { isEmptyChangeSet, type ChangeSet, type IncrementalDiffEngine } from '../snapshots/types';
import {
  DELIVERED_RELEASE_NOTE_STATUSES,
  isOpenReleaseNote,
  type ReleaseNoteDraft,
  type ReleaseNoteStore,
} from './draft';
import type { EarlierReport } from './prompt';
import { findReleaseNoteMarkers, releaseNoteMarker, renderReleaseNote } from './render';
import type {
  ReleaseNoteMcpOutcome,
  ReleaseNotePrepareOutcome,
  ReleaseNotePrepareRequest,
  ReleaseNotePublishPayload,
} from './types';
import { finalizeReleaseNote, parseReleaseNoteInput } from './validate';

export interface ReleaseNoteServiceDependencies {
  /** Only `identify` is used: the repository and issue key, read-only. */
  lifecycle: PublicationLifecycle;
  locator: GitRepositoryLocator;
  baseResolver: BaseBranchResolver;
  diff: IncrementalDiffEngine;
  refs: GitRefs;
  store: LineageStore;
  notes: ReleaseNoteStore;
  /** Report drafts: confirmed reports of the issue are offered to the writer as context. */
  reports: DraftStore;
  now?: () => Date;
  toolVersion?: string;
  /** How long after an MCP write attempt "not found in Jira" may be trusted. */
  settleWindowMs?: number;
  lockOptions?: LockOptions;
}

/**
 * Release notes for a whole issue: the committed change set from the merge-base of the
 * branch to HEAD, written by the Claude Code session, validated and rendered here, and
 * delivered as a new Jira comment (manual copy or MCP).
 *
 * A release note never creates refs, never moves a checkpoint, and never touches report
 * history. Like reports, an MCP comment is created only after the user approved the
 * exact digest, and "published" is recorded only from a tool result or comment listing
 * that carries this release note's marker.
 */
export class ReleaseNoteService {
  private readonly now: () => Date;
  private readonly toolVersion: string;
  private readonly settleWindowMs: number;

  constructor(private readonly deps: ReleaseNoteServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.toolVersion = deps.toolVersion ?? VERSION;
    this.settleWindowMs = deps.settleWindowMs ?? 120_000;
  }

  async prepare(request: ReleaseNotePrepareRequest): Promise<ReleaseNotePrepareOutcome> {
    const identity = await this.deps.lifecycle.identify(request);
    const { repository, issueKey } = identity;
    if (repository.headCommit === null || repository.branch === null) {
      throw new Git2JiraError(
        'The branch has no commits yet. A release note covers committed work.',
      );
    }

    let mcp: ReleaseNoteDraft['mcp'];
    let lookupDescription: string | undefined;
    if (request.mode === 'mcp') {
      if (!request.mcp)
        throw new UsageError('MCP mode needs the server, cloud id, and issue lookup.');
      const found = parseIssueLookup(request.mcp.issueLookup);
      if (!found) {
        throw new Git2JiraError(
          `The MCP issue lookup result for ${issueKey} could not be read. Nothing was prepared.`,
        );
      }
      if (found.key !== issueKey) throw new IssueKeyMismatchError(issueKey, found.key);
      mcp = {
        server: request.mcp.server,
        cloudId: request.mcp.cloudId,
        issue: { id: found.id, summary: found.summary.slice(0, 2000) },
      };
      lookupDescription = found.description;
    }

    const existing = await this.deps.notes.list(repository);
    const open = existing.find(
      (d) => isOpenReleaseNote(d) && d.issueKey === issueKey && d.site.id === request.site.id,
    );
    if (open) return { status: 'pending', draft: open };

    const base = await this.deps.baseResolver.resolve(repository, {
      explicit: request.base,
      configured: request.configuredBase,
    });
    const baseTree = await this.deps.refs.treeOf(repository, base.mergeBase);
    const headTree = await this.deps.refs.treeOf(repository, repository.headCommit);
    const changeSet = await this.deps.diff.diff(
      repository,
      {
        baseTree,
        targetTree: headTree,
        fromCommit: base.mergeBase,
        toCommit: repository.headCommit,
      },
      reportDiffOptions(),
    );
    if (isEmptyChangeSet(changeSet)) return { status: 'no-changes' };

    const files = changeSet.files.map(toReportFile);
    const timestamp = this.now().toISOString();
    const title = (request.issueContext?.title ?? mcp?.issue.summary ?? '').slice(0, 2000);
    const description = (request.issueContext?.description ?? lookupDescription ?? '').slice(
      0,
      20_000,
    );
    const draft: ReleaseNoteDraft = {
      schemaVersion: 1,
      noteId: randomUUID(),
      mode: request.mode,
      status: 'DRAFT',
      site: request.site,
      siteIsPlaceholder: request.siteIsPlaceholder,
      issueKey,
      repositoryId: (await this.deps.store.repositoryIdentity(repository)).id,
      branch: repository.branch,
      base: {
        ref: base.ref,
        name: base.name,
        commit: base.commit,
        mergeBase: base.mergeBase,
        tree: baseTree,
      },
      head: { commit: repository.headCommit, tree: headTree },
      language: request.language,
      files,
      changesDigest: changesDigest(files),
      ...(title || description
        ? {
            issueContext: {
              ...(title ? { title } : {}),
              ...(description ? { description } : {}),
            },
          }
        : {}),
      ...(mcp ? { mcp } : {}),
      warnings: [],
      attempts: [],
      events: [{ at: timestamp, status: 'DRAFT' }],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.deps.notes.write(repository, draft);
    return {
      status: 'prepared',
      draft,
      changeSet,
      analysis: this.packageFor(repository, draft, changeSet),
      earlierReports: await this.earlierReports(repository, issueKey),
      delivered: existing.filter(
        (d) => d.issueKey === issueKey && DELIVERED_RELEASE_NOTE_STATUSES.includes(d.status),
      ),
    };
  }

  /** The analysis package of a draft, rebuilt from its two commits. Deterministic. */
  async analysis(
    cwd: string,
    noteId: string,
  ): Promise<{
    draft: ReleaseNoteDraft;
    analysis: AnalysisPackage;
    earlierReports: EarlierReport[];
  }> {
    const repository = await this.deps.locator.locate(cwd);
    const draft = await this.deps.notes.read(repository, noteId);
    return {
      draft,
      analysis: this.packageFor(repository, draft, await this.changeSetOf(repository, draft)),
      earlierReports: await this.earlierReports(repository, draft.issueKey),
    };
  }

  /** Validates the writer's JSON, renders it, and computes the digest. Never writes to Jira. */
  async submit(cwd: string, noteId: string, input: unknown): Promise<ReleaseNoteDraft> {
    const repository = await this.deps.locator.locate(cwd);
    const draft = await this.deps.notes.read(repository, noteId);
    if (draft.status !== 'DRAFT' && draft.status !== 'READY') {
      throw new Git2JiraError(
        `Release note ${noteId} is ${draft.status}; its content can no longer change.`,
      );
    }
    const content = parseReleaseNoteInput(input);
    const note = finalizeReleaseNote(content, {
      noteId: draft.noteId,
      issueKey: draft.issueKey,
      language: draft.language,
      files: draft.files,
    });
    const rendering = renderReleaseNote({
      note,
      labels: RELEASE_NOTE_LABELS[draft.language],
      toolVersion: this.toolVersion,
    });
    const rendered = { ...rendering, adf: validateAdfDocument(rendering.adf) };
    const pkg = this.packageFor(repository, draft, await this.changeSetOf(repository, draft));
    const warnings = packageWarnings(pkg)
      .map((w) =>
        w
          .replace(' The report says so.', '')
          .replace('review the report', 'review the release note'),
      )
      .slice(0, 50)
      .map((w) => w.slice(0, 1000));
    return this.deps.notes.transition(
      repository,
      draft,
      {
        ...draft,
        status: 'READY',
        note,
        rendered,
        noteDigest: releaseNoteDigest(draft, rendered),
        warnings,
      },
      this.now(),
    );
  }

  async get(cwd: string, noteId: string): Promise<ReleaseNoteDraft> {
    return this.deps.notes.read(await this.deps.locator.locate(cwd), noteId);
  }

  async list(cwd: string): Promise<ReleaseNoteDraft[]> {
    return this.deps.notes.list(await this.deps.locator.locate(cwd));
  }

  /** The only open release note (of `issueKey`, if given). */
  async current(cwd: string, issueKey?: string): Promise<ReleaseNoteDraft> {
    const open = (await this.list(cwd)).filter(
      (d) => isOpenReleaseNote(d) && (issueKey === undefined || d.issueKey === issueKey),
    );
    if (open.length === 1 && open[0]) return open[0];
    throw new UsageError(
      open.length === 0
        ? 'No open release note. Prepare one with "git2jira release-note prepare".'
        : 'Several release notes are open; pass --note <id> (see "git2jira release-note pending").',
    );
  }

  /** Abandons a release note that is definitely not in Jira. */
  async cancel(cwd: string, noteId: string): Promise<ReleaseNoteDraft> {
    const repository = await this.deps.locator.locate(cwd);
    return this.withLock(repository, noteId, async () => {
      const draft = await this.deps.notes.read(repository, noteId);
      if (draft.status === 'PUBLISHING' || draft.status === 'UNCERTAIN') {
        throw new Git2JiraError(
          `Release note ${noteId} is ${draft.status}: it may already be in Jira. Reconcile it first.`,
        );
      }
      return this.deps.notes.transition(
        repository,
        draft,
        { ...draft, status: 'CANCELLED' },
        this.now(),
      );
    });
  }

  /** Manual mode: the user's statement that this exact text is in Jira. User-attested. */
  async confirmManual(cwd: string, noteId: string, digest: string): Promise<ReleaseNoteDraft> {
    const repository = await this.deps.locator.locate(cwd);
    return this.withLock(repository, noteId, async () => {
      const draft = await this.deps.notes.read(repository, noteId);
      if (draft.mode !== 'manual') {
        throw new UsageError(
          `Release note ${noteId} is delivered through MCP; publish it instead.`,
        );
      }
      if (draft.status !== 'READY' || !draft.rendered || !draft.noteDigest) {
        throw new Git2JiraError(
          `Release note ${noteId} is ${draft.status}; there is nothing to confirm.`,
        );
      }
      if (digest !== draft.noteDigest || digest !== releaseNoteDigest(draft, draft.rendered)) {
        throw new ApprovalMismatchError();
      }
      return this.deps.notes.transition(
        repository,
        draft,
        {
          ...draft,
          status: 'CONFIRMED',
          attestation: { noteDigest: digest, attestedAt: this.now().toISOString() },
        },
        this.now(),
        'user-attested',
      );
    });
  }

  /**
   * The user's approval of the exact text, and the write-ahead record that a comment is
   * about to be created. A retry needs a complete comment listing without this note.
   */
  async publishMcp(
    cwd: string,
    noteId: string,
    digest: string,
    listing?: unknown,
  ): Promise<ReleaseNotePublishPayload> {
    const repository = await this.deps.locator.locate(cwd);
    return this.withLock(repository, noteId, async () => {
      let draft = await this.deps.notes.read(repository, noteId);
      const mcp = draft.mcp;
      if (draft.mode !== 'mcp' || !mcp) {
        throw new UsageError(
          `Release note ${noteId} is a manual release note: copy it and paste it into Jira.`,
        );
      }
      if (draft.status === 'FAILED' && draft.failure?.retryable === false) {
        throw new Git2JiraError(
          `Release note ${noteId} failed permanently (${draft.failure.reason}). Prepare a new one.`,
        );
      }
      if (draft.status !== 'READY' && draft.status !== 'FAILED') {
        throw new Git2JiraError(
          draft.status === 'PUBLISHING' || draft.status === 'UNCERTAIN'
            ? `Release note ${noteId} is ${draft.status}: its outcome in Jira is not settled. Run "git2jira release-note reconcile".`
            : `Release note ${noteId} is ${draft.status}; it cannot be published.`,
        );
      }
      if (!draft.rendered || !draft.noteDigest)
        throw new Git2JiraError(`Release note ${noteId} has no finished text.`);
      if (digest !== draft.noteDigest || digest !== releaseNoteDigest(draft, draft.rendered)) {
        throw new ApprovalMismatchError();
      }
      await this.verifyHead(repository, draft);

      if (draft.attempts.length > 0) {
        if (listing === undefined) {
          throw new Git2JiraError(
            `Release note ${noteId} was attempted before. To make sure it is not already in Jira, list ` +
              'the issue comments and pass them with --comments.',
          );
        }
        const found = findInListing(draft, McpReconcileInputSchema.parse(listing));
        if (found.kind === 'found') {
          throw new Git2JiraError(
            `Release note ${noteId} is already in Jira (comment ${found.comment.id}). Run "git2jira release-note reconcile".`,
          );
        }
        if (found.kind === 'incomplete') {
          throw new Git2JiraError(
            `The comment listing is incomplete (${found.reason}); Git2Jira cannot rule out that the release note is already in Jira. Nothing was authorized.`,
          );
        }
      }

      const { failure: _failure, ...rest } = draft;
      draft = await this.deps.notes.transition(
        repository,
        draft,
        {
          ...rest,
          status: 'PUBLISHING',
          attempts: [...draft.attempts, { startedAt: this.now().toISOString() }],
        },
        this.now(),
        'approved by the user',
      );
      return {
        noteId,
        server: mcp.server,
        cloudId: mcp.cloudId,
        issueKey: draft.issueKey,
        tool: ATLASSIAN_TOOLS.writeComment,
        body: { markdown: draft.rendered?.markdown ?? '', adf: draft.rendered?.adf },
        marker: releaseNoteMarker(noteId),
        noteDigest: digest,
      };
    });
  }

  /** Records what the one authorized comment creation call returned. */
  async recordMcpResult(
    cwd: string,
    noteId: string,
    input: unknown,
  ): Promise<ReleaseNoteMcpOutcome> {
    const result = McpWriteResultSchema.parse(input);
    const repository = await this.deps.locator.locate(cwd);
    return this.withLock(repository, noteId, async () => {
      const draft = await this.deps.notes.read(repository, noteId);
      if (draft.status !== 'PUBLISHING') {
        throw new Git2JiraError(
          `Release note ${noteId} is ${draft.status}; no publication is in flight.`,
        );
      }
      if (result.outcome === 'not-called') {
        return this.settle(repository, draft, 'FAILED', `not sent: ${result.reason}`, true);
      }
      if (result.outcome === 'tool-error') {
        const kind = classifyMcpError(result.error);
        const reason = terminalSafeLine(result.error.message, 1000);
        if (kind.delivery === 'rejected') {
          return this.settle(
            repository,
            draft,
            'FAILED',
            `${kind.reason}: ${reason}`,
            kind.retryable,
          );
        }
        return this.settle(repository, draft, 'UNCERTAIN', reason);
      }
      const comment = parseCreatedComment(result.toolResult);
      if (!comment) {
        return this.settle(
          repository,
          draft,
          'UNCERTAIN',
          'the tool result does not contain a readable comment; list the comments and reconcile',
        );
      }
      if (singleNoteMarker(comment.text) !== noteId) {
        return this.settle(
          repository,
          draft,
          'UNCERTAIN',
          `comment ${comment.id} returned by the tool does not carry this release note's marker; list the comments and reconcile`,
        );
      }
      return this.finalize(repository, draft, comment, 'PUBLISHED');
    });
  }

  /**
   * Settles an unknown outcome from a comment listing. Found → RECOVERED. Not found in a
   * complete listing after the settle window → FAILED (retryable). Otherwise UNCERTAIN.
   */
  async reconcileMcp(cwd: string, noteId: string, input: unknown): Promise<ReleaseNoteMcpOutcome> {
    const parsed = McpReconcileInputSchema.parse(input);
    const repository = await this.deps.locator.locate(cwd);
    return this.withLock(repository, noteId, async () => {
      const draft = await this.deps.notes.read(repository, noteId);
      if (!['PUBLISHING', 'UNCERTAIN', 'FAILED'].includes(draft.status)) {
        throw new Git2JiraError(
          `Release note ${noteId} is ${draft.status}; there is nothing to reconcile.`,
        );
      }
      const found = findInListing(draft, parsed);
      if (found.kind === 'found')
        return this.finalize(repository, draft, found.comment, 'RECOVERED');
      if (draft.status === 'FAILED') {
        return {
          state: 'FAILED',
          draft,
          retryable: draft.failure?.retryable ?? true,
          reason: draft.failure?.reason ?? '',
        };
      }
      if (found.kind === 'incomplete')
        return this.settle(repository, draft, 'UNCERTAIN', found.reason);
      const since = draft.attempts.at(-1)?.startedAt ?? draft.updatedAt;
      const age = this.now().getTime() - Date.parse(since);
      if (age < this.settleWindowMs) {
        const wait = this.settleWindowMs - age;
        return this.settle(
          repository,
          draft,
          'UNCERTAIN',
          `not visible yet; Jira may still be processing the request. Check again in ${String(Math.ceil(wait / 1000))} s`,
          true,
          wait,
        );
      }
      return this.settle(
        repository,
        draft,
        'FAILED',
        'not found in a complete comment listing',
        true,
      );
    });
  }

  // ---------------------------------------------------------------------------

  private packageFor(
    repository: RepositoryInfo,
    draft: ReleaseNoteDraft,
    changeSet: ChangeSet,
  ): AnalysisPackage {
    return buildAnalysisPackage({
      reportId: draft.noteId,
      issueKey: draft.issueKey,
      language: draft.language,
      deliveryMode: draft.mode,
      repositoryId: draft.repositoryId,
      repositoryRoot: repository.root,
      branch: draft.branch,
      sequence: 1,
      baseline: {
        kind: 'merge-base',
        baseRef: draft.base.ref,
        baseName: draft.base.name,
        baseCommit: draft.base.commit,
        mergeBase: draft.base.mergeBase,
        tree: draft.base.tree,
      },
      snapshot: {
        tree: draft.head.tree,
        commit: draft.head.commit,
        headCommit: draft.head.commit,
        branch: draft.branch,
        capturedAt: draft.createdAt,
        includesUncommittedChanges: false,
      },
      changeSet,
      issue: draft.issueContext,
    });
  }

  private changeSetOf(repository: RepositoryInfo, draft: ReleaseNoteDraft): Promise<ChangeSet> {
    return this.deps.diff.diff(
      repository,
      {
        baseTree: draft.base.tree,
        targetTree: draft.head.tree,
        fromCommit: draft.base.mergeBase,
        toCommit: draft.head.commit,
      },
      reportDiffOptions(),
    );
  }

  /** Confirmed reports of the issue, as context for the writer. Model-written: redacted data. */
  private async earlierReports(
    repository: RepositoryInfo,
    issueKey: string,
  ): Promise<EarlierReport[]> {
    const drafts = await this.deps.reports.list(repository).catch(() => []);
    const clean = (text: string, max: number) => redactSecrets(text).text.slice(0, max);
    return drafts
      .filter(
        (d) =>
          d.issueKey === issueKey &&
          d.report !== undefined &&
          ['MANUALLY_CONFIRMED', 'PUBLISHED', 'RECOVERED'].includes(d.status),
      )
      .sort((a, b) => a.sequence - b.sequence)
      .slice(-20)
      .map((d) => {
        const report = d.report;
        const work =
          report === undefined
            ? []
            : report.schemaVersion === 2
              ? report.completedWork.map((w) => `${w.subject}: ${w.description}`)
              : report.changes.map((c) => `${c.subject}: ${c.description}`);
        return {
          sequence: d.sequence,
          summary: clean(report?.summary ?? '', 2000),
          work: work.slice(0, 50).map((w) => clean(w, 2200)),
        };
      });
  }

  /** The release note describes HEAD as it was; new commits need a new release note. */
  private async verifyHead(repository: RepositoryInfo, draft: ReleaseNoteDraft): Promise<void> {
    const identity = await this.deps.store.repositoryIdentity(repository);
    if (identity.id !== draft.repositoryId) {
      throw new PublicationMismatchError('the release note was prepared in a different repository');
    }
    if (repository.headCommit !== draft.head.commit) {
      throw new PublicationMismatchError(
        'there are new commits since the release note was prepared (or HEAD moved); cancel it and prepare it again',
      );
    }
    const files: ReportFile[] = (await this.changeSetOf(repository, draft)).files.map(toReportFile);
    if (changesDigest(files) !== draft.changesDigest) {
      throw new PublicationMismatchError(
        'the changed files differ from the previewed release note',
      );
    }
  }

  private async finalize(
    repository: RepositoryInfo,
    draft: ReleaseNoteDraft,
    comment: ParsedComment,
    state: 'PUBLISHED' | 'RECOVERED',
  ): Promise<ReleaseNoteMcpOutcome> {
    const url = commentUrl(draft.site, draft.issueKey, comment.id);
    const attempts =
      draft.attempts.length > 0 ? draft.attempts : [{ startedAt: this.now().toISOString() }];
    const last = attempts.at(-1) ?? { startedAt: this.now().toISOString() };
    const { failure: _failure, ...rest } = draft;
    const settled = await this.deps.notes.transition(
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
          publishedAt: isoTime(comment.created, this.now()),
          evidence: state === 'PUBLISHED' ? 'tool-result' : 'read-back',
        },
      },
      this.now(),
    );
    return { state, draft: settled, commentId: comment.id, commentUrl: url };
  }

  private async settle(
    repository: RepositoryInfo,
    draft: ReleaseNoteDraft,
    status: 'FAILED' | 'UNCERTAIN',
    reason: string,
    retryable = true,
    retryAfterMs = this.settleWindowMs,
  ): Promise<ReleaseNoteMcpOutcome> {
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
    const next = await this.deps.notes.transition(
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

  private withLock<T>(
    repository: RepositoryInfo,
    noteId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const file = path.join(stateDir(repository), 'locks', `release-note-${noteId}.lock`);
    return withFileLock(file, fn, { timeoutMs: 60_000, ...this.deps.lockOptions });
  }
}

/** Approval digest: binds the exact texts to the exact issue, site, and commits. */
export function releaseNoteDigest(
  draft: Pick<ReleaseNoteDraft, 'site' | 'issueKey' | 'noteId' | 'base' | 'head'>,
  rendered: { markdown: string; text: string; adf: unknown },
): string {
  return sha256(
    canonicalJson({
      v: 1,
      kind: 'release-note',
      siteId: draft.site.id,
      issueKey: draft.issueKey,
      noteId: draft.noteId,
      mergeBase: draft.base.mergeBase,
      baseTree: draft.base.tree,
      headCommit: draft.head.commit,
      headTree: draft.head.tree,
      markdown: rendered.markdown,
      text: rendered.text,
      adf: rendered.adf,
    }),
  );
}

/** The release note id in a comment, trusted only when there is exactly one marker. */
export function singleNoteMarker(text: string): string | undefined {
  const markers = findReleaseNoteMarkers(text);
  return markers.length === 1 ? markers[0] : undefined;
}

function findInListing(
  draft: ReleaseNoteDraft,
  input: { comments: unknown; account?: unknown },
):
  | { kind: 'found'; comment: ParsedComment }
  | { kind: 'absent' }
  | { kind: 'incomplete'; reason: string } {
  const listing = parseCommentListing(input.comments);
  const accountId = input.account === undefined ? undefined : parseAccountId(input.account);
  if (input.account !== undefined && accountId === undefined) {
    return { kind: 'incomplete', reason: 'the account information could not be read' };
  }
  // Only the signed-in account's comments count when it is known: anyone can paste a marker.
  const [first] = listing.comments
    .filter((c) => singleNoteMarker(c.text) === draft.noteId)
    .filter((c) => accountId === undefined || c.authorAccountId === accountId)
    .sort(
      (a, b) => (a.created ?? '').localeCompare(b.created ?? '') || Number(a.id) - Number(b.id),
    );
  if (first) return { kind: 'found', comment: first };
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

function isoTime(value: string | undefined, fallback: Date): string {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? fallback.toISOString() : new Date(parsed).toISOString();
}
