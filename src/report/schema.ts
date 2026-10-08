import { z } from 'zod';
import { IssueKeySchema } from '../git/types';
import { LanguageSchema } from '../localization/languages';

/**
 * Structured report produced by the AI layer and validated before rendering.
 * Structure and enums are language-independent; free-text fields are written
 * in `language`. Section headings come from the localization catalog at
 * render time. Paths, identifiers, and endpoints are kept verbatim.
 * Size limits bound what an untrusted model output can push into Jira.
 */
const Text = z.string().trim().min(1).max(2000);

export const ChangeKindSchema = z.enum(['added', 'modified', 'removed', 'refactored', 'fixed']);

export const ReportChangeSchema = z.strictObject({
  kind: ChangeKindSchema,
  /** Component, module, or feature name, verbatim from the code. */
  subject: z.string().trim().min(1).max(200),
  description: Text,
  files: z.array(z.string().min(1).max(500)).max(100),
});

export const ApiChangeSchema = z.strictObject({
  kind: ChangeKindSchema,
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional(),
  endpoint: z.string().trim().min(1).max(500),
  description: Text,
});

export const StructuredReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  issueKey: IssueKeySchema,
  language: LanguageSchema,
  summary: Text,
  changes: z.array(ReportChangeSchema).min(1).max(50),
  apiChanges: z.array(ApiChangeSchema).max(50).default([]),
  testing: z.array(Text).max(20).default([]),
  risks: z.array(Text).max(20).default([]),
  followUps: z.array(Text).max(20).default([]),
});

export type ChangeKind = z.infer<typeof ChangeKindSchema>;
export type ReportChange = z.infer<typeof ReportChangeSchema>;
export type ApiChange = z.infer<typeof ApiChangeSchema>;
export type StructuredReport = z.infer<typeof StructuredReportSchema>;
