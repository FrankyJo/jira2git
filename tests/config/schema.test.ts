import { describe, expect, it } from 'vitest';
import { GlobalConfigSchema, RepoConfigSchema } from '../../src/config/schema';

describe('GlobalConfigSchema', () => {
  it('accepts an empty config', () => {
    expect(GlobalConfigSchema.parse({})).toEqual({});
  });

  it('accepts a full valid config', () => {
    const config = {
      version: 1,
      report: { language: 'uk' },
      jira: { siteUrl: 'https://example.atlassian.net', authMethod: 'api-token' },
    };
    expect(GlobalConfigSchema.parse(config)).toEqual(config);
  });

  it.each([
    [{ report: { language: 'de' } }, 'unsupported language'],
    [{ version: 2 }, 'unknown schema version'],
    [{ jira: { siteUrl: 'http://example.atlassian.net' } }, 'non-HTTPS Jira site'],
    [{ jira: { siteUrl: 'not a url' } }, 'malformed URL'],
    [{ jira: { authMethod: 'password' } }, 'unknown auth method'],
    [{ unknown: true }, 'unknown top-level key'],
  ])('rejects %j (%s)', (config, _reason) => {
    expect(GlobalConfigSchema.safeParse(config).success).toBe(false);
  });

  it.each([
    { jira: { apiToken: 'secret' } },
    { jira: { password: 'secret' } },
    { token: 'secret' },
  ])('refuses to hold credentials: %j', (config) => {
    expect(GlobalConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe('RepoConfigSchema', () => {
  it('accepts language and project keys', () => {
    const config = { report: { language: 'en' }, issue: { projectKeys: ['LSND', 'AB_2'] } };
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
    [{ jira: { apiToken: 'secret' } }, 'credentials in a repository'],
  ])('rejects %j (%s)', (config, _reason) => {
    expect(RepoConfigSchema.safeParse(config).success).toBe(false);
  });
});
