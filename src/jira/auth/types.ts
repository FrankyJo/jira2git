/**
 * Pluggable Jira authentication. `api-token` (personal use: Jira Cloud email
 * + API token held in the OS credential store) is implemented. `oauth` is a
 * designed extension point for public distribution (see ./oauth.ts and
 * docs/authentication.md); it must never embed a confidential client secret.
 */
export type JiraAuthMethod = 'api-token' | 'oauth';

export type JiraAuthStatus =
  | {
      state: 'signed-in';
      account: { displayName: string; accountId: string };
      siteUrl: string;
    }
  /** No credential is stored for this connection. */
  | { state: 'signed-out'; siteUrl: string }
  /** Jira refused the stored credential (wrong, expired, revoked, or missing scopes). */
  | { state: 'rejected'; siteUrl: string; reason: string }
  /** The check could not be completed (no credential store, network failure). */
  | { state: 'unavailable'; siteUrl?: string; reason: string };

/**
 * Credentials attached to a single Jira request. Only the HTTP client sees
 * this object; it is never logged, persisted, or passed to the AI layer.
 */
export interface JiraAuthorization {
  /** REST base URL, e.g. `https://site.atlassian.net` or `https://api.atlassian.com/ex/jira/{cloudId}`. */
  apiBaseUrl: string;
  headers: Readonly<{ Authorization: string }>;
}

export interface JiraAuthProvider {
  readonly method: JiraAuthMethod;
  /** Connection name this provider authenticates. */
  readonly connection: string;
  hasCredentials(): Promise<boolean>;
  /** Removes stored credentials. Returns whether anything was removed. */
  logout(): Promise<boolean>;
  /** Returns request authorization, refreshing tokens if the method supports it. */
  authorize(): Promise<JiraAuthorization>;
}
