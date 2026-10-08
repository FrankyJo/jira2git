/**
 * Atlassian Rovo MCP server: endpoint and the tools Git2Jira can use.
 *
 * Tool names are taken from Atlassian's "Supported tools" page
 * (https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/, read
 * 2026-10-08). The page lists names and groups only, not parameter schemas or result
 * shapes, so Git2Jira never assumes a tool exists: the Skill reports the tools its
 * Claude Code session actually has, and only those that match a name below are used.
 * Parameter names and result shapes must come from the session's own tool schemas.
 */
export const ATLASSIAN_MCP_ENDPOINT = 'https://mcp.atlassian.com/v2/mcp';
export const ATLASSIAN_MCP_HOST = 'mcp.atlassian.com';
/** Server name Git2Jira registers when nothing else is configured. */
export const DEFAULT_MCP_SERVER_NAME = 'atlassian';

export const ATLASSIAN_TOOLS = {
  /** Group "common": sites and their cloud ids. */
  resources: 'getAccessibleAtlassianResources',
  /** Group "common": the signed-in Atlassian account. */
  userInfo: 'atlassianUserInfo',
  /** Group read_jira: a work item by id or key. */
  issue: 'getJiraIssue',
  /** Group read_jira: paginated comments of a work item. */
  listComments: 'listJiraIssueComments',
  /**
   * Group write_jira: "adds a comment or edits an existing one". Git2Jira only ever
   * creates comments; the Skill must never pass an existing comment id.
   */
  writeComment: 'addOrEditJiraIssueComment',
} as const;

export type AtlassianCapability = keyof typeof ATLASSIAN_TOOLS;

/** Claude Code exposes MCP tools as `mcp__<server>__<tool>`, with the server name normalized. */
export function claudeToolPrefix(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__`;
}

/**
 * Finds the session tool that provides `capability`. With a server name, only that
 * server's tools count. Returns the exact name the session uses, or undefined.
 */
export function findSessionTool(
  sessionTools: readonly string[],
  capability: AtlassianCapability,
  server?: string,
): string | undefined {
  const name = ATLASSIAN_TOOLS[capability];
  const candidates = sessionTools.filter((t) => t === name || t.endsWith(`__${name}`));
  if (server === undefined) return candidates.length === 1 ? candidates[0] : undefined;
  const prefix = claudeToolPrefix(server);
  return candidates.find((t) => t === `${prefix}${name}`);
}

export function isAtlassianMcpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === ATLASSIAN_MCP_HOST;
  } catch {
    return false;
  }
}

/** The documented v2 endpoint (optionally with `?tools=all`). Older `/v1/sse` is legacy. */
export function isOfficialEndpoint(raw: string): boolean {
  if (!isAtlassianMcpUrl(raw)) return false;
  const url = new URL(raw);
  return url.pathname.replace(/\/+$/, '') === '/v2/mcp';
}
