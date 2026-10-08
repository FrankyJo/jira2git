import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AdfDocumentSchema } from '../adf/validate';
import { BaselineSchema, BranchIdentitySchema, JiraSiteSchema } from '../checkpoints/types';
import { CheckpointCorruptedError } from '../checkpoints/errors';
import { ConnectionNameSchema } from '../config/schema';
import { Git2JiraError } from '../core/errors';
import { IssueKeySchema, type RepositoryInfo } from '../git/types';
import { LanguageSchema } from '../localization/languages';
import { StoredReportSchema } from '../report/schema';
import { stateDir } from '../snapshots/engine';
import { SnapshotSchema } from '../snapshots/types';

/**
 * User-visible publication state machine. One plan per report id:
 *
 *   DRAFT ─► READY_FOR_REVIEW ─► APPROVED ─► PUBLISHING ─► PUBLISHED
 *               ▲    │  ▲            │            ├─► FAILED ─► PUBLISHING (retry)
 *               └────┘  └────────────┘            └─► UNCERTAIN ─► RECOVERED | FAILED
 *
 * - DRAFT: snapshot captured, issue verified, no report yet.
 * - READY_FOR_REVIEW: report rendered to ADF, validated, digest computed.
 * - APPROVED: the user approved exactly that digest. Changing the report goes back to review.
 * - PUBLISHING: journal record written, comment request in flight (or the process died).
 * - PUBLISHED: Jira returned the comment id; checkpoint promoted.
 * - FAILED: Jira definitely did not create the comment.
 * - UNCERTAIN: the outcome could not be established; never retried blindly.
 * - RECOVERED: an uncertain or interrupted publication was found in Jira and reconciled.
 */
export const PUBLICATION_STATUSES = [
  'DRAFT',
  'READY_FOR_REVIEW',
  'APPROVED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'UNCERTAIN',
  'RECOVERED',
] as const;

export const PublicationStatusSchema = z.enum(PUBLICATION_STATUSES);
export type PublicationStatus = z.infer<typeof PublicationStatusSchema>;

const TRANSITIONS: Readonly<Record<PublicationStatus, readonly PublicationStatus[]>> = {
  DRAFT: ['READY_FOR_REVIEW'],
  READY_FOR_REVIEW: ['READY_FOR_REVIEW', 'APPROVED'],
  // Recovery may settle a plan whose process died right after the journal entry was written.
  APPROVED: ['READY_FOR_REVIEW', 'PUBLISHING', 'UNCERTAIN', 'FAILED', 'RECOVERED'],
  PUBLISHING: ['PUBLISHED', 'FAILED', 'UNCERTAIN', 'RECOVERED'],
  UNCERTAIN: ['UNCERTAIN', 'RECOVERED', 'FAILED'],
  // A retry that was interrupted is settled like a first attempt.
  FAILED: ['PUBLISHING', 'FAILED', 'UNCERTAIN', 'RECOVERED'],
  PUBLISHED: [],
  RECOVERED: [],
};

export const TERMINAL_STATUSES: readonly PublicationStatus[] = ['PUBLISHED', 'RECOVERED'];

export class InvalidTransitionError extends Git2JiraError {
  constructor(reportId: string, from: PublicationStatus, to: PublicationStatus) {
    super(`Report ${reportId} cannot go from ${from} to ${to}.`);
  }
}

export function canTransition(from: PublicationStatus, to: PublicationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const ReportFileSchema = z.strictObject({
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'type-changed']),
  path: z.string().min(1),
  previousPath: z.string().min(1).optional(),
});

export const PublicationAttemptSchema = z.strictObject({
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  result: z.enum(['published', 'failed', 'uncertain', 'recovered']).optional(),
  /** Sanitized error message; never contains credentials. */
  error: z.string().max(2000).optional(),
});

