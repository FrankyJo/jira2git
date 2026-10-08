import { describe, expect, it } from 'vitest';
import { McpProbeSchema, type McpProbe } from '../../src/mcp/bridge';
import {
  classifyMcpError,
  parseCommentListing,
  parseCreatedComment,
  parseIssueLookup,
} from '../../src/mcp/results';
import { findSessionTool } from '../../src/mcp/tools';
import { assessMcpAccess } from '../../src/mcp/verification';

const ALL_TOOLS = [
  'mcp__atlassian__getAccessibleAtlassianResources',
  'mcp__atlassian__atlassianUserInfo',
  'mcp__atlassian__getJiraIssue',
  'mcp__atlassian__listJiraIssueComments',
  'mcp__atlassian__addOrEditJiraIssueComment',
  'Read',
  'Bash',
];
const RESOURCES = [
  {
    id: 'cloud-1',
    url: 'https://example.atlassian.net',
    name: 'example',
    scopes: ['read:jira-work'],
  },
];

function probe(overrides: Partial<McpProbe> = {}): McpProbe {
  return McpProbeSchema.parse({
    schemaVersion: 1,
    tools: ALL_TOOLS,
    server: 'atlassian',
    probes: {
      resources: { ok: true, result: RESOURCES },
      issue: { ok: true, result: { id: '1', key: 'ABC-1', fields: { summary: 's' } } },
    },
    ...overrides,
  });
}

describe('MCP access assessment', () => {
  it('is ready only with read probes passing and all publication tools visible', () => {
    const result = assessMcpAccess(probe());
    expect(result.state).toBe('ready');
    expect(result.publicationEnabled).toBe(true);
    expect(result.commentProperties).toBe(false);
    expect(result.tools.writeComment).toBe('mcp__atlassian__addOrEditJiraIssueComment');
    expect(result.sites).toEqual([
      { cloudId: 'cloud-1', url: 'https://example.atlassian.net', name: 'example' },
    ]);
  });

  it('OAuth not completed: no tools in the session', () => {
    const result = assessMcpAccess(probe({ tools: ['Read', 'Bash'], probes: {} }));
    expect(result.state).toBe('no-tools');
    expect(result.publicationEnabled).toBe(false);
    expect(result.messages[0]).toMatch(/\/mcp/);
  });

  it('OAuth not completed or expired: the server rejects the authorization', () => {
    const result = assessMcpAccess(
      probe({
        probes: { resources: { ok: false, error: { message: 'Unauthorized', status: 401 } } },
      }),
    );
    expect(result.state).toBe('not-authenticated');
    expect(result.publicationEnabled).toBe(false);
  });

  it('organization blocks MCP: explained, not worked around', () => {
    const result = assessMcpAccess(
      probe({
        probes: {
          resources: {
            ok: false,
            error: { message: 'Your organization admin has blocked this app', status: 403 },
          },
        },
      }),
    );
    expect(result.state).toBe('blocked-by-policy');
    expect(result.messages[0]).toMatch(/admin/);
    expect(result.messages[0]).toMatch(/manual mode/);
  });

  it('reading allowed but writing denied: no comment tool means read-only', () => {
    const result = assessMcpAccess(
      probe({ tools: ALL_TOOLS.filter((t) => !t.endsWith('addOrEditJiraIssueComment')) }),
    );
    expect(result.state).toBe('read-only');
    expect(result.publicationEnabled).toBe(false);
  });

  it('does not call access verified without a successful read', () => {
    expect(assessMcpAccess(probe({ probes: {} })).state).toBe('unknown');
  });

  it('only matches documented tool names, for the configured server', () => {
    expect(
      findSessionTool(['mcp__atlassian__addCommentToJiraIssue'], 'writeComment'),
    ).toBeUndefined();
    expect(
      findSessionTool(['mcp__claude_ai_Atlassian__getJiraIssue'], 'issue', 'claude.ai Atlassian'),
    ).toBe('mcp__claude_ai_Atlassian__getJiraIssue');
    expect(findSessionTool(['mcp__other__getJiraIssue'], 'issue', 'atlassian')).toBeUndefined();
    // Two servers offer the tool and none is named: ambiguous, not guessed.
    expect(
      findSessionTool(['mcp__a__getJiraIssue', 'mcp__b__getJiraIssue'], 'issue'),
    ).toBeUndefined();
  });
});

describe('MCP result parsing', () => {
  it('reads a created comment from JSON, text, or content blocks', () => {
    const comment = { id: '123', body: 'hello', author: { accountId: 'a' } };
    expect(parseCreatedComment(comment)?.id).toBe('123');
    expect(parseCreatedComment(JSON.stringify(comment))?.text).toBe('hello');
    expect(
      parseCreatedComment([{ type: 'text', text: JSON.stringify({ comment }) }])?.authorAccountId,
    ).toBe('a');
    expect(parseCreatedComment('Comment added successfully')).toBeUndefined();
    expect(parseCreatedComment({ id: '../1' })).toBeUndefined();
  });

  it('claims a complete listing only with a total or a last page', () => {
    const c = (id: string) => ({ id, body: 'x' });
    expect(parseCommentListing({ comments: [c('1')], total: 1 }).complete).toBe(true);
    expect(parseCommentListing({ comments: [c('1')], total: 2 }).complete).toBe(false);
    expect(parseCommentListing({ comments: [c('1')] }).complete).toBe(false);
    expect(parseCommentListing({ values: [c('1')], isLast: true }).complete).toBe(true);
    expect(
      parseCommentListing([
        { comments: [c('1')], total: 2, startAt: 0 },
        { comments: [c('2')], total: 2, startAt: 1 },
      ]).complete,
    ).toBe(true);
    expect(parseCommentListing({ comments: [c('1'), { nope: true }], total: 2 }).complete).toBe(
      false,
    );
  });

  it('reads issue lookups', () => {
    expect(parseIssueLookup({ id: 10001, key: 'ABC-1', fields: { summary: 'S' } })).toEqual({
      id: '10001',
      key: 'ABC-1',
      summary: 'S',
    });
    expect(parseIssueLookup({ errorMessages: ['Issue does not exist'] })).toBeUndefined();
  });

  it('classifies write failures conservatively', () => {
    expect(classifyMcpError({ message: 'x', status: 403 })).toMatchObject({
      delivery: 'rejected',
      reason: 'forbidden',
    });
    expect(classifyMcpError({ message: 'x', status: 400 })).toMatchObject({
      delivery: 'rejected',
      retryable: false,
    });
    expect(classifyMcpError({ message: 'x', status: 503 })).toEqual({ delivery: 'unknown' });
    expect(classifyMcpError({ message: 'socket hang up' })).toEqual({ delivery: 'unknown' });
    expect(classifyMcpError({ message: 'Something odd happened' })).toEqual({
      delivery: 'unknown',
    });
    expect(classifyMcpError({ message: 'Forbidden: write_jira scope not granted' })).toMatchObject({
      delivery: 'rejected',
    });
  });
});
