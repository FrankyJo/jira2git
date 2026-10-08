import type { AdfDocument } from '../adf/types';
import type { Checkpoint } from '../checkpoints/types';
import type { IssueKey, RepositoryInfo } from '../git/types';
import type { StructuredReport } from '../report/schema';
import type { Snapshot } from '../snapshots/types';

/**
 * Publication lifecycle (Phase 2). Each transition is deterministic code, not
 * model output:
 *
 *   prepared → approved → publishing → published (checkpoint written)
 *                       ↘ failed (no checkpoint; safe to retry)
 *   prepared → rejected  (nothing sent)
 *
 * Before the Jira write, a `publishing` journal entry is recorded so that a
 * crash between "comment created" and "checkpoint saved" can be reconciled by
 * `git2jira recover` instead of creating a duplicate comment.
 */
export type PublicationState =
  'prepared' | 'approved' | 'publishing' | 'published' | 'failed' | 'rejected';

export interface PublicationPlan {
  id: string;
  repository: RepositoryInfo;
  issueKey: IssueKey;
  sequence: number;
  baseSnapshot: Snapshot | null;
  targetSnapshot: Snapshot;
  report: StructuredReport;
  document: AdfDocument;
  /** SHA-256 of the canonical report; approval is bound to this exact content. */
  reportDigest: string;
}

/** Proof of explicit user approval for one specific plan and digest. */
export interface PublicationApproval {
  planId: string;
  reportDigest: string;
  approvedAt: string;
}

export type PublicationOutcome =
  | { state: 'published'; checkpoint: Checkpoint; commentUrl: string }
  | { state: 'failed'; error: Error; retryable: boolean }
  | { state: 'nothing-to-publish' };

export interface PublicationService {
  /** Publishes only when `approval` matches the plan id and digest. */
  publish(plan: PublicationPlan, approval: PublicationApproval): Promise<PublicationOutcome>;
}

/** Report history and recovery from local journal and Jira comment footers. */
export interface ReportHistory {
  list(repository: RepositoryInfo, issueKey: IssueKey): Promise<Checkpoint[]>;
  /** Reconciles interrupted publications and lost checkpoints. */
  recover(repository: RepositoryInfo, issueKey: IssueKey): Promise<RecoveryResult>;
}

export interface RecoveryResult {
  restoredCheckpoints: number;
  unresolvedPublications: string[];
}
