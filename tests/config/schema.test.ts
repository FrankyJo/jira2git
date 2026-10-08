import { describe, expect, it } from 'vitest';
import { GlobalConfigSchema, RepoConfigSchema } from '../../src/config/schema';

function conn(overrides: object) {
  return {
    jira: {
      connections: {
        work: { siteUrl: 'https://example.atlassian.net', authMethod: 'api-token', ...overrides },
      },
    },
  };
}

describe('GlobalConfigSchema', () => {
  it('accepts an empty config', () => {
    expect(GlobalConfigSchema.parse({})).toEqual({});
  });

  it('accepts a full valid config', () => {
    const config = {
      version: 1,
      report: { language: 'uk' },
      jira: {
        defaultConnection: 'work',
        connections: {
          work: {
            siteUrl: 'https://example.atlassian.net',
            authMethod: 'api-token',
            email: 'dev@example.com',
            tokenType: 'classic',
            projectKeys: ['LSND'],
          },
        },
      },
    };
    expect(GlobalConfigSchema.parse(config)).toEqual(config);
  });

  it.each([
    [{ report: { language: 'de' } }, 'unsupported language'],
    [{ version: 2 }, 'unknown schema version'],
    [conn({ siteUrl: 'http://example.atlassian.net' }), 'non-HTTPS Jira site'],
    [conn({ siteUrl: 'not a url' }), 'malformed URL'],
    [conn({ authMethod: 'password' }), 'unknown auth method'],
    [{ jira: { connections: { 'Bad Name': {} } } }, 'invalid connection name'],
    [{ jira: { siteUrl: 'https://example.atlassian.net' } }, 'legacy flat site setting'],
    [{ unknown: true }, 'unknown top-level key'],
  ])('rejects %j (%s)', (config, _reason) => {
    expect(GlobalConfigSchema.safeParse(config).success).toBe(false);
  });

  it.each([
    { jira: { apiToken: 'secret' } },
    { jira: { password: 'secret' } },
    conn({ apiToken: 'secret' }),
    conn({ token: 'secret' }),
    { token: 'secret' },
  ])('refuses to hold credentials: %j', (config) => {
    expect(GlobalConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe('RepoConfigSchema', () => {
  it('accepts language, project keys, and a Jira site', () => {
    const config = {
      report: { language: 'en' },
      issue: { projectKeys: ['LSND', 'AB_2'] },
      jira: { site: 'https://example.atlassian.net' },
    };
    expect(RepoConfigSchema.parse(config)).toEqual(config);
  });

  it.each([
    [{ issue: { projectKeys: ['lsnd'] } }, 'lowercase project key'],
    [{ issue: { projectKeys: ['1ABC'] } }, 'project key starting with a digit'],
    [{ issue: { projectKeys: [] } }, 'empty project key list'],
    [
      { jira: { siteUrl: 'https://example.atlassian.net' } },
      'Jira connection settings in a repository',
    ],
    [{ jira: { site: 'http://example.atlassian.net' } }, 'non-HTTPS site in a repository'],
    [{ jira: { connections: {} } }, 'connections in a repository'],
    [{ jira: { apiToken: 'secret' } }, 'credentials in a repository'],
  ])('rejects %j (%s)', (config, _reason) => {
    expect(RepoConfigSchema.safeParse(config).success).toBe(false);
  });
});
