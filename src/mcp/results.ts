import { z } from 'zod';
import { findReportMarkers, type ReportMarker } from '../adf/footer';
import { adfToPlainText } from '../adf/text';

/**
 * Parsers for Atlassian MCP tool results, relayed to the CLI by the Claude Code
 * session. The result shapes are NOT documented by Atlassian and have not been
 * verified against a live server. The parsers therefore read only the few fields
 * Git2Jira needs, from the shapes Jira's REST API uses, and treat anything else as
 * "not established". All content is untrusted data.
 */

const MAX_INPUT_DEPTH = 4;

/**
 * Tool results arrive as JSON, as text containing JSON, or wrapped in MCP content
 * blocks (`[{ type: "text", text: "…" }]`). Returns the first JSON value found.
 */
export function unwrapToolResult(raw: unknown, depth = 0): unknown {
  if (depth > MAX_INPUT_DEPTH) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^[[{]/.test(trimmed)) return raw;
    try {
      return unwrapToolResult(JSON.parse(trimmed) as unknown, depth + 1);
    } catch {
      return raw;
    }
  }
  const blocks = z
    .array(z.looseObject({ type: z.literal('text'), text: z.string() }))
    .min(1)
    .safeParse(raw);
  if (blocks.success && blocks.data.length === 1) {
    return unwrapToolResult(blocks.data[0]?.text, depth + 1);
  }
  const content = z.looseObject({ content: z.array(z.unknown()) }).safeParse(raw);
  if (
    content.success &&
    !('id' in (raw as object)) &&
    z.array(z.looseObject({ type: z.literal('text') })).safeParse(content.data.content).success
  ) {
    return unwrapToolResult(content.data.content, depth + 1);
  }
  // The Rovo MCP server wraps payloads as `{"data": …}` (seen 2026-10-09 on
  // getAccessibleAtlassianResources). Only an object whose sole key is `data` is unwrapped.
  if (
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    Object.keys(raw).length === 1 &&
    'data' in raw
  ) {
    return unwrapToolResult(raw.data, depth + 1);
  }
  return raw;
}

const IdSchema = z.union([z.string().regex(/^[0-9]{1,30}$/), z.int().nonnegative()]);

const CommentShape = z.looseObject({
  id: IdSchema,
  created: z.string().optional(),
  author: z.looseObject({ accountId: z.string().optional() }).nullish(),
  body: z.unknown().optional(),
  renderedBody: z.string().optional(),
});

export interface ParsedComment {
  id: string;
  created: string | undefined;
  authorAccountId: string | undefined;
  /** Plain text of the body (ADF projected to text, or the string as given). */
  text: string;
}

function toComment(value: z.infer<typeof CommentShape>): ParsedComment {
  const body = value.body;
  const text =
    typeof body === 'string'
      ? body
      : body !== undefined
        ? adfToPlainText(body)
        : (value.renderedBody ?? '');
  return {
    id: String(value.id),
    created: value.created,
    authorAccountId: value.author?.accountId ?? undefined,
    text,
  };
}

/** The comment a create call returned: the object itself, or `{ comment: {…} }`. */
export function parseCreatedComment(raw: unknown): ParsedComment | undefined {
  const value = unwrapToolResult(raw);
  const direct = CommentShape.safeParse(value);
  if (direct.success) return toComment(direct.data);
  const wrapped = z.looseObject({ comment: CommentShape }).safeParse(value);
  return wrapped.success ? toComment(wrapped.data.comment) : undefined;
}

const PageShape = z.union([
  z.looseObject({
    comments: z.array(z.unknown()),
    total: z.int().nonnegative().optional(),
    startAt: z.int().nonnegative().optional(),
    isLast: z.boolean().optional(),
  }),
  z.looseObject({
    values: z.array(z.unknown()),
    total: z.int().nonnegative().optional(),
    startAt: z.int().nonnegative().optional(),
    isLast: z.boolean().optional(),
  }),
]);

