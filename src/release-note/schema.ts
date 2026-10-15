import { z } from 'zod';
import { IssueKeySchema } from '../git/types';
import { LanguageSchema } from '../localization/languages';

/**
 * Release note: a user-facing description of everything an issue delivered, written for
 * end users and the business rather than developers. It is grouped by function, names UI
 * labels, roles, rules, and limits as users see them, and carries no file paths.
 *
 * Every content block records where its facts come from (`source`). The source is shown
 * in the preview so that the user can check what the code cannot prove; it is never
 * rendered into Jira. Size limits bound what untrusted model output can push into Jira.
 */
const Text = z.string().trim().min(1).max(2000);
const Short = z.string().trim().min(1).max(200);
const Cell = z.string().trim().min(1).max(500);
const FilePath = z.string().min(1).max(500);

/**
 * - code: read from the change set or from files at HEAD; needs `evidence` paths.
 * - jira: from the issue summary or description.
 * - user: given by the user during the run.
 * - inferred: the writer's interpretation; the preview lists it as "to verify".
 */
export const FactSourceSchema = z.enum(['code', 'jira', 'user', 'inferred']);

const Sourced = {
  source: FactSourceSchema,
  /** Changed paths that show the fact. Required for `code`; never rendered. */
  evidence: z.array(FilePath).max(20).default([]),
};

export const ReleaseNoteBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('paragraph'), text: Text, ...Sourced }),
  /** Numbered user actions, in order. */
  z.strictObject({ type: z.literal('steps'), items: z.array(Text).min(1).max(30), ...Sourced }),
  z.strictObject({ type: z.literal('bullets'), items: z.array(Text).min(1).max(30), ...Sourced }),
  /** Term → meaning: roles and their rights, statuses, options. */
  z.strictObject({
    type: z.literal('definitions'),
    items: z
      .array(z.strictObject({ term: Short, description: Text }))
      .min(1)
      .max(30),
    ...Sourced,
  }),
  z
    .strictObject({
      type: z.literal('table'),
      columns: z.array(Short).min(2).max(6),
      rows: z.array(z.array(Cell).min(2).max(6)).min(1).max(50),
      ...Sourced,
    })
    .refine((table) => table.rows.every((row) => row.length === table.columns.length), {
      message: 'every table row needs one cell per column',
    }),
  /** A message, badge, or label the user sees, quoted as shown, and what it means. */
  z.strictObject({ type: z.literal('uiMessage'), text: Text, meaning: Text, ...Sourced }),
  /** Exceptions, limits, and other remarks that deserve emphasis. */
  z.strictObject({ type: z.literal('note'), text: Text, ...Sourced }),
  /** Placeholder for a screenshot the author adds by hand. */
  z.strictObject({ type: z.literal('screenshot'), description: z.string().trim().min(1).max(300) }),
]);

export const ReleaseNoteSectionSchema = z.strictObject({
  title: Short,
  blocks: z.array(ReleaseNoteBlockSchema).min(1).max(40),
});

export const ReleaseNoteGoalSchema = z.strictObject({
  statement: Text,
  source: FactSourceSchema,
  objectives: z
    .array(z.strictObject({ title: Short, description: Text.optional() }))
    .max(10)
    .default([]),
});

/** What the writer (the model) produces. */
export const ReleaseNoteContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  issueKey: IssueKeySchema,
  language: LanguageSchema,
  goal: ReleaseNoteGoalSchema,
  sections: z.array(ReleaseNoteSectionSchema).min(1).max(20),
  /** What the writer could not establish; shown in the preview, never in Jira. */
  openQuestions: z.array(Text).max(20).default([]),
});

/** The finished release note: the writer's content plus the id the CLI owns. */
export const ReleaseNoteSchema = ReleaseNoteContentSchema.extend({ noteId: z.uuid() });

export type FactSource = z.infer<typeof FactSourceSchema>;
export type ReleaseNoteBlock = z.infer<typeof ReleaseNoteBlockSchema>;
export type ReleaseNoteSection = z.infer<typeof ReleaseNoteSectionSchema>;
export type ReleaseNoteContent = z.infer<typeof ReleaseNoteContentSchema>;
export type ReleaseNote = z.infer<typeof ReleaseNoteSchema>;
