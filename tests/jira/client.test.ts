import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiTokenAuthorization } from '../../src/jira/auth/api-token';
import {
  IssueKeyMismatchError,
  JiraAuthenticationError,
  JiraClientError,
  JiraNetworkError,
  JiraNotFoundError,
  JiraPermissionError,
  JiraRateLimitError,
  JiraResponseError,
  JiraServerError,
  JiraTimeoutError,
} from '../../src/jira/client/errors';
import { JiraHttp, parseRetryAfter, type JiraHttpOptions } from '../../src/jira/client/http';
import { JiraRestClient } from '../../src/jira/client/rest-client';
import { parseIssueKey } from '../../src/git/issue-key';
import { MockJira, SITE_URL, type MockAccount } from '../fixtures/mock-jira';

const KEY = parseIssueKey('LSND-1234');
const DOC = {
  type: 'doc' as const,
  version: 1 as const,
  content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
};

describe('Jira REST client against a mocked Jira', () => {
  let jira: MockJira;
  let dev: MockAccount;
  let sleeps: number[];

  beforeEach(async () => {
    jira = await MockJira.start();
    dev = jira.addAccount({
      email: 'dev@example.com',
      token: 'tok-dev',
      accountId: 'acc-dev',
      displayName: 'Dev',
    });
    jira.addIssue({
      id: '10001',
      key: 'LSND-1234',
      summary: 'User profile',
      description: {
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Build the profile page.' }] },
        ],
      },
    });
    sleeps = [];
  });
  afterEach(() => jira.close());

  function client(overrides: Partial<JiraHttpOptions> = {}, token = dev.token) {
    const http = new JiraHttp({
      authorize: () =>
        Promise.resolve(apiTokenAuthorization({ siteUrl: SITE_URL }, dev.email, token)),
      fetch: jira.fetch,
      timeoutMs: 400,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
      ...overrides,
    });
    return new JiraRestClient(http);
  }

  it('looks up the current user and an issue by exact key, with a plain-text description', async () => {
    expect(await client().getCurrentUser()).toEqual({
      accountId: 'acc-dev',
      displayName: 'Dev',
      emailAddress: 'dev@example.com',
    });
    expect(await client().getIssue(KEY)).toEqual({
      id: '10001',
      key: 'LSND-1234',
      summary: 'User profile',
      description: 'Build the profile page.',
      status: 'In Progress',
    });
  });

  it('refuses to follow a moved issue to another key', async () => {
    jira.addIssue({ id: '20002', key: 'NEW-7', summary: 'Moved' });
    jira.moved.set('OLD-1', 'NEW-7');
    await expect(client().getIssue(parseIssueKey('OLD-1'))).rejects.toThrow(IssueKeyMismatchError);
  });

  it('maps 401, 403, and 404 to typed errors that never echo credentials', async () => {
    const error = await client({}, 'wrong-token')
      .getCurrentUser()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JiraAuthenticationError);
    expect((error as JiraAuthenticationError).delivery).toBe('rejected');
    expect((error as Error).message).not.toContain('wrong-token');
    expect(JSON.stringify(error)).not.toContain('wrong-token');

    jira.issue('LSND-1234').viewers = ['someone-else'];
    await expect(client().getIssue(KEY)).rejects.toThrow(JiraNotFoundError);

    delete jira.issue('LSND-1234').viewers;
    jira.issue('LSND-1234').commenters = ['someone-else'];
    const denied = await client()
      .addComment(KEY, DOC, [])
      .catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(JiraPermissionError);
    expect((denied as JiraPermissionError).delivery).toBe('rejected');
    expect((denied as Error).message).toContain('permission to comment');
  });

  it('retries reads on 429 honoring Retry-After, and on 5xx with bounded backoff', async () => {
    jira.fault('GET', /myself/, { status: 429, headers: { 'Retry-After': '3' } });
    jira.fault('GET', /myself/, { status: 503 });
    expect((await client().getCurrentUser()).accountId).toBe('acc-dev');
    expect(sleeps).toEqual([3000, 2000]);
    expect(jira.count('GET', /myself/)).toBe(3);
  });

  it('gives up after the retry budget and surfaces the last error', async () => {
    jira.fault('GET', /myself/, { status: 502 }, 10);
    await expect(client().getCurrentUser()).rejects.toThrow(JiraServerError);
    expect(jira.count('GET', /myself/)).toBe(4);
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it('does not wait for an excessive Retry-After', async () => {
    jira.fault('GET', /myself/, { status: 429, headers: { 'Retry-After': '3600' } });
    const error = await client()
      .getCurrentUser()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JiraRateLimitError);
    expect((error as JiraRateLimitError).retryAfterMs).toBe(3_600_000);
    expect(sleeps).toEqual([]);
  });

  it('retries reads after timeouts and dropped connections', async () => {
    jira.fault('GET', /myself/, { kind: 'hang' });
    jira.fault('GET', /myself/, { kind: 'drop' });
    expect((await client().getCurrentUser()).accountId).toBe('acc-dev');
    expect(jira.count('GET', /myself/)).toBe(3);
  });

  it('never retries comment creation, and classifies each failure', async () => {
    jira.fault('POST', /comment$/, { status: 503 });
    const server = await client()
      .addComment(KEY, DOC, [])
      .catch((e: unknown) => e);
    expect(server).toBeInstanceOf(JiraServerError);
    expect((server as JiraServerError).delivery).toBe('unknown');

    jira.fault('POST', /comment$/, { kind: 'process-then-drop' });
    const dropped = await client()
      .addComment(KEY, DOC, [])
      .catch((e: unknown) => e);
    expect(dropped).toBeInstanceOf(JiraNetworkError);
    expect((dropped as JiraNetworkError).delivery).toBe('unknown');

    jira.fault('POST', /comment$/, { kind: 'hang' });
    const timeout = await client()
      .addComment(KEY, DOC, [])
      .catch((e: unknown) => e);
    expect(timeout).toBeInstanceOf(JiraTimeoutError);
    expect((timeout as JiraTimeoutError).delivery).toBe('unknown');

    jira.fault('POST', /comment$/, { status: 429, headers: { 'Retry-After': '1' } });
    const limited = await client()
      .addComment(KEY, DOC, [])
      .catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(JiraRateLimitError);
    expect((limited as JiraRateLimitError).delivery).toBe('rejected');

    const invalid = await client()
      .addComment(KEY, { type: 'bogus' } as never, [])
      .catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(JiraClientError);
    expect((invalid as JiraClientError).message).toContain('Comment body is not valid');

    expect(jira.count('POST', /comment$/)).toBe(5);
    expect(sleeps).toEqual([]);
    // Only the request whose response was dropped after processing created a comment.
    expect(jira.comments.get('LSND-1234')).toHaveLength(1);
  });

  it('classifies a refused connection as not sent', async () => {
    const port = Number(new URL(jira.origin).port);
    await jira.close();
    const http = new JiraHttp({
      authorize: () =>
        Promise.resolve(apiTokenAuthorization({ siteUrl: SITE_URL }, dev.email, dev.token)),
      fetch: (input, init) =>
        fetch(input.replace(SITE_URL, `http://127.0.0.1:${String(port)}`), init),
      retry: { maxAttempts: 1 },
    });
    const error = await new JiraRestClient(http).addComment(KEY, DOC, []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JiraNetworkError);
    expect((error as JiraNetworkError).delivery).toBe('not-sent');
    jira = await MockJira.start();
  });

  it('treats an unreadable success response to a write as unknown', async () => {
    const http = new JiraHttp({
      authorize: () =>
        Promise.resolve(apiTokenAuthorization({ siteUrl: SITE_URL }, dev.email, dev.token)),
      fetch: () => Promise.resolve(new Response('<html>oops</html>', { status: 201 })),
    });
    const error = await new JiraRestClient(http).addComment(KEY, DOC, []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JiraResponseError);
    expect((error as JiraResponseError).delivery).toBe('unknown');
  });

  it('does not follow redirects and refuses non-https API URLs', async () => {
    const redirecting = new JiraHttp({
      authorize: () =>
        Promise.resolve(apiTokenAuthorization({ siteUrl: SITE_URL }, dev.email, dev.token)),
      fetch: (_input, init) => {
        expect(init.redirect).toBe('manual');
        return Promise.resolve(
          new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }),
        );
      },
    });
    await expect(new JiraRestClient(redirecting).getCurrentUser()).rejects.toThrow(/redirected/);

    const insecure = new JiraHttp({
      authorize: () =>
        Promise.resolve({ apiBaseUrl: 'http://example.com', headers: { Authorization: 'x' } }),
    });
    await expect(new JiraRestClient(insecure).getCurrentUser()).rejects.toThrow(/https/);
  });

  it('paginates comments as the server dictates and expands properties', async () => {
    for (let i = 0; i < 5; i++)
      jira.insertComment('LSND-1234', dev, DOC, i === 3 ? { 'git2jira.report': { n: i } } : {});
    const page = await client().listComments(KEY, {
      startAt: 2,
      maxResults: 50,
      expandProperties: true,
    });
    expect(page.total).toBe(5);
    expect(page.startAt).toBe(2);
    expect(page.values).toHaveLength(2);
    expect(page.values[1]?.properties).toEqual([{ key: 'git2jira.report', value: { n: 3 } }]);
    expect(jira.requests.at(-1)?.query).toMatchObject({ orderBy: 'created', expand: 'properties' });
  });

  it('stores and reads comment properties; a missing property is undefined', async () => {
    const comment = await client().addComment(KEY, DOC, [
      { key: 'git2jira.report', value: { a: 1 } },
    ]);
    expect(await client().getCommentProperty(comment.id, 'git2jira.report')).toEqual({ a: 1 });
    expect(await client().getCommentProperty(comment.id, 'other')).toBeUndefined();
    await client().setCommentProperty(comment.id, 'other', { b: 2 });
    expect(await client().getCommentProperty(comment.id, 'other')).toEqual({ b: 2 });
    expect(await client().getComment(KEY, comment.id)).toMatchObject({ id: comment.id, body: DOC });
  });

  it('validates path parameters before building URLs', async () => {
    await expect(client().getCommentProperty('../../myself', 'k')).rejects.toThrow();
    await expect(client().getComment(KEY, '1/../2')).rejects.toThrow();
    await expect(client().getIssue('LSND-1/../x' as never)).rejects.toThrow();
    await expect(client().setCommentProperty('1', 'bad key/..', 1)).rejects.toThrow();
    expect(jira.requests).toHaveLength(0);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 4000)).toBe(6000);
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});
