import { jiraSiteFromUrl } from '../checkpoints/site';
import type { JiraSite } from '../checkpoints/types';
import { ExitCode, Git2JiraError, UsageError } from '../core/errors';
import { credentialReference, type CredentialStore } from '../credentials/types';
import type { ConfigStore } from '../config/store';
import {
  ConnectionNameSchema,
  type GlobalConfig,
  type JiraConnectionConfig,
} from '../config/schema';
import { projectOf } from '../git/issue-key';
import type { IssueKey } from '../git/types';
import {
  ApiTokenAuthProvider,
  apiTokenAccount,
  verifyApiToken,
  type ApiTokenCandidate,
} from './auth/api-token';
import { OAuthNotAvailableError } from './auth/oauth';
import type { JiraAuthProvider, JiraAuthStatus } from './auth/types';
import { JiraAuthenticationError, JiraPermissionError, JiraRequestError } from './client/errors';
import { JiraHttp, type JiraHttpOptions } from './client/http';
import { JiraRestClient } from './client/rest-client';
import type { JiraClient, JiraCurrentUser } from './client/types';
import { NotLoggedInError } from './auth/api-token';

export interface JiraConnection {
  name: string;
  config: JiraConnectionConfig;
  site: JiraSite;
}

export interface JiraSession {
  connection: JiraConnection;
  auth: JiraAuthProvider;
  client: JiraClient;
}

/** Inputs that may select a connection, in precedence order. */
export interface ConnectionCriteria {
  /** `--connection` */
  connection?: string | undefined;
  /** `--site` */
  site?: string | undefined;
  /** `jira.site` in `.git2jira.json` */
  repositorySite?: string | undefined;
  /** Sites this issue already has report history for in this repository. */
  historySites?: readonly JiraSite[] | undefined;
  issueKey?: IssueKey | undefined;
}

export type SelectionReason =
  | 'option'
  | 'site-option'
  | 'repository-site'
  | 'history'
  | 'project-key'
  | 'default'
  | 'only-connection';

export interface SelectedConnection {
  connection: JiraConnection;
  reason: SelectionReason;
}

export class UnknownConnectionError extends Git2JiraError {
  constructor(name: string, known: readonly string[]) {
    super(
      `No Jira connection named "${name}".` +
        (known.length > 0 ? ` Known connections: ${known.join(', ')}.` : ' Run "git2jira login".'),
      ExitCode.Usage,
    );
  }
}

export class NoConnectionError extends Git2JiraError {
  constructor(detail?: string) {
    super(`${detail ?? 'No Jira connection is configured.'} Run "git2jira login" first.`);
  }
}

export class AmbiguousConnectionError extends Git2JiraError {
  constructor(why: string, candidates: readonly string[]) {
    super(
      `${why} Several Jira connections match (${candidates.join(', ')}). ` +
        'Pass --connection <name>, or set one with "git2jira config set jira.defaultConnection <name>".',
      ExitCode.Usage,
    );
  }
}

