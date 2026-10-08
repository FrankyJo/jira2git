import type { Prompter } from '../../installer/prompter';

/**
 * Pluggable Jira authentication. Phase 2 delivers `api-token` (personal use:
 * Jira Cloud email + API token held in the OS credential store). `oauth` is a
 * designed extension point for public distribution; its flow must be verified
 * against Atlassian's current requirements before implementation and must not
 * embed a confidential client secret. See docs/authentication.md.
 */
export type JiraAuthMethod = 'api-token' | 'oauth';

export type JiraAuthStatus =
  | { state: 'signed-in'; account: { displayName: string; accountId: string }; siteUrl: string }
  | { state: 'signed-out' }
  | { state: 'expired'; siteUrl: string }
  | { state: 'unavailable'; reason: string };

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
  status(): Promise<JiraAuthStatus>;
  /** Interactive sign-in. Validates credentials against Jira before storing them. */
  login(prompter: Prompter): Promise<JiraAuthStatus>;
  /** Removes stored credentials. Returns whether anything was removed. */
  logout(): Promise<boolean>;
  /** Returns request authorization, refreshing tokens if the method supports it. */
  authorize(): Promise<JiraAuthorization>;
}