export const StoredPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  reportId: z.uuid(),
  status: PublicationStatusSchema,
  connection: ConnectionNameSchema,
  site: JiraSiteSchema,
  issueKey: IssueKeySchema,
  /** Issue as verified in Jira when the report was prepared. */
  issue: z.strictObject({ id: z.string().min(1), summary: z.string().max(2000) }),
  repositoryId: z.uuid(),
  branch: BranchIdentitySchema,
  baseline: BaselineSchema,
  snapshot: SnapshotSchema,
  snapshotRef: z.string().startsWith('refs/git2jira/'),
  sequence: z.int().positive(),
  language: LanguageSchema,
  /** Changed paths from Git, shown in the preview and rendered into the comment. */
  files: z.array(ReportFileSchema),
  changesDigest: DigestSchema,
  report: StoredReportSchema.optional(),
  document: AdfDocumentSchema.optional(),
  reportDigest: DigestSchema.optional(),
  approval: z.strictObject({ reportDigest: DigestSchema, approvedAt: z.iso.datetime() }).optional(),
  attempts: z.array(PublicationAttemptSchema),
  failure: z.strictObject({ retryable: z.boolean(), reason: z.string().max(2000) }).optional(),
  publication: z
    .strictObject({
      commentId: z.string().regex(/^[0-9]+$/),
      commentUrl: z.url(),
      publishedAt: z.iso.datetime(),
      /** Whether the metadata comment property is confirmed to be stored in Jira. */
      propertyStored: z.boolean(),
    })
    .optional(),
  /** Other comments in Jira that carry this report id (cannot be deleted by Git2Jira). */
  duplicateCommentIds: z.array(z.string()).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type StoredPlan = z.infer<typeof StoredPlanSchema>;
export type PublicationAttempt = z.infer<typeof PublicationAttemptSchema>;

export class PlanNotFoundError extends Git2JiraError {
  constructor(reportId: string) {
    super(`No prepared report ${reportId} exists in this repository.`);
  }
}

/** Plans live in `<git common dir>/git2jira/plans/<reportId>.json`, outside the working tree. */
export class PlanStore {
  private dir(repository: RepositoryInfo): string {
    return path.join(stateDir(repository), 'plans');
  }

  private file(repository: RepositoryInfo, reportId: string): string {
    return path.join(this.dir(repository), `${z.uuid().parse(reportId)}.json`);
  }

  async read(repository: RepositoryInfo, reportId: string): Promise<StoredPlan> {
    const plan = await this.readOptional(repository, reportId);
    if (!plan) throw new PlanNotFoundError(reportId);
    return plan;
  }

  async readOptional(
    repository: RepositoryInfo,
    reportId: string,
  ): Promise<StoredPlan | undefined> {
    if (!z.uuid().safeParse(reportId).success) return undefined;
    const file = this.file(repository, reportId);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new CheckpointCorruptedError(file, 'invalid JSON');
    }
    const parsed = StoredPlanSchema.safeParse(json);
    if (!parsed.success || parsed.data.reportId !== reportId) {
      throw new CheckpointCorruptedError(file, 'invalid publication plan');
    }
    return parsed.data;
  }

  async write(repository: RepositoryInfo, plan: StoredPlan): Promise<void> {
    const file = this.file(repository, plan.reportId);
    const validated = StoredPlanSchema.parse(plan);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  }

  /** Writes `next` if the state machine allows moving from `current.status` to `next.status`. */
  async transition(
    repository: RepositoryInfo,
    current: StoredPlan,
    next: StoredPlan,
    now: Date,
  ): Promise<StoredPlan> {
    if (!canTransition(current.status, next.status))
      throw new InvalidTransitionError(current.reportId, current.status, next.status);
    const updated: StoredPlan = { ...next, updatedAt: now.toISOString() };
    await this.write(repository, updated);
    return updated;
  }

  async list(repository: RepositoryInfo): Promise<StoredPlan[]> {
    let names: string[];
    try {
      names = await readdir(this.dir(repository));
    } catch {
      return [];
    }
    const plans: StoredPlan[] = [];
    for (const name of names) {
      const id = /^([0-9a-f-]{36})\.json$/.exec(name)?.[1];
      if (!id) continue;
      const plan = await this.readOptional(repository, id).catch(() => undefined);
      if (plan) plans.push(plan);
    }
    return plans.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async delete(repository: RepositoryInfo, reportId: string): Promise<void> {
    await rm(this.file(repository, reportId), { force: true });
  }
}