export function connectionsOf(config: GlobalConfig): JiraConnection[] {
  return Object.entries(config.jira?.connections ?? {})
    .map(([name, connection]) => ({
      name,
      config: connection,
      site: jiraSiteFromUrl(connection.siteUrl),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Deterministic connection choice. Explicit choices win; otherwise the
 * repository's site, the issue's existing history, project routing, the
 * default, and finally a single configured connection. Never guesses between
 * several equally good candidates.
 */
export function selectConnection(
  config: GlobalConfig,
  criteria: ConnectionCriteria,
): SelectedConnection {
  const all = connectionsOf(config);
  const names = all.map((c) => c.name);
  const preferDefault = (candidates: JiraConnection[], why: string, reason: SelectionReason) => {
    const [only] = candidates;
    if (candidates.length === 1 && only) return { connection: only, reason };
    const fallback = candidates.find((c) => c.name === config.jira?.defaultConnection);
    if (fallback) return { connection: fallback, reason };
    throw new AmbiguousConnectionError(
      why,
      candidates.map((c) => c.name),
    );
  };
  const bySite = (url: string, why: string, reason: SelectionReason) => {
    const site = jiraSiteFromUrl(url);
    const matches = all.filter((c) => c.site.id === site.id);
    if (matches.length === 0) {
      throw new NoConnectionError(`No Jira connection is configured for ${site.url} (${why}).`);
    }
    return preferDefault(matches, `${site.url} (${why}).`, reason);
  };

  if (criteria.connection !== undefined) {
    const name = ConnectionNameSchema.safeParse(criteria.connection);
    const match = all.find((c) => c.name === name.data);
    if (!match) throw new UnknownConnectionError(criteria.connection, names);
    if (criteria.site !== undefined && jiraSiteFromUrl(criteria.site).id !== match.site.id) {
      throw new UsageError(
        `Connection "${match.name}" is for ${match.site.url}, not ${criteria.site}.`,
      );
    }
    return { connection: match, reason: 'option' };
  }
  if (criteria.site !== undefined) return bySite(criteria.site, 'from --site', 'site-option');
  if (criteria.repositorySite !== undefined) {
    return bySite(criteria.repositorySite, 'from jira.site in .git2jira.json', 'repository-site');
  }
  const history = criteria.historySites ?? [];
  if (history.length > 1) {
    throw new AmbiguousConnectionError(
      'This issue has report history on several Jira sites.',
      history.map((s) => s.url),
    );
  }
  const [historySite] = history;
  if (historySite)
    return bySite(historySite.url, 'where this issue was reported before', 'history');

  if (all.length === 0) throw new NoConnectionError();
  if (criteria.issueKey !== undefined) {
    const project = projectOf(criteria.issueKey);
    const routed = all.filter((c) => c.config.projectKeys?.includes(project));
    if (routed.length > 0)
      return preferDefault(routed, `Project ${project} is routed.`, 'project-key');
  }
  const fallback = all.find((c) => c.name === config.jira?.defaultConnection);
  if (fallback) return { connection: fallback, reason: 'default' };
  return preferDefault(all, 'No rule selects a Jira connection.', 'only-connection');
}

export interface ConnectionManagerOptions {
  configStore: ConfigStore;
  credentialStore: CredentialStore;
  /** Transport options (fetch, timeouts, retry policy); used by tests. */
  http?: Omit<JiraHttpOptions, 'authorize'>;
}

export interface LoginInput extends Omit<ApiTokenCandidate, 'siteUrl'> {
  name: string;
  siteUrl: string;
  projectKeys?: readonly string[] | undefined;
  makeDefault?: boolean | undefined;
}

export interface LoginResult {
  connection: JiraConnection;
  user: JiraCurrentUser;
  isDefault: boolean;
}

/** Owns named Jira connections: their non-secret settings, credentials, and clients. */
export class JiraConnectionManager {
  constructor(private readonly options: ConnectionManagerOptions) {}

  async list(): Promise<{ connections: JiraConnection[]; defaultConnection: string | undefined }> {
    const config = await this.options.configStore.readGlobal();
    return {
      connections: connectionsOf(config),
      defaultConnection: config.jira?.defaultConnection,
    };
  }

  async get(name: string): Promise<JiraConnection> {
    const { connections } = await this.list();
    const match = connections.find((c) => c.name === name);
    if (!match)
      throw new UnknownConnectionError(
        name,
        connections.map((c) => c.name),
      );
    return match;
  }

  async select(criteria: ConnectionCriteria): Promise<SelectedConnection> {
    return selectConnection(await this.options.configStore.readGlobal(), criteria);
  }

  session(connection: JiraConnection): JiraSession {
    if (connection.config.authMethod !== 'api-token') throw new OAuthNotAvailableError();
    const auth = new ApiTokenAuthProvider(
      connection.name,
      connection.config,
      this.options.credentialStore,
    );
    const client = new JiraRestClient(
      new JiraHttp({ ...this.options.http, authorize: () => auth.authorize() }),
    );
    return { connection, auth, client };
  }

  /**
   * Verifies the token against Jira first, then stores the secret in the OS
   * credential store, then writes the non-secret settings. Nothing is stored
   * when verification fails; the secret is removed again if the config write fails.
   */
  async login(input: LoginInput): Promise<LoginResult> {
    const name = ConnectionNameSchema.parse(input.name);
    const site = jiraSiteFromUrl(input.siteUrl);
    if (!(await this.options.credentialStore.isAvailable())) {
      throw new Git2JiraError(
        `The OS credential store (${this.options.credentialStore.backend}) is not available. ` +
          'Git2Jira never stores tokens in plaintext; see docs/authentication.md.',
      );
    }
    const verified = await verifyApiToken({ ...input, siteUrl: site.url }, this.options.http);

    const reference = credentialReference(apiTokenAccount(name));
    await this.options.credentialStore.set(reference, input.token);
    try {
      const config = await this.options.configStore.readGlobal();
      const connections = { ...config.jira?.connections };
      const previous = connections[name];
      connections[name] = {
        siteUrl: site.url,
        authMethod: 'api-token',
        email: input.email,
        tokenType: verified.tokenType,
        ...(verified.cloudId ? { cloudId: verified.cloudId } : {}),
        ...(input.projectKeys?.length
          ? { projectKeys: [...input.projectKeys] }
          : previous?.projectKeys && previous.siteUrl === site.url
            ? { projectKeys: previous.projectKeys }
            : {}),
      };
      const isDefault =
        input.makeDefault === true ||
        config.jira?.defaultConnection === undefined ||
        config.jira.defaultConnection === name;
      await this.options.configStore.writeGlobal({
        ...config,
        jira: {
          ...config.jira,
          connections,
          ...(isDefault ? { defaultConnection: name } : {}),
        },
      });
      return {
        connection: { name, config: connections[name], site },
        user: verified.user,
        isDefault,
      };
    } catch (error) {
      await this.options.credentialStore.delete(reference).catch(() => undefined);
      throw error;
    }
  }

  /** Deletes the stored token; with `forget`, also the connection settings. */
  async logout(
    name: string,
    forget = false,
  ): Promise<{ removedSecret: boolean; forgotten: boolean }> {
    const config = await this.options.configStore.readGlobal();
    const known = config.jira?.connections?.[name];
    if (!known) {
      throw new UnknownConnectionError(
        name,
        connectionsOf(config).map((c) => c.name),
      );
    }
    const removedSecret = await this.options.credentialStore.delete(
      credentialReference(apiTokenAccount(name)),
    );
    if (forget) {
      const { [name]: _removed, ...connections } = config.jira?.connections ?? {};
      const { defaultConnection, ...jira } = config.jira ?? {};
      await this.options.configStore.writeGlobal({
        ...config,
        jira: {
          ...jira,
          connections,
          ...(defaultConnection && defaultConnection !== name ? { defaultConnection } : {}),
        },
      });
    }
    return { removedSecret, forgotten: forget };
  }

  /** Read-only authentication check against Jira (current user). */
  async check(connection: JiraConnection, signal?: AbortSignal): Promise<JiraAuthStatus> {
    const siteUrl = connection.site.url;
    try {
      const { client } = this.session(connection);
      const user = await client.getCurrentUser(signal);
      return {
        state: 'signed-in',
        account: { displayName: user.displayName, accountId: user.accountId },
        siteUrl,
      };
    } catch (error) {
      if (error instanceof NotLoggedInError) return { state: 'signed-out', siteUrl };
      if (error instanceof JiraAuthenticationError || error instanceof JiraPermissionError) {
        return { state: 'rejected', siteUrl, reason: error.message };
      }
      if (error instanceof JiraRequestError || error instanceof Git2JiraError) {
        return { state: 'unavailable', siteUrl, reason: error.message };
      }
      throw error;
    }
  }
}
