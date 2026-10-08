import type { AdfDocument } from '../adf/types';
import type { Checkpoint } from '../checkpoints/types';
import type { StructuredReport } from '../report/schema';
import type { PreparedReport } from './lifecycle';

/**
 * Jira publication (Phase 2), built on PublicationLifecycle:
 *
 *   prepare → (AI report, preview, approval) → beginPublication → POST comment
 *     → confirmPublication (checkpoint promoted)
 *     ↘ failure before the request was sent → resolvePending({ published: false })
 *     ↘ unknown outcome (crash, timeout) → recover + Jira lookup → resolvePending
 *   prepare → user rejects → cancel (baseline unchanged)
 */
export interface PublicationPlan {
  prepared: PreparedReport;
  report: StructuredReport;
  document: AdfDocument;
  /** SHA-256 of the canonical report; approval is bound to this exact content. */
  reportDigest: string;
}

/** Proof of explicit user approval for one specific plan and digest. */
export interface PublicationApproval {
  reportId: string;
  reportDigest: string;
  approvedAt: string;
}

export type PublicationOutcome =
  | { state: 'published'; checkpoint: Checkpoint; commentUrl: string }
  | { state: 'failed'; error: Error; retryable: boolean };

export interface PublicationService {
  /** Publishes only when `approval` matches the plan's report id and digest. */
  publish(plan: PublicationPlan, approval: PublicationApproval): Promise<PublicationOutcome>;
}
