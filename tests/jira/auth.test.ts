import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jiraSiteFromUrl } from '../../src/checkpoints/site';
import { FileConfigStore } from '../../src/config/store';
import { repoConfigPath } from '../../src/config/paths';
import type { GlobalConfig } from '../../src/config/schema';
import { parseIssueKey } from '../../src/git/issue-key';
import {
  LoginRejectedError,
  NotLoggedInError,
  verifyApiToken,
} from '../../src/jira/auth/api-token';
import { OAuthNotAvailableError } from '../../src/jira/auth/oauth';
import {
  AmbiguousConnectionError,
  JiraConnectionManager,
  NoConnectionError,
  UnknownConnectionError,
  selectConnection,
} from '../../src/jira/connections';
import {
  CLOUD_ID,
  MemoryCredentialStore,
  MockJira,
  SITE_URL,
  type MockAccount,
} from '../fixtures/mock-jira';
import { createTempDir } from '../helpers';

describe('API token authentication', () => {
  let jira: MockJira;
  let classic: MockAccount;
  let scoped: MockAccount;
  let temp: Awaited<ReturnType<typeof createTempDir>>;
  let configStore: FileConfigStore;
  let credentials: MemoryCredentialStore;
  let manager: JiraConnectionManager;

  beforeEach(async () => {
    jira = await MockJira.start();
    classic = jira.addAccount({
      email: 'dev@example.com',
      token: 'classic-token',
      accountId: 'acc-1',
      displayName: 'Dev',
    });
    scoped = jira.addAccount({
      email: 'bot@example.com',
      token: 'scoped-token',
      accountId: 'acc-2',
      displayName: 'Bot',
      scoped: true,
    });
    temp = await createTempDir();
    configStore = new FileConfigStore({
      globalPath: path.join(temp.dir, 'config.json'),
      repoPath: repoConfigPath,
    });
    credentials = new MemoryCredentialStore();
    manager = new JiraConnectionManager({
      configStore,
      credentialStore: credentials,
      http: { fetch: jira.fetch, timeoutMs: 1000, retry: { maxAttempts: 1 } },
    });
  });
  afterEach(async () => {
    await jira.close();
    await temp.cleanup();
  });

  it('verifies a classic token on the site URL', async () => {
    const result = await verifyApiToken(
      { siteUrl: SITE_URL, email: classic.email, token: classic.token, tokenType: 'auto' },
      { fetch: jira.fetch },
    );
    expect(result).toMatchObject({ tokenType: 'classic', user: { accountId: 'acc-1' } });
    expect(jira.requests.every((r) => !r.gateway)).toBe(true);
  });

  it('detects a scoped token and switches to the API gateway with the cloud id', async () => {
    const result = await verifyApiToken(
      { siteUrl: SITE_URL, email: scoped.email, token: scoped.token, tokenType: 'auto' },
      { fetch: jira.fetch, retry: { maxAttempts: 1 } },
    );
    expect(result).toEqual({
      tokenType: 'scoped',
      cloudId: CLOUD_ID,
      user: { accountId: 'acc-2', displayName: 'Bot', emailAddress: 'bot@example.com' },
    });
    expect(jira.requests.at(-1)).toMatchObject({ path: '/rest/api/3/myself', gateway: true });
  });

  it('rejects a wrong token with a helpful message and stores nothing', async () => {
    await expect(
      manager.login({
        name: 'work',
        siteUrl: SITE_URL,
        email: classic.email,
        token: 'nope',
        tokenType: 'auto',
      }),
    ).rejects.toThrow(LoginRejectedError);
    expect(credentials.secrets.size).toBe(0);
    await expect(readFile(configStore.globalPath, 'utf8')).rejects.toThrow();
  });

  it('refuses to log in without a secure credential store', async () => {
    credentials.available = false;
    await expect(
      manager.login({
        name: 'work',
        siteUrl: SITE_URL,
        email: classic.email,
        token: classic.token,
        tokenType: 'auto',
      }),
    ).rejects.toThrow(/never stores tokens in plaintext/);
    expect(jira.requests).toHaveLength(0);
  });

  it('stores the token only in the credential store and settings in config', async () => {
    const result = await manager.login({
      name: 'work',
      siteUrl: `${SITE_URL}/jira/software`,
      email: classic.email,
      token: classic.token,
      tokenType: 'auto',
      projectKeys: ['LSND'],
    });
    expect(result.isDefault).toBe(true);
    expect(credentials.secrets.get('jira-api-token:work')).toBe('classic-token');
    const raw = await readFile(configStore.globalPath, 'utf8');
    expect(raw).not.toContain('classic-token');
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      jira: {
        defaultConnection: 'work',
        connections: {
          work: {
            siteUrl: SITE_URL,
            authMethod: 'api-token',
            email: 'dev@example.com',
            tokenType: 'classic',
            projectKeys: ['LSND'],
          },
        },
      },
    });

    const connection = await manager.get('work');
    expect(await manager.check(connection)).toEqual({
      state: 'signed-in',
      account: { displayName: 'Dev', accountId: 'acc-1' },
      siteUrl: SITE_URL,
    });

    // Token revoked in Atlassian: the check reports it without changing anything.
    classic.token = 'rotated';
    expect(await manager.check(connection)).toMatchObject({ state: 'rejected' });

    expect(await manager.logout('work')).toEqual({ removedSecret: true, forgotten: false });
    expect(await manager.check(connection)).toEqual({ state: 'signed-out', siteUrl: SITE_URL });
    await expect(manager.session(connection).client.getCurrentUser()).rejects.toThrow(
      NotLoggedInError,
    );
    expect(await manager.logout('work', true)).toEqual({ removedSecret: false, forgotten: true });
    expect((await manager.list()).connections).toEqual([]);
    await expect(manager.logout('work')).rejects.toThrow(UnknownConnectionError);
  });

  it('stores a scoped token with its cloud id and uses the gateway afterwards', async () => {
    await manager.login({
      name: 'bot',
      siteUrl: SITE_URL,
      email: scoped.email,
      token: scoped.token,
      tokenType: 'auto',
    });
    const connection = await manager.get('bot');
    expect(connection.config).toMatchObject({ tokenType: 'scoped', cloudId: CLOUD_ID });
    jira.requests.length = 0;
    expect(await manager.check(connection)).toMatchObject({ state: 'signed-in' });
    expect(jira.requests.every((r) => r.gateway)).toBe(true);
  });

  it('keeps the first connection as default unless asked, and supports several', async () => {
    await manager.login({
      name: 'work',
      siteUrl: SITE_URL,
      email: classic.email,
      token: classic.token,
      tokenType: 'classic',
    });
    const second = await manager.login({
      name: 'bot',
      siteUrl: SITE_URL,
      email: scoped.email,
      token: scoped.token,
      tokenType: 'scoped',
    });
    expect(second.isDefault).toBe(false);
    expect((await manager.list()).defaultConnection).toBe('work');
    await manager.login({
      name: 'bot',
      siteUrl: SITE_URL,
      email: scoped.email,
      token: scoped.token,
      tokenType: 'scoped',
      makeDefault: true,
    });
    expect((await manager.list()).defaultConnection).toBe('bot');
    await manager.logout('bot', true);
    expect((await manager.list()).defaultConnection).toBeUndefined();
  });

  it('does not offer OAuth until it is implemented', async () => {
    await configStore.writeGlobal({
      jira: { connections: { cloud: { siteUrl: SITE_URL, authMethod: 'oauth' } } },
    });
    expect(() =>
      manager.session({
        name: 'cloud',
        config: { siteUrl: SITE_URL, authMethod: 'oauth' },
        site: jiraSiteFromUrl(SITE_URL),
      }),
    ).toThrow(OAuthNotAvailableError);
  });
});

