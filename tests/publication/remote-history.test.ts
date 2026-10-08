import { describe, expect, it } from 'vitest';
import { parseIssueKey } from '../../src/git/issue-key';
import type { JiraClient, JiraComment, JiraPage } from '../../src/jira/client/types';
import { REPORT_PROPERTY_KEY } from '../../src/publication/metadata';
import { recognize, scanRemoteReports } from '../../src/publication/remote-history';

const ID = '3f2a9c1e-1b2c-4d3e-8f40-5a6b7c8d9e0f';
const KEY = parseIssueKey('LSND-1');

function body(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function comment(id: string, text: string, properties?: JiraComment['properties']): JiraComment {
  return {
    id,
    created: '2026-10-08T10:00:00.000+0000',
    author: { accountId: 'a' },
    body: body(text),
    properties,
  };
}

function pagedClient(pages: (JiraPage<JiraComment> | Error)[]): JiraClient {
  let call = 0;
  return {
    listComments: () => {
      const page = pages[call++];
      return page instanceof Error || page === undefined
        ? Promise.reject(page ?? new Error('no page'))
        : Promise.resolve(page);
    },
  } as unknown as JiraClient;
}

describe('remote report recognition', () => {
  it('recognizes reports by property, by marker, or both', () => {
    expect(recognize(comment('1', `Git2Jira report ${ID} · #3 · a..b`))).toMatchObject({
      reportId: ID,
      sequence: 3,
      source: 'marker',
    });
    expect(recognize(comment('2', 'plain text'))).toBeUndefined();
  });

  it('ignores comments quoting several markers and invalid properties', () => {
    const other = '0e0e0e0e-1111-4222-8333-444444444444';
    expect(
      recognize(comment('1', `Git2Jira report ${ID} · #1 and Git2Jira report ${other} · #2`)),
    ).toBeUndefined();
    expect(
      recognize(
        comment('2', 'x', [{ key: REPORT_PROPERTY_KEY, value: { reportId: 'not valid' } }]),
      ),
    ).toBeUndefined();
  });
});

describe('scanRemoteReports', () => {
  it('follows pagination to the end', async () => {
    const scan = await scanRemoteReports(
      pagedClient([
        {
          startAt: 0,
          total: 3,
          values: [comment('1', 'a'), comment('2', `Git2Jira report ${ID} · #1`)],
        },
        { startAt: 2, total: 3, values: [comment('3', 'c')] },
      ]),
      KEY,
    );
    expect(scan).toMatchObject({ complete: true, scannedComments: 3 });
    expect(scan.reports.map((r) => r.commentId)).toEqual(['2']);
  });

  it('is incomplete when a page fails or comes back empty early', async () => {
    const failed = await scanRemoteReports(
      pagedClient([{ startAt: 0, total: 4, values: [comment('1', 'a')] }, new Error('boom')]),
      KEY,
    );
    expect(failed).toMatchObject({ complete: false, scannedComments: 1 });
    expect(failed.error?.message).toBe('boom');

    const truncated = await scanRemoteReports(
      pagedClient([
        { startAt: 0, total: 4, values: [comment('1', 'a')] },
        { startAt: 1, total: 4, values: [] },
      ]),
      KEY,
    );
    expect(truncated.complete).toBe(false);
  });
});
