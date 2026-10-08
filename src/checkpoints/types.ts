import { z } from 'zod';
import { IssueKeySchema } from '../git/types';
import { ObjectIdSchema, SnapshotSchema } from '../snapshots/types';

/**
 * Jira site identity. `id` is derived from the normalized origin and is used
 * in ref and file names, so checkpoints for different sites never mix.
 */
export const JiraSiteSchema = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
  id: z.string().regex(/^[0-9a-f]{16}$/),
});

/** Random id created once per repository (shared by its worktrees). */
export const RepositoryIdentitySchema = z.strictObject({
  id: z.uuid(),
});

export const BranchIdentitySchema = z.strictObject({
  name: z.string().min(1),
  ref: z.string().startsWith('refs/heads/'),
});

/** What a report was compared against. */
export const BaselineSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('merge-base'),
    baseRef: z.string().min(1),
    baseName: z.string().min(1),
    baseCommit: ObjectIdSchema,
    mergeBase: ObjectIdSchema,
    tree: ObjectIdSchema,
  }),
  z.strictObject({
    /** Unborn branch: everything in the working tree is new. */
    kind: z.literal('empty'),
    tree: ObjectIdSchema,
  }),
  z.strictObject({
    kind: z.literal('checkpoint'),
    reportId: z.uuid(),
    sequence: z.int().positive(),
    tree: ObjectIdSchema,
    /** HEAD when the previous snapshot was captured; start of the commit range. */
    headCommit: ObjectIdSchema.nullable(),
  }),
]);

/**
 * - `publishing`: about to call Jira, outcome unknown until confirmed or resolved.
 * - `confirmed`: Jira returned the comment; checkpoint not promoted yet.
 * - `published`: checkpoint ref written; this is the new baseline.
 * - `failed`: Jira definitely did not create the comment; the snapshot is kept so the
 *   same approved report can be retried. Does not block new reports.
 * - `cancelled`: definitely not published and abandoned; baseline unchanged.
 * - `revoked`: was published by user attestation (manual mode), then withdrawn by the user
 *   because the attestation was a mistake. Its checkpoint ref is gone; the baseline is the
 *   previous checkpoint again. The record stays for audit and can be confirmed again.
 */
export const PublicationStateSchema = z.enum([
  'publishing',
  'confirmed',
  'published',
  'failed',
  'cancelled',
  'revoked',
]);

/**
 * How a publication was established. Absent on records written before Phase 2.5,
 * which were all confirmed through the Jira REST API.
 * - `jira-api`: Git2Jira's own Jira client received the created comment.
 * - `mcp-tool`: the Claude Code session relayed an Atlassian MCP tool result that the
 *   CLI validated (comment id and report marker). Not independently fetched by the CLI.
 * - `user-attested`: the user stated that they pasted the report into Jira (manual mode).
 *   Nothing was verified against Jira.
 */
export const ConfirmationMethodSchema = z.enum(['jira-api', 'mcp-tool', 'user-attested']);

export const ReportRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  reportId: z.uuid(),
  sequence: z.int().positive(),
  site: JiraSiteSchema,
  issueKey: IssueKeySchema,
  repository: RepositoryIdentitySchema,
  branch: BranchIdentitySchema,
  baseline: BaselineSchema,
  snapshot: SnapshotSchema,
  /** Candidate ref holding the snapshot until it is promoted. */
  snapshotRef: z.string().startsWith('refs/git2jira/'),
  state: PublicationStateSchema,
  /** SHA-256 of the canonical report that was approved for publication. */
  reportDigest: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  publication: z
    .strictObject({
      /** Absent for manual publications: Git2Jira never learns the comment id. */
      commentId: z.string().min(1).optional(),
      publishedAt: z.iso.datetime(),
      confirmedBy: ConfirmationMethodSchema.optional(),
    })
    .optional(),
  /** Set when a user-attested publication was withdrawn (state `revoked`). */
  revocation: z
    .strictObject({ revokedAt: z.iso.datetime(), reason: z.string().max(500) })
    .optional(),
  /** Durable ref (and its commit) that keeps the published snapshot alive. */
  checkpointRef: z.string().startsWith('refs/git2jira/').optional(),
  checkpointCommit: ObjectIdSchema.optional(),
});

/** All reports for one (repository, Jira site, issue) lineage. Append-only. */
export const LineageJournalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  site: JiraSiteSchema,
  issueKey: IssueKeySchema,
  repository: RepositoryIdentitySchema,
  records: z.array(ReportRecordSchema),
});

export type JiraSite = z.infer<typeof JiraSiteSchema>;
export type RepositoryIdentity = z.infer<typeof RepositoryIdentitySchema>;
export type BranchIdentity = z.infer<typeof BranchIdentitySchema>;
export type Baseline = z.infer<typeof BaselineSchema>;
export type PublicationState = z.infer<typeof PublicationStateSchema>;
export type ConfirmationMethod = z.infer<typeof ConfirmationMethodSchema>;
export type ReportRecord = z.infer<typeof ReportRecordSchema>;
export type LineageJournal = z.infer<typeof LineageJournalSchema>;

/** A report whose checkpoint has been promoted: the baseline for the next report. */
export type Checkpoint = ReportRecord & {
  state: 'published';
  publication: NonNullable<ReportRecord['publication']>;
  checkpointRef: string;
  checkpointCommit: string;
};

export function isCheckpoint(record: ReportRecord): record is Checkpoint {
  return (
    record.state === 'published' &&
    record.publication !== undefined &&
    record.checkpointRef !== undefined &&
    record.checkpointCommit !== undefined
  );
}

export function latestCheckpoint(journal: LineageJournal | undefined): Checkpoint | undefined {
  return journal?.records.filter(isCheckpoint).sort((a, b) => b.sequence - a.sequence)[0];
}

export function unresolvedRecords(journal: LineageJournal | undefined): ReportRecord[] {
  return journal?.records.filter((r) => r.state === 'publishing' || r.state === 'confirmed') ?? [];
}
