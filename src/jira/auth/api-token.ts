import { Git2JiraError } from '../../core/errors';
import { credentialReference, type CredentialStore } from '../../credentials/types';
import type { JiraConnectionConfig } from '../../config/schema';
import { JiraAuthenticationError, JiraPermissionError } from '../client/errors';
import { JiraHttp, type FetchLike, type JiraHttpOptions } from '../client/http';
import { JiraRestClient } from '../client/rest-client';
import { TenantInfoSchema } from '../client/schemas';
import type { JiraCurrentUser } from '../client/types';
import type { JiraAuthProvider, JiraAuthorization } from './types';

export const SCOPED_API_GATEWAY = 'https://api.atlassian.com/ex/jira';

/** Credential account for a connection's API token. */
export function apiTokenAccount(connection: string): string {
  return `jira-api-token:${connection}`;
}

export class NotLoggedInError extends Git2JiraError {
  constructor(connection: string) {
    super(`No Jira credentials are stored for connection "${connection}". Run "git2jira login".`);
  }
}

/**
 * Personal-use authentication: Atlassian account email + API token, sent as
 * HTTP Basic credentials over HTTPS. Classic tokens call the site URL; scoped
 * tokens must call the API gateway with the site's cloud id. The token is read
 * from the OS credential store for each request and never cached on disk.
 */
export class ApiTokenAuthProvider implements JiraAuthProvider {
  readonly method = 'api-token' as const;

  constructor(
    readonly connection: string,
    private readonly config: JiraConnectionConfig,
    private readonly store: CredentialStore,
  ) {}

  async hasCredentials(): Promise<boolean> {
    return (
      (await this.store.get(credentialReference(apiTokenAccount(this.connection)))) !== undefined
    );
  }

  logout(): Promise<boolean> {
    return this.store.delete(credentialReference(apiTokenAccount(this.connection)));
  }

  async authorize(): Promise<JiraAuthorization> {
    const token = await this.store.get(credentialReference(apiTokenAccount(this.connection)));
    if (token === undefined || !this.config.email) throw new NotLoggedInError(this.connection);
    return apiTokenAuthorization(this.config, this.config.email, token);
  }
}

export function apiTokenAuthorization(
  config: Pick<JiraConnectionConfig, 'siteUrl' | 'tokenType' | 'cloudId'>,
  email: string,
  token: string,
): JiraAuthorization {
  let apiBaseUrl = new URL(config.siteUrl).origin;
  if (config.tokenType === 'scoped') {
    if (!config.cloudId)
      throw new Git2JiraError(
        'Scoped API tokens need the site cloud id; run "git2jira login" again.',
      );
    apiBaseUrl = `${SCOPED_API_GATEWAY}/${config.cloudId}`;
  }
  const basic = Buffer.from(`${email}:${token}`, 'utf8').toString('base64');
  return { apiBaseUrl, headers: { Authorization: `Basic ${basic}` } };
}

export interface ApiTokenCandidate {
  siteUrl: string;
  email: string;
  token: string;
  /** `auto` tries a classic token first, then a scoped token through the API gateway. */
  tokenType: 'classic' | 'scoped' | 'auto';
}

export interface VerifiedApiToken {
  tokenType: 'classic' | 'scoped';
  cloudId?: string;
  user: JiraCurrentUser;
}

export class LoginRejectedError extends Git2JiraError {}

/**
 * Validates a token with a read-only call (current user) before anything is
 * stored. With `auto`, a 401 on the site URL is retried once as a scoped
 * token, which only works through api.atlassian.com.
 */
export async function verifyApiToken(
  candidate: ApiTokenCandidate,
  http: Omit<JiraHttpOptions, 'authorize'> = {},
): Promise<VerifiedApiToken> {
  const siteUrl = new URL(candidate.siteUrl).origin;
  const whoAmI = async (tokenType: 'classic' | 'scoped', cloudId?: string) => {
    const authorization = apiTokenAuthorization(
      { siteUrl, tokenType, ...(cloudId ? { cloudId } : {}) },
      candidate.email,
      candidate.token,
    );
    const client = new JiraRestClient(
      new JiraHttp({ ...http, authorize: () => Promise.resolve(authorization) }),
    );
    return client.getCurrentUser();
  };

  try {
    if (candidate.tokenType !== 'scoped') {
      try {
        return { tokenType: 'classic', user: await whoAmI('classic') };
      } catch (error) {
        if (candidate.tokenType === 'classic' || !(error instanceof JiraAuthenticationError))
          throw error;
      }
    }
    const cloudId = await fetchCloudId(siteUrl, http.fetch);
    return { tokenType: 'scoped', cloudId, user: await whoAmI('scoped', cloudId) };
  } catch (error) {
    if (error instanceof JiraAuthenticationError) {
      throw new LoginRejectedError(
        `Jira did not accept the email and API token for ${siteUrl}. Check the email, ` +
          'create a new token at https://id.atlassian.com/manage-profile/security/api-tokens, ' +
          'and make sure it has not expired.',
        1,
        { cause: error },
      );
    }
    if (error instanceof JiraPermissionError) {
      throw new LoginRejectedError(
        'The token is valid but may not read your Jira profile. A scoped token needs at least ' +
          'read:jira-user, read:jira-work, and write:jira-work (see docs/authentication.md).',
        1,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Reads the public cloud id of a Jira Cloud site (`/_edge/tenant_info`, no authentication). */
export async function fetchCloudId(siteUrl: string, fetchImpl?: FetchLike): Promise<string> {
  const doFetch = fetchImpl ?? ((input: string, init: RequestInit) => fetch(input, init));
  const url = `${new URL(siteUrl).origin}/_edge/tenant_info`;
  try {
    const response = await doFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    const parsed = TenantInfoSchema.safeParse(await response.json());
    if (response.ok && parsed.success) return parsed.data.cloudId;
  } catch {
    // Reported below.
  }
  throw new Git2JiraError(`Could not read the cloud id of ${siteUrl}; is it a Jira Cloud site?`);
}
