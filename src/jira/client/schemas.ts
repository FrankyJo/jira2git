import { z } from 'zod';

/**
 * Runtime schemas for the Jira Cloud REST v3 responses Git2Jira reads. Jira
 * adds fields over time, so these are non-strict objects: unknown fields are
 * dropped, required fields are checked. (Our own files use strict objects.)
 */

export const JiraErrorBodySchema = z.object({
  errorMessages: z.array(z.string()).optional(),
  errors: z.record(z.string(), z.string()).optional(),
  message: z.string().optional(),
});

export const CurrentUserSchema = z.object({
  accountId: z.string().min(1),
  displayName: z.string(),
  emailAddress: z.string().optional(),
  active: z.boolean().optional(),
});

export const IssueResponseSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  fields: z.object({
    summary: z.string(),
    /** ADF document or null. Untrusted. */
    description: z.unknown().optional(),
    status: z.object({ name: z.string() }).optional(),
  }),
});

export const EntityPropertySchema = z.object({
  key: z.string(),
  value: z.unknown(),
});

/** Comment ids are numeric strings; anything else must not be placed in a URL path. */
export const CommentIdSchema = z.string().regex(/^[0-9]{1,20}$/);

export const CommentResponseSchema = z.object({
  id: CommentIdSchema,
  created: z.string(),
  updated: z.string().optional(),
  author: z
    .object({ accountId: z.string().optional(), displayName: z.string().optional() })
    .optional(),
  /** ADF written by anyone with comment access. Untrusted, not validated as our subset. */
  body: z.unknown(),
  properties: z.array(EntityPropertySchema).optional(),
});

export const CommentPageSchema = z.object({
  startAt: z.int().nonnegative(),
  maxResults: z.int().nonnegative(),
  total: z.int().nonnegative(),
  comments: z.array(CommentResponseSchema),
});

export const TenantInfoSchema = z.object({ cloudId: z.uuid() });

export type CommentResponse = z.infer<typeof CommentResponseSchema>;
