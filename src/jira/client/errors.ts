import { Git2JiraError } from '../../core/errors';
import { terminalSafeLine } from '../../core/sanitize';

/**
 * What is known about whether a request reached Jira and took effect:
 * - `not-sent`: the request never left this machine (DNS failure, connection refused,
 *   missing credentials). A write did not happen.
 * - `rejected`: Jira answered with an error status (4xx). A write did not happen.
 * - `unknown`: timeout, dropped connection, 5xx, or an unreadable success response.
 *   A write may or may not have happened and must be reconciled, never blindly repeated.
 */
export type DeliveryState = 'not-sent' | 'rejected' | 'unknown';

export interface JiraErrorDetails {
  method: string;
  /** Path without query string. Never contains credentials. */
  path: string;
  status?: number;
  delivery: DeliveryState;
  /** Messages returned by Jira (untrusted, sanitized for display). */
  jiraMessages?: string[];
}

export class JiraRequestError extends Git2JiraError {
  readonly method: string;
  readonly path: string;
  readonly status: number | undefined;
  readonly delivery: DeliveryState;
  readonly jiraMessages: string[];

  constructor(message: string, details: JiraErrorDetails, options?: ErrorOptions) {
    const messages = (details.jiraMessages ?? []).map((m) => terminalSafeLine(m));
    super(
      messages.length > 0 ? `${message} Jira said: ${messages.join('; ')}` : message,
      1,
      options,
    );
    this.method = details.method;
    this.path = details.path;
    this.status = details.status;
    this.delivery = details.delivery;
    this.jiraMessages = messages;
  }
}

/** 401: missing, wrong, expired, or revoked credentials. */
export class JiraAuthenticationError extends JiraRequestError {}
/** 403: authenticated, but lacking a permission or token scope. */
export class JiraPermissionError extends JiraRequestError {}
/** 404: does not exist, or not visible to this account. Jira does not distinguish. */
export class JiraNotFoundError extends JiraRequestError {}

export class JiraRateLimitError extends JiraRequestError {
  constructor(
    message: string,
    details: JiraErrorDetails,
    readonly retryAfterMs: number | undefined,
  ) {
    super(message, details);
  }
}

export class JiraServerError extends JiraRequestError {}
/** Other 4xx responses, e.g. 400 for an invalid comment body. */
export class JiraClientError extends JiraRequestError {}
/** DNS failures, refused or dropped connections. */
export class JiraNetworkError extends JiraRequestError {}
export class JiraTimeoutError extends JiraRequestError {}
/** A response that does not match the documented shape. */
export class JiraResponseError extends JiraRequestError {}

/** Jira returned a different issue than requested, e.g. because it was moved. */
export class IssueKeyMismatchError extends Git2JiraError {
  constructor(
    readonly requested: string,
    readonly actual: string,
  ) {
    super(
      `Jira returned issue ${terminalSafeLine(actual)} for ${requested} (the issue was probably moved). ` +
        `Git2Jira will not switch issues on its own; rerun with --issue ${terminalSafeLine(actual)} if that is intended.`,
    );
  }
}