export interface CommentListing {
  comments: ParsedComment[];
  /** True only when the pages provably cover every comment of the issue. */
  complete: boolean;
  /** Entries that could not be read as comments; they make the listing incomplete. */
  unreadable: number;
}

/**
 * One page, or an array of pages, of a comment listing. Completeness needs a `total`
 * (or `isLast: true` on the last page) and every comment read; otherwise absence of a
 * report in the listing proves nothing.
 */
export function parseCommentListing(raw: unknown): CommentListing {
  const value = commentPageOf(unwrapToolResult(raw));
  const pages =
    Array.isArray(value) && value.every((v) => PageShape.safeParse(commentPageOf(v)).success)
      ? value.map(commentPageOf)
      : [value];
  const comments = new Map<string, ParsedComment>();
  let unreadable = 0;
  let total: number | undefined;
  let sawLast = false;
  let pagesOk = true;
  for (const page of pages) {
    const parsed = PageShape.safeParse(unwrapToolResult(page));
    if (!parsed.success) {
      pagesOk = false;
      continue;
    }
    const data = parsed.data as { comments?: unknown[]; values?: unknown[] };
    const entries = data.comments ?? data.values ?? [];
    for (const entry of entries) {
      const comment = CommentShape.safeParse(unwrapToolResult(entry));
      if (comment.success) comments.set(String(comment.data.id), toComment(comment.data));
      else unreadable += 1;
    }
    if (parsed.data.total !== undefined) total = Math.max(total ?? 0, parsed.data.total);
    if (parsed.data.isLast === true) sawLast = true;
  }
  const list = [...comments.values()];
  const complete =
    pagesOk && unreadable === 0 && (total !== undefined ? list.length >= total : sawLast);
  return { comments: list, complete, unreadable };
}

/**
 * The Rovo MCP server has no comment-listing tool (seen 2026-10-09), so comments are read
 * through the issue tool: a Jira issue carries them as `fields.comment`, a page with
 * `comments` and `total`. An issue without that field stays an unreadable page, which makes
 * the listing incomplete, never "absent".
 */
function commentPageOf(value: unknown): unknown {
  const unwrapped = unwrapToolResult(value);
  const issue = z
    .looseObject({ fields: z.looseObject({ comment: z.looseObject({}) }) })
    .safeParse(unwrapped);
  return issue.success ? issue.data.fields.comment : unwrapped;
}

/** The issue a lookup returned: Jira's `{ id, key, fields: { summary } }`, possibly wrapped. */
export function parseIssueLookup(
  raw: unknown,
): { id: string; key: string; summary: string; description?: string } | undefined {
  const IssueShape = z.looseObject({
    id: IdSchema,
    key: z.string().min(1).max(100),
    fields: z
      .looseObject({ summary: z.string().optional(), description: z.unknown().optional() })
      .optional(),
  });
  const value = unwrapToolResult(raw);
  const direct = IssueShape.safeParse(value);
  const wrapped = z.looseObject({ issue: IssueShape }).safeParse(value);
  const issue = direct.success ? direct.data : wrapped.success ? wrapped.data.issue : undefined;
  if (!issue) return undefined;
  const described = issue.fields?.description;
  const description =
    typeof described === 'string'
      ? described.slice(0, 20_000)
      : described
        ? adfToPlainText(described, 20_000)
        : '';
  return {
    id: String(issue.id),
    key: issue.key,
    summary: issue.fields?.summary ?? '',
    ...(description ? { description } : {}),
  };
}

/** Account id from `atlassianUserInfo` (`account_id`) or a Jira user (`accountId`). */
export function parseAccountId(raw: unknown): string | undefined {
  const value = unwrapToolResult(raw);
  const Id = z.string().min(1).max(200);
  const snake = z.looseObject({ account_id: Id }).safeParse(value);
  if (snake.success) return snake.data.account_id;
  const camel = z.looseObject({ accountId: Id }).safeParse(value);
  return camel.success ? camel.data.accountId : undefined;
}