describe('selectConnection', () => {
  const work = {
    siteUrl: 'https://work.atlassian.net',
    authMethod: 'api-token' as const,
    projectKeys: ['LSND'],
  };
  const oss = { siteUrl: 'https://oss.atlassian.net', authMethod: 'api-token' as const };
  const work2 = { siteUrl: 'https://work.atlassian.net', authMethod: 'api-token' as const };
  const config = (
    connections: Record<string, typeof oss>,
    defaultConnection?: string,
  ): GlobalConfig => ({
    jira: { connections, ...(defaultConnection ? { defaultConnection } : {}) },
  });
  const issueKey = parseIssueKey('LSND-1');

  it('fails clearly without connections', () => {
    expect(() => selectConnection({}, { issueKey })).toThrow(NoConnectionError);
  });

  it('uses the only connection', () => {
    expect(selectConnection(config({ oss }), { issueKey })).toMatchObject({
      connection: { name: 'oss' },
      reason: 'only-connection',
    });
  });

  it('follows the precedence: option, --site, repository site, history, project, default', () => {
    const all = config({ work, oss }, 'oss');
    expect(selectConnection(all, { connection: 'work', issueKey }).reason).toBe('option');
    expect(
      selectConnection(all, { site: 'https://work.atlassian.net', issueKey }).connection.name,
    ).toBe('work');
    expect(
      selectConnection(all, { repositorySite: 'https://oss.atlassian.net', issueKey }).reason,
    ).toBe('repository-site');
    expect(
      selectConnection(all, {
        historySites: [jiraSiteFromUrl('https://work.atlassian.net')],
        issueKey: parseIssueKey('X-1'),
      }).reason,
    ).toBe('history');
    expect(selectConnection(all, { issueKey })).toMatchObject({
      connection: { name: 'work' },
      reason: 'project-key',
    });
    expect(selectConnection(all, { issueKey: parseIssueKey('OTHER-1') })).toMatchObject({
      connection: { name: 'oss' },
      reason: 'default',
    });
  });

  it('never guesses between equally matching connections', () => {
    expect(() =>
      selectConnection(config({ oss, work2 }), { issueKey: parseIssueKey('X-1') }),
    ).toThrow(AmbiguousConnectionError);
    expect(() =>
      selectConnection(config({ work, work2, oss }), { site: 'https://work.atlassian.net' }),
    ).toThrow(AmbiguousConnectionError);
    expect(
      selectConnection(config({ work, work2 }, 'work2'), { site: 'https://work.atlassian.net' })
        .connection.name,
    ).toBe('work2');
    expect(() =>
      selectConnection(config({ work, oss }), {
        historySites: [
          jiraSiteFromUrl('https://work.atlassian.net'),
          jiraSiteFromUrl('https://oss.atlassian.net'),
        ],
      }),
    ).toThrow(AmbiguousConnectionError);
  });

  it('rejects unknown names, unknown sites, and contradictory options', () => {
    expect(() => selectConnection(config({ oss }), { connection: 'nope' })).toThrow(
      UnknownConnectionError,
    );
    expect(() =>
      selectConnection(config({ oss }), { site: 'https://other.atlassian.net' }),
    ).toThrow(NoConnectionError);
    expect(() =>
      selectConnection(config({ oss }), { connection: 'oss', site: 'https://work.atlassian.net' }),
    ).toThrow(/not/);
    expect(() =>
      selectConnection(config({ oss }), {
        historySites: [jiraSiteFromUrl('https://gone.atlassian.net')],
      }),
    ).toThrow(NoConnectionError);
  });
});
