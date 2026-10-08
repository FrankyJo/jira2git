import type { z } from 'zod';
import { adfToPlainText } from '../../adf/text';
import type { AdfDocument } from '../../adf/types';
import { IssueKeySchema, type IssueKey } from '../../git/types';
import { IssueKeyMismatchError, JiraNotFoundError, JiraResponseError } from './errors';
import type { JiraHttp, JiraHttpRequest } from './http';
import {
  CommentIdSchema,
  CommentPageSchema,
  CommentResponseSchema,
  CurrentUserSchema,
  EntityPropertySchema,
  IssueResponseSchema,
  type CommentResponse,
} from './schemas';
import type {
  CommentListOptions,
  JiraClient,
  JiraComment,
  JiraCurrentUser,
  JiraEntityProperty,
  JiraIssue,
  JiraPage,
} from './types';

const API = '/rest/api/3';
const PROPERTY_KEY_PATTERN = /^[A-Za-z0-9._-]{1,255}$/;
const MAX_DESCRIPTION_CHARS = 20_000;

export class JiraRestClient implements JiraClient {
  constructor(private readonly http: JiraHttp) {}

  async getCurrentUser(signal?: AbortSignal): Promise<JiraCurrentUser> {
    const user = await this.get(CurrentUserSchema, { path: `${API}/myself`, signal });
    return {
      accountId: user.accountId,
      displayName: user.displayName,
      ...(user.emailAddress === undefined ? {} : { emailAddress: user.emailAddress }),
    };
  }

  async getIssue(issueKey: IssueKey, signal?: AbortSignal): Promise<JiraIssue> {
    const issue = await this.get(IssueResponseSchema, {
      path: `${API}/issue/${segment(IssueKeySchema.parse(issueKey))}`,
      query: { fields: 'summary,description,status' },
      signal,
    });
    // Jira silently redirects keys of moved issues; never follow that to another issue.
    if (issue.key !== issueKey) throw new IssueKeyMismatchError(issueKey, issue.key);
    const description = adfToPlainText(issue.fields.description, MAX_DESCRIPTION_CHARS);
    return {
      id: issue.id,
      key: issueKey,
      summary: issue.fields.summary,
      ...(description ? { description } : {}),
      ...(issue.fields.status ? { status: issue.fields.status.name } : {}),
    };
  }

  async listComments(
    issueKey: IssueKey,
    page: CommentListOptions,
    signal?: AbortSignal,
  ): Promise<JiraPage<JiraComment>> {
    const result = await this.get(CommentPageSchema, {
      path: `${API}/issue/${segment(IssueKeySchema.parse(issueKey))}/comment`,
      query: {
        startAt: page.startAt,
        maxResults: page.maxResults,
        orderBy: 'created',
        ...(page.expandProperties ? { expand: 'properties' } : {}),
      },
      signal,
    });
    return { values: result.comments.map(toComment), startAt: result.startAt, total: result.total };
  }

  async getComment(
    issueKey: IssueKey,
    commentId: string,
    signal?: AbortSignal,
  ): Promise<JiraComment> {
    const comment = await this.get(CommentResponseSchema, {
      path: `${API}/issue/${segment(IssueKeySchema.parse(issueKey))}/comment/${segment(CommentIdSchema.parse(commentId))}`,
      query: { expand: 'properties' },
      signal,
    });
    return toComment(comment);
  }

  async addComment(
    issueKey: IssueKey,
    body: AdfDocument,
    properties: readonly JiraEntityProperty[],
    signal?: AbortSignal,
  ): Promise<JiraComment> {
    for (const property of properties) assertPropertyKey(property.key);
    const request: JiraHttpRequest = {
      method: 'POST',
      path: `${API}/issue/${segment(IssueKeySchema.parse(issueKey))}/comment`,
      body: { body, ...(properties.length > 0 ? { properties } : {}) },
      idempotent: false,
      signal,
    };
    const response = await this.http.send(request);
    const parsed = CommentResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      // The comment may exist even though we cannot read its id.
      throw new JiraResponseError(
        'Jira accepted the comment but returned no readable comment id.',
        {
          method: 'POST',
          path: request.path,
          status: response.status,
          delivery: 'unknown',
        },
      );
    }
    return toComment(parsed.data);
  }

  async getCommentProperty(commentId: string, key: string, signal?: AbortSignal): Promise<unknown> {
    assertPropertyKey(key);
    try {
      const property = await this.get(EntityPropertySchema, {
        path: `${API}/comment/${segment(CommentIdSchema.parse(commentId))}/properties/${segment(key)}`,
        signal,
      });
      return property.value;
    } catch (error) {
      if (error instanceof JiraNotFoundError) return undefined;
      throw error;
    }
  }

  async setCommentProperty(
    commentId: string,
    key: string,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    assertPropertyKey(key);
    await this.http.send({
      method: 'PUT',
      path: `${API}/comment/${segment(CommentIdSchema.parse(commentId))}/properties/${segment(key)}`,
      body: value,
      // Storing the same value twice has the same effect as storing it once.
      idempotent: true,
      signal,
    });
  }

  private async get<T>(
    schema: z.ZodType<T>,
    request: Omit<JiraHttpRequest, 'method' | 'idempotent'>,
  ): Promise<T> {
    const response = await this.http.send({ ...request, method: 'GET', idempotent: true });
    const parsed = schema.safeParse(response.data);
    if (!parsed.success) {
      throw new JiraResponseError(`Jira returned an unexpected response for GET ${request.path}.`, {
        method: 'GET',
        path: request.path,
        status: response.status,
        delivery: 'rejected',
      });
    }
    return parsed.data;
  }
}

function toComment(comment: CommentResponse): JiraComment {
  return {
    id: comment.id,
    created: comment.created,
    author: comment.author,
    body: comment.body,
    properties: comment.properties,
  };
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function assertPropertyKey(key: string): void {
  if (!PROPERTY_KEY_PATTERN.test(key)) throw new Error(`Invalid property key "${key}".`);
}