/** Sites from `getAccessibleAtlassianResources`: `[{ id, url, name, scopes }]`. */
const ResourceShape = z.looseObject({
  id: z.string().min(1).max(100).optional(),
  /** Rovo MCP's own field name for the site's cloud id. */
  cloudId: z.string().min(1).max(100).optional(),
  url: z.url({ protocol: /^https$/ }),
  name: z.string().max(200).optional(),
  /** Atlassian REST shape: OAuth scopes such as `read:jira-work`. */
  scopes: z.array(z.string()).optional(),
  /** Rovo MCP shape: products on the site, e.g. `{ id: "jira", access: "read-write" }`. */
  products: z.array(z.looseObject({ id: z.string(), access: z.string().optional() })).optional(),
});

/**
 * Sites from the sites tool. Accepts the Atlassian REST shape (an array of
 * `{ id, url, name, scopes }`) and the shape the Rovo MCP server returned on
 * 2026-10-09: `{ data: { resources: [{ cloudId, url, products: [{ id, access }] }] } }`.
 * When products are listed, only sites that include Jira count.
 */
export function parseAccessibleResources(
  raw: unknown,
): { cloudId: string; url: string; name: string | undefined; scopes: string[] }[] {
  const value = unwrapToolResult(raw);
  const list = z
    .union([z.array(z.unknown()), z.looseObject({ resources: z.array(z.unknown()) })])
    .safeParse(value);
  if (!list.success) return [];
  const items = Array.isArray(list.data) ? list.data : list.data.resources;
  const sites: { cloudId: string; url: string; name: string | undefined; scopes: string[] }[] = [];
  for (const item of items) {
    const parsed = ResourceShape.safeParse(item);
    if (!parsed.success) continue;
    const r = parsed.data;
    const cloudId = r.cloudId ?? r.id;
    if (cloudId === undefined) continue;
    if (r.products !== undefined && !r.products.some((p) => p.id.toLowerCase().includes('jira'))) {
      continue;
    }
    sites.push({
      cloudId,
      url: new URL(r.url).origin,
      name: r.name,
      scopes: r.scopes ?? r.products?.map((p) => `${p.id}:${p.access ?? ''}`) ?? [],
    });
  }
  return sites;
}

/** Report markers in a comment, trusted only when there is exactly one. */
export function singleMarker(text: string): ReportMarker | undefined {
  const markers = findReportMarkers(text);
  return markers.length === 1 ? markers[0] : undefined;
}

/**
 * How an MCP write failure is classified. Conservative: anything that does not
 * clearly say Jira refused the request counts as `unknown` (may have been created).
 */
export type McpFailureClass =
  | {
      delivery: 'rejected';
      retryable: boolean;
      reason: 'invalid' | 'auth' | 'forbidden' | 'not-found' | 'rate-limited';
    }
  | { delivery: 'unknown' };

export function classifyMcpError(error: {
  message: string;
  status?: number | undefined;
}): McpFailureClass {
  const { status } = error;
  if (status !== undefined) {
    if (status === 400 || status === 413 || status === 422)
      return { delivery: 'rejected', retryable: false, reason: 'invalid' };
    if (status === 401) return { delivery: 'rejected', retryable: true, reason: 'auth' };
    if (status === 403) return { delivery: 'rejected', retryable: true, reason: 'forbidden' };
    if (status === 404) return { delivery: 'rejected', retryable: true, reason: 'not-found' };
    if (status === 429) return { delivery: 'rejected', retryable: true, reason: 'rate-limited' };
    return { delivery: 'unknown' };
  }
  const message = error.message;
  if (
    /time(?:d)? ?out|ECONNRESET|socket hang up|network|5\d\d|internal server error|bad gateway|unavailable/i.test(
      message,
    )
  )
    return { delivery: 'unknown' };
  if (
    /\b401\b|unauthori[sz]ed|not authenticated|authentication required|re-?authenticate/i.test(
      message,
    )
  )
    return { delivery: 'rejected', retryable: true, reason: 'auth' };
  if (/\b403\b|forbidden|permission|not permitted|not allowed|access denied/i.test(message))
    return { delivery: 'rejected', retryable: true, reason: 'forbidden' };
  return { delivery: 'unknown' };
}
