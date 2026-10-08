import { z } from 'zod';
import { Git2JiraError } from '../core/errors';
import type { AdfDocument } from './types';

/**
 * Jira Cloud rejects comments longer than 32,767 characters. The limit is
 * checked on the text content with a margin, so a report that is too large
 * is caught before publishing instead of failing at Jira.
 */
export const MAX_COMMENT_TEXT = 30_000;
const MAX_SERIALIZED_BYTES = 256 * 1024;

// eslint-disable-next-line no-control-regex
const NO_CONTROL_CHARACTERS = /^[^\u0000-\u0008\u000b-\u001f\u007f]*$/;

const MarkSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('strong') }),
  z.strictObject({ type: z.literal('em') }),
  z.strictObject({ type: z.literal('code') }),
]);

const TextSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string().min(1).regex(NO_CONTROL_CHARACTERS, 'control character'),
  marks: z
    .array(MarkSchema)
    .min(1)
    .refine((marks) => !marks.some((m) => m.type === 'code') || marks.length === 1, {
      message: 'the code mark cannot be combined with other marks',
    })
    .optional(),
});

const InlineSchema = z.union([TextSchema, z.strictObject({ type: z.literal('hardBreak') })]);

const ParagraphSchema = z.strictObject({
  type: z.literal('paragraph'),
  content: z.array(InlineSchema).min(1),
});

const HeadingSchema = z.strictObject({
  type: z.literal('heading'),
  attrs: z.strictObject({ level: z.int().min(1).max(6) }),
  content: z.array(InlineSchema).min(1),
});

interface BulletListShape {
  type: 'bulletList';
  content: { type: 'listItem'; content: (z.infer<typeof ParagraphSchema> | BulletListShape)[] }[];
}

const BulletListSchema: z.ZodType<BulletListShape> = z.lazy(() =>
  z.strictObject({
    type: z.literal('bulletList'),
    content: z
      .array(
        z.strictObject({
          type: z.literal('listItem'),
          content: z.array(z.union([ParagraphSchema, BulletListSchema])).min(1),
        }),
      )
      .min(1),
  }),
);

const DocumentShapeSchema = z.strictObject({
  type: z.literal('doc'),
  version: z.literal(1),
  content: z
    .array(
      z.union([
        ParagraphSchema,
        HeadingSchema,
        BulletListSchema,
        z.strictObject({ type: z.literal('rule') }),
      ]),
    )
    .min(1),
});

/**
 * The exact ADF subset Git2Jira emits: no links, mentions, media, or macros.
 * Typed as AdfDocument: every value it accepts is one (heading levels are checked numerically).
 */
export const AdfDocumentSchema = DocumentShapeSchema as unknown as z.ZodType<AdfDocument>;

export class AdfValidationError extends Git2JiraError {
  constructor(readonly problems: string[]) {
    super(`The Jira comment is not valid: ${problems.join('; ')}.`);
  }
}

/** Validates structure, the allowed node subset, and size before anything is sent to Jira. */
export function validateAdfDocument(document: unknown): AdfDocument {
  const parsed = DocumentShapeSchema.safeParse(document);
  if (!parsed.success) {
    throw new AdfValidationError(
      parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'document'}: ${i.message}`),
    );
  }
  const problems: string[] = [];
  const textLength = countText(parsed.data);
  if (textLength > MAX_COMMENT_TEXT) {
    problems.push(
      `the report has ${String(textLength)} characters; Jira comments are limited to about ${String(MAX_COMMENT_TEXT)}`,
    );
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_SERIALIZED_BYTES) {
    problems.push('the document is too large');
  }
  if (problems.length > 0) throw new AdfValidationError(problems);
  return parsed.data as AdfDocument;
}

function countText(node: unknown): number {
  if (typeof node !== 'object' || node === null) return 0;
  const { text, content } = node as { text?: unknown; content?: unknown };
  let total = typeof text === 'string' ? text.length : 0;
  if (Array.isArray(content)) for (const child of content) total += countText(child);
  return total;
}
