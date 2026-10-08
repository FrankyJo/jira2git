import { z } from 'zod';
import { IssueKeySchema, type IssueKey, type RepositoryInfo } from '../git/types';
import { LanguageSchema } from '../localization/languages';
import { SnapshotSchema } from '../snapshots/types';

/**
 * Written only after Jira confirms a comment was created. The next report is
 * computed against `snapshot`. Stored below the Git common directory
 * (`<commonDir>/git2jira/`), never in the working tree. Implemented in Phase 1.
 */
export const CheckpointSchema = z.strictObject({
  schemaVersion: z.literal(1),
  issueKey: IssueKeySchema,
  /** Monotonic report number per issue, starting at 1. */
  sequence: z.int().positive(),
  snapshot: SnapshotSchema,
  publication: z.strictObject({
    siteUrl: z.url(),
    commentId: z.string().min(1),
    publishedAt: z.iso.datetime(),
  }),
  language: LanguageSchema,
  /** SHA-256 of the canonical structured report that was published. */
  reportDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;

export interface CheckpointStore {
  latest(repository: RepositoryInfo, issueKey: IssueKey): Promise<Checkpoint | undefined>;
  list(repository: RepositoryInfo, issueKey: IssueKey): Promise<Checkpoint[]>;
  /** Atomically appends a checkpoint. Rejects a sequence that is not `latest + 1`. */
  append(repository: RepositoryInfo, checkpoint: Checkpoint): Promise<void>;
}
