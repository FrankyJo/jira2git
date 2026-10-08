import type { AdfDocument } from '../../adf/types';
import type { IssueKey } from '../../git/types';

/**
 * Jira Cloud REST v3 client built on native fetch.
 *
 * There is intentionally no method to edit or delete comments: Git2Jira only
 * ever creates new comments. The only write besides comment creation is
 * storing Git2Jira's own metadata property on a comment it created.
 */
export interface JiraIssue {
  id: string;
  key: IssueKey;
  summary: string;
  /** Plain-text projection of the issue description. Untrusted. */
  description?: string;
  status?: string;
}

export interface JiraEntityProperty {
  key: string;
  value: unknown;
}

export interface JiraComment {
  id: string;
  created: string;
  author?: { accountId?: string | undefined; displayName?: string | undefined } | undefined;
  /** Raw ADF as stored in Jira. Written by anyone with comment access: untrusted. */
  body: unknown;
  /** Present when requested with `expandProperties`. */
  properties?: JiraEntityProperty[] | undefined;
}

export interface JiraPage<T> {
  values: T[];
  startAt: number;
  total: number;
}

export interface JiraCurrentUser {
  accountId: string;
  displayName: string;
  emailAddress?: string | undefined;
}

export interface CommentListOptions {
  startAt: number;
  maxResults: number;
  expandProperties?: boolean;
}

export interface JiraClient {
  getCurrentUser(signal?: AbortSignal): Promise<JiraCurrentUser>;
  /** Fails with IssueKeyMismatchError when Jira answers with another key (moved issue). */
  getIssue(issueKey: IssueKey, signal?: AbortSignal): Promise<JiraIssue>;
  listComments(
    issueKey: IssueKey,
    page: CommentListOptions,
    signal?: AbortSignal,
  ): Promise<JiraPage<JiraComment>>;
  getComment(issueKey: IssueKey, commentId: string, signal?: AbortSignal): Promise<JiraComment>;
  /**
   * Creates a new comment, never retried automatically. Callers must hold an
   * approved publication. `properties` are stored with the comment.
   */
  addComment(
    issueKey: IssueKey,
    body: AdfDocument,
    properties: readonly JiraEntityProperty[],
    signal?: AbortSignal,
  ): Promise<JiraComment>;
  /** Returns `undefined` when the property does not exist. */
  getCommentProperty(commentId: string, key: string, signal?: AbortSignal): Promise<unknown>;
  /** Idempotent: stores Git2Jira metadata on a comment it created. */
  setCommentProperty(
    commentId: string,
    key: string,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<void>;
}
