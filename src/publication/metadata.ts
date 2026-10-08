import { z } from 'zod';
import { IssueKeySchema } from '../git/types';
import { LanguageSchema } from '../localization/languages';
import { ObjectIdSchema } from '../snapshots/types';

/** Comment property key under which Git2Jira stores report metadata. */
export const REPORT_PROPERTY_KEY = 'git2jira.report';

/**
 * Stored as a Jira comment property on every published report. It links the
 * comment to its Git snapshot without exposing anything secret: random ids,
 * Git object ids, the digest, and the language. Values read back from Jira
 * are untrusted and validated.
 */
export const ReportMetadataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  reportId: z.uuid(),
  sequence: z.int().positive(),
  issueKey: IssueKeySchema,
  siteId: z.string().regex(/^[0-9a-f]{16}$/),
  repositoryId: z.uuid(),
  baseTree: ObjectIdSchema,
  targetTree: ObjectIdSchema,
  snapshotCommit: ObjectIdSchema,
  reportDigest: z.string().regex(/^[0-9a-f]{64}$/),
  language: LanguageSchema,
  toolVersion: z.string().min(1).max(64),
});

export type ReportMetadata = z.infer<typeof ReportMetadataSchema>;
