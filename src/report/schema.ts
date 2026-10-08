import { z } from 'zod';
import { IssueKeySchema } from '../git/types';
import { LanguageSchema } from '../localization/languages';

/**
 * Structured report: one language-independent contract for every language and
 * delivery mode. Free-text fields are written in `language`; section headings come
 * from the localization catalog at render time. Paths, identifiers, and endpoints
 * are kept verbatim. Size limits bound what an untrusted model output can push
 * into Jira.
 *
 * Two layers:
 * - `ReportContentSchema`: what the report writer (the model) produces.
 * - `StructuredReportSchema`: the finished report. The CLI adds the fields it owns
 *   (`reportId`, `snapshotIdentity`, `changeCoverage`) and replaces the file lists
 *   with Git's, keeping the writer's notes only for paths Git confirms
 *   (`finalizeReport`, src/report/validate.ts).
 */
const Text = z.string().trim().min(1).max(2000);
const Note = z.string().trim().min(1).max(500);
const FilePath = z.string().min(1).max(500);
const ObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const ChangeKindSchema = z.enum(['added', 'modified', 'removed', 'refactored', 'fixed']);

/** What a piece of work is about; used for ordering and de-duplication, not rendered. */
export const WorkCategorySchema = z.enum([
  'feature',
  'bug-fix',
  'ui',
  'api-integration',
  'business-logic',
  'state-management',
  'routing',
  'forms-validation',
  'refactoring',
  'performance',
  'error-handling',
  'testing',
  'configuration',
  'build',
  'documentation',
  'removal',
  'other',
]);

export const HttpMethodSchema = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

export const EndpointSchema = z.strictObject({
  method: HttpMethodSchema.optional(),
  endpoint: z.string().trim().min(1).max(500),
});

export const CompletedWorkSchema = z.strictObject({
  kind: ChangeKindSchema,
  category: WorkCategorySchema,
  /** Component, module, or feature name, verbatim from the code. */
  subject: z.string().trim().min(1).max(200),
  description: Text,
  /** Changed paths this work is about; must belong to the change set. */
  files: z.array(FilePath).max(100),
  endpoints: z.array(EndpointSchema).max(20).default([]),
});

export const FileNoteSchema = z.strictObject({ path: FilePath, note: Note.optional() });
export const RenamedFileSchema = z.strictObject({
  from: FilePath,
  to: FilePath,
  note: Note.optional(),
});

/**
 * Test status is decided by evidence the CLI holds (tests it ran, or results handed to
 * it), never by the writer: `not-run` when there is none. `reported` marks testing notes
 * from a v1 report, which carried no evidence: shown as unverified statements.
 */
export const TestStatusSchema = z.enum(['passed', 'failed', 'partial', 'not-run', 'reported']);

export const ReportTestingSchema = z.strictObject({
  status: TestStatusSchema,
  /** What the evidence shows. Must be empty when no tests were run. */
  notes: z.array(Text).max(20).default([]),
  /** Echo of the CLI's runs (optional); must match them when present. */
  runs: z
    .array(
      z.strictObject({
        command: z.string().trim().min(1).max(500),
        outcome: z.enum(['passed', 'failed', 'error', 'timed-out']),
        source: z.enum(['git2jira', 'reported']),
      }),
    )
    .max(20)
    .optional(),
});

/** A test run behind the status, as recorded by the CLI. Commands are shown verbatim. */
export const TestRunSchema = z.strictObject({
  command: z.string().trim().min(1).max(500),
  outcome: z.enum(['passed', 'failed', 'error', 'timed-out']),
  source: z.enum(['git2jira', 'reported']),
});

/** Finished testing section: the writer's notes plus the CLI's runs. */
export const FinalTestingSchema = z.strictObject({
  status: TestStatusSchema,
  notes: z.array(Text).max(20),
  runs: z.array(TestRunSchema).max(20),
});

export const OmittedFileSchema = z.strictObject({
  path: FilePath,
  reason: z.enum(['sensitive', 'excluded', 'binary', 'too-large', 'budget', 'not-in-diff']),
});

/** How much of the change set the writer actually saw. Computed by the CLI. */
export const ChangeCoverageSchema = z.strictObject({
  totalFiles: z.int().nonnegative(),
  /** Files whose complete diff (or metadata, for binaries and pure renames) was analyzed. */
  analyzedFiles: z.int().nonnegative(),
  /** Files whose diff was cut short. */
  truncatedFiles: z.array(FilePath),
  omittedFiles: z.array(OmittedFileSchema),
  /** Noise excluded by policy (lock files, minified output); does not affect `complete`. */
  ignoredFiles: z.array(FilePath),
  chunks: z.int().positive(),
  complete: z.boolean(),
});

/** Which snapshot pair the report describes. Computed by the CLI. */
export const SnapshotIdentitySchema = z.strictObject({
  sequence: z.int().positive(),
  baselineKind: z.enum(['merge-base', 'empty', 'checkpoint']),
  baseTree: ObjectId,
  targetTree: ObjectId,
  snapshotCommit: ObjectId,
});

