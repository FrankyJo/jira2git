import type { AdfDocument } from '../../adf/types';
import type { IssueKey } from '../../git/types';

/**
 * Jira Cloud REST v3 client built on native fetch. Implemented in Phase 2.
 *
 * There is intentionally no method to edit or delete comments: Git2Jira only
 * ever creates new comments.
 */
export interface JiraIssueSummary {
  key: IssueKey;
  summary: string;
  /** Plain-text projection of the issue description. Untrusted. */
  description?: string;
  status: string;
}

export interface JiraComment {
  id: string;
  created: string;
  author: { accountId: string; displayName: string };
  body: AdfDocument;
}

export interface JiraPage<T> {
  values: T[];
  startAt: number;
  total: number;
}

export interface JiraCurrentUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

export interface JiraClient {
  getCurrentUser(signal?: AbortSignal): Promise<JiraCurrentUser>;
  getIssue(issueKey: IssueKey, signal?: AbortSignal): Promise<JiraIssueSummary>;
  listComments(
    issueKey: IssueKey,
    page: { startAt: number; maxResults: number },
    signal?: AbortSignal,
  ): Promise<JiraPage<JiraComment>>;
  /** Creates a new comment. Callers must hold an approved PublicationPlan. */
  addComment(issueKey: IssueKey, body: AdfDocument, signal?: AbortSignal): Promise<JiraComment>;
}
