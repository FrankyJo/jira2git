import type { AdfDocument } from '../adf/types';
import type { Checkpoint, JiraSite, ReportRecord } from '../checkpoints/types';
import type { IssueKey } from '../git/types';
import type { JiraIssue } from '../jira/client/types';
import type { SelectionReason } from '../jira/connections';
import type { Language } from '../localization/languages';
import type { ChangeSet, DiffOptions } from '../snapshots/types';
import type { Analysis } from './lifecycle';
import type { StoredPlan } from './plan';
import type { RemoteReport } from './remote-history';

/**
 * Jira publication on top of PublicationLifecycle:
 *
 *   prepare (DRAFT) → review (READY_FOR_REVIEW) → approve (APPROVED)
 *     → publish: checks → journal "publishing" → POST comment
 *         → PUBLISHED (checkpoint promoted) | FAILED (definitely not created)
 *         | UNCERTAIN (outcome unknown) → recover → RECOVERED | FAILED
 */
export interface TargetSelection {
  cwd: string;
  /** `--issue` */
  issue?: string | undefined;
  /** `issue.projectKeys` from repository configuration. */
  projectKeys?: readonly string[] | undefined;
  /** `--connection` */
  connection?: string | undefined;
  /** `--site` */
  site?: string | undefined;
  /** `jira.site` from repository configuration. */
  repositorySite?: string | undefined;
}

export interface PrepareRequest extends TargetSelection {
  language: Language;
  base?: string | undefined;
  configuredBase?: string | undefined;
  acceptBranchChange?: boolean | undefined;
  diffOptions?: Partial<DiffOptions> | undefined;
  /** `report.includeUncommitted`; true when absent. */
  includeUncommitted?: boolean | undefined;
}

export type PrepareOutcome =
  | {
      status: 'prepared';
      plan: StoredPlan;
      /** Verified issue, including its (untrusted) description for the AI layer. */
      issue: JiraIssue;
      changeSet: ChangeSet;
      connectionReason: SelectionReason;
    }
  | { status: 'no-changes'; analysis: Analysis };

export interface ReviewResult {
  plan: StoredPlan;
  document: AdfDocument;
  reportDigest: string;
}

export type PublicationOutcome =
  | {
      state: 'PUBLISHED' | 'RECOVERED';
      plan: StoredPlan;
      commentId: string;
      commentUrl: string;
      /** Undefined when promotion failed; `recover` finishes it. */
      checkpoint: Checkpoint | undefined;
      propertyStored: boolean;
      duplicateCommentIds: string[];
      /** Set when the checkpoint could not be promoted yet. */
      warning?: string;
    }
  | { state: 'FAILED'; plan: StoredPlan; error: Error; retryable: boolean }
  | { state: 'UNCERTAIN'; plan: StoredPlan; error: Error; retryAfterMs: number };

export type RecoveryAction =
  | { kind: 'recovered'; reportId: string; sequence: number; commentId: string; commentUrl: string }
  | { kind: 'not-published'; reportId: string; sequence: number }
  | { kind: 'still-uncertain'; reportId: string; sequence: number; reason: string }
  | { kind: 'promoted'; reportId: string }
  | { kind: 'property-restored'; reportId: string; commentId: string }
  | { kind: 'plan-synced'; reportId: string; status: string }
  | { kind: 'duplicate'; reportId: string; commentIds: string[] }
  | { kind: 'remote-only'; reportId: string; commentId: string; sequence: number }
  | { kind: 'missing-in-jira'; reportId: string; commentId: string }
  | { kind: 'rebuilt-journal' }
  | { kind: 'quarantined'; file: string }
  | { kind: 'removed-candidate'; ref: string }
  | { kind: 'unreadable-ref'; ref: string };

export interface RecoverySummary {
  site: JiraSite;
  issueKey: IssueKey;
  actions: RecoveryAction[];
  /** Set when Jira could not be consulted; local repairs still happened. */
  remoteError?: string;
}

export interface HistoryEntry {
  record: ReportRecord;
  plan: StoredPlan | undefined;
  commentUrl: string | undefined;
  /** Whether the comment was seen in Jira; undefined when Jira was not checked. */
  inJira: boolean | undefined;
}

export interface HistoryView {
  site: JiraSite;
  issueKey: IssueKey;
  entries: HistoryEntry[];
  /** Plans that never reached the journal (not yet published). */
  openPlans: StoredPlan[];
  remote?: { complete: boolean; reports: RemoteReport[]; error?: string };
}