const ContentFields = {
  issueKey: IssueKeySchema,
  language: LanguageSchema,
  summary: Text,
  completedWork: z.array(CompletedWorkSchema).min(1).max(50),
  createdFiles: z.array(FileNoteSchema).max(2000).default([]),
  modifiedFiles: z.array(FileNoteSchema).max(2000).default([]),
  deletedFiles: z.array(FileNoteSchema).max(2000).default([]),
  renamedFiles: z.array(RenamedFileSchema).max(2000).default([]),
  testing: ReportTestingSchema.default({ status: 'not-run', notes: [] }),
  limitations: z.array(Text).max(20).default([]),
  /** What the writer could not determine from the diff. Shown in the preview, not in Jira. */
  uncertainties: z.array(Text).max(20).default([]),
};

/**
 * What the writer returns. The CLI-owned fields may be echoed back; when present they
 * must equal the CLI's values.
 */
export const ReportContentSchema = z.strictObject({
  schemaVersion: z.literal(2),
  ...ContentFields,
  reportId: z.uuid().optional(),
  snapshotIdentity: SnapshotIdentitySchema.optional(),
  changeCoverage: ChangeCoverageSchema.optional(),
});

export const StructuredReportSchema = z.strictObject({
  schemaVersion: z.literal(2),
  reportId: z.uuid(),
  ...ContentFields,
  testing: FinalTestingSchema,
  changeCoverage: ChangeCoverageSchema,
  snapshotIdentity: SnapshotIdentitySchema,
});

/** Phase 2/2.5 report format, still accepted by `report submit` and upgraded on read. */
export const StructuredReportV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  issueKey: IssueKeySchema,
  language: LanguageSchema,
  summary: Text,
  changes: z
    .array(
      z.strictObject({
        kind: ChangeKindSchema,
        subject: z.string().trim().min(1).max(200),
        description: Text,
        files: z.array(FilePath).max(100),
      }),
    )
    .min(1)
    .max(50),
  apiChanges: z
    .array(
      z.strictObject({
        kind: ChangeKindSchema,
        method: HttpMethodSchema.optional(),
        endpoint: z.string().trim().min(1).max(500),
        description: Text,
      }),
    )
    .max(50)
    .default([]),
  testing: z.array(Text).max(20).default([]),
  risks: z.array(Text).max(20).default([]),
  followUps: z.array(Text).max(20).default([]),
});

/** A report as stored in drafts and plans: v2, or v1 from before Phase 3 (display only). */
export const StoredReportSchema = z.union([StructuredReportSchema, StructuredReportV1Schema]);

export type ChangeKind = z.infer<typeof ChangeKindSchema>;
export type WorkCategory = z.infer<typeof WorkCategorySchema>;
export type CompletedWork = z.infer<typeof CompletedWorkSchema>;
export type FileNote = z.infer<typeof FileNoteSchema>;
export type RenamedFile = z.infer<typeof RenamedFileSchema>;
export type TestStatus = z.infer<typeof TestStatusSchema>;
export type TestRun = z.infer<typeof TestRunSchema>;
export type ChangeCoverage = z.infer<typeof ChangeCoverageSchema>;
export type OmittedFile = z.infer<typeof OmittedFileSchema>;
export type SnapshotIdentity = z.infer<typeof SnapshotIdentitySchema>;
export type ReportContent = z.infer<typeof ReportContentSchema>;
export type StructuredReport = z.infer<typeof StructuredReportSchema>;
export type StructuredReportV1 = z.infer<typeof StructuredReportV1Schema>;
export type StoredReport = z.infer<typeof StoredReportSchema>;

/**
 * Maps a v1 report onto the v2 content shape. v1 had no test evidence, so its testing
 * lines become `reported` (unverified) notes.
 */
export function upgradeV1Content(v1: StructuredReportV1): ReportContent {
  return {
    schemaVersion: 2,
    issueKey: v1.issueKey,
    language: v1.language,
    summary: v1.summary,
    completedWork: [
      ...v1.changes.map((c) => ({
        kind: c.kind,
        category: 'other' as const,
        subject: c.subject,
        description: c.description,
        files: c.files,
        endpoints: [],
      })),
      ...v1.apiChanges.map((a) => ({
        kind: a.kind,
        category: 'api-integration' as const,
        subject: a.method ? `${a.method} ${a.endpoint}` : a.endpoint,
        description: a.description,
        files: [],
        endpoints: [{ ...(a.method ? { method: a.method } : {}), endpoint: a.endpoint }],
      })),
    ].slice(0, 50),
    createdFiles: [],
    modifiedFiles: [],
    deletedFiles: [],
    renamedFiles: [],
    testing: { status: v1.testing.length > 0 ? 'reported' : 'not-run', notes: v1.testing },
    limitations: [...v1.risks, ...v1.followUps].slice(0, 20),
    uncertainties: [],
  };
}
