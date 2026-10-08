import { Git2JiraError } from '../../core/errors';

/**
 * OAuth 2.0 (3LO) extension point for public distribution. Interfaces only:
 * no flow is implemented, and none is simulated. See docs/authentication.md
 * for the evaluation and the constraints any implementation must meet.
 *
 * Constraint enforced by the types: a client registration has no
 * `clientSecret` field. A secret shipped in an npm package is public, so code
 * exchange and refresh that need a secret must happen in a broker service the
 * project operates (`tokenBrokerUrl`), never in the distributed CLI.
 */
export interface OAuthClientRegistration {
  clientId: string;
  /** Loopback redirect, e.g. `http://127.0.0.1:<port>/callback`. */
  redirectUri: string;
  scopes: readonly string[];
  /** Service that holds the client secret and performs code exchange and refresh. */
  tokenBrokerUrl?: string;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  /** ISO timestamp. */
  expiresAt: string;
  scopes: readonly string[];
  /** Jira site (cloud id) the grant covers; API calls go to api.atlassian.com/ex/jira/{cloudId}. */
  cloudId: string;
}

export interface OAuthAuthorizationRequest {
  authorizationUrl: string;
  state: string;
  /** PKCE verifier, kept in memory only. */
  codeVerifier: string;
}

export interface OAuthAuthorizationFlow {
  start(): Promise<OAuthAuthorizationRequest>;
  exchange(request: OAuthAuthorizationRequest, code: string, state: string): Promise<OAuthTokenSet>;
  /** Rotating refresh: the returned set replaces the stored one atomically. */
  refresh(tokens: OAuthTokenSet): Promise<OAuthTokenSet>;
}

export class OAuthNotAvailableError extends Git2JiraError {
  constructor() {
    super(
      'OAuth sign-in is not available in this version. Use an API token ("git2jira login"); ' +
        'see docs/authentication.md for the OAuth plan.',
    );
  }
}
