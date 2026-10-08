import { z } from 'zod';
import type { McpProbe, ProbeOutcome } from './bridge';
import { parseAccessibleResources } from './results';
import { ATLASSIAN_TOOLS, findSessionTool, type AtlassianCapability } from './tools';

/**
 * Whether the user's Claude Code session can publish through Atlassian MCP, derived
 * only from what the session reported (visible tools and read-only probe results).
 * Nothing here proves that writing works: write permission is only known after the
 * first comment is created. A state other than `ready` means: use manual mode.
 */
export const MCP_ACCESS_STATES = [
  'ready',
  'read-only',
  'no-tools',
  'not-authenticated',
  'blocked-by-policy',
  'no-jira-access',
  'unknown',
] as const;
export type McpAccessState = (typeof MCP_ACCESS_STATES)[number];

export interface McpAssessment {
  state: McpAccessState;
  /** Exact session tool names per capability; absent when the session lacks it. */
  tools: Partial<Record<AtlassianCapability, string>>;
  /** Git2Jira never assumes MCP can read or write Jira comment properties. */
  commentProperties: false;
  publicationEnabled: boolean;
  sites: { cloudId: string; url: string; name: string | undefined }[];
  /** Human-readable explanations, most important first. */
  messages: string[];
}

const PUBLISH_NEEDS: readonly AtlassianCapability[] = [
  'resources',
  'issue',
  'listComments',
  'writeComment',
];

export function assessMcpAccess(probe: McpProbe): McpAssessment {
  const tools: Partial<Record<AtlassianCapability, string>> = {};
  for (const capability of Object.keys(ATLASSIAN_TOOLS) as AtlassianCapability[]) {
    const tool = findSessionTool(probe.tools, capability, probe.server);
    if (tool) tools[capability] = tool;
  }
  const messages: string[] = [];
  const base = { tools, commentProperties: false as const, sites: [] as McpAssessment['sites'] };
  const result = (state: McpAccessState, sites = base.sites): McpAssessment => ({
    ...base,
    sites,
    state,
    publicationEnabled: state === 'ready',
    messages,
  });

  if (Object.keys(tools).length === 0) {
    messages.push(
      'No Atlassian MCP tools are visible in this Claude Code session. Either the server is ' +
        'not registered, or its OAuth sign-in is not complete: run /mcp in Claude Code, select ' +
        'the Atlassian server, and authenticate in the browser.',
    );
    return result('no-tools');
  }

  const failures = Object.entries(probe.probes).filter(
    (entry): entry is [string, Extract<ProbeOutcome, { ok: false }>] => entry[1]?.ok === false,
  );
  for (const [, outcome] of failures) {
    const kind = classifyProbeError(outcome.error);
    if (kind === 'auth') {
      messages.push(
        `The Atlassian MCP server rejected the session's authorization (${clip(outcome.error.message)}). ` +
          'Run /mcp in Claude Code and authenticate again.',
      );
      return result('not-authenticated');
    }
    if (kind === 'policy') {
      messages.push(
        `Access is blocked (${clip(outcome.error.message)}). Your Atlassian organization admin ` +
          'controls whether Rovo MCP and its Jira tools may be used; Git2Jira does not work ' +
          'around that. Use manual mode, or ask your admin.',
      );
      return result('blocked-by-policy');
    }
  }

  const resources = probe.probes.resources;
  const sites =
    resources?.ok === true
      ? parseAccessibleResources(resources.result).map(({ cloudId, url, name }) => ({
          cloudId,
          url,
          name,
        }))
      : [];
  if (resources?.ok === true && sites.length === 0) {
    messages.push(
      'The session is authorized, but no Atlassian site with Jira is accessible to this account.',
    );
    return result('no-jira-access', sites);
  }
  const issue = probe.probes.issue;
  if (issue?.ok === false && classifyProbeError(issue.error) === 'forbidden') {
    messages.push(
      `Reading the Jira issue was refused (${clip(issue.error.message)}). Check that your account ` +
        'can browse the project and that the read_jira tools are allowed.',
    );
    return result('no-jira-access', sites);
  }

  const missing = PUBLISH_NEEDS.filter((c) => !tools[c]);
  if (missing.length === 1 && missing[0] === 'writeComment') {
    messages.push(
      `The session can read Jira but has no ${ATLASSIAN_TOOLS.writeComment} tool (write_jira ` +
        'not granted or disabled by an admin). Automatic publication is off; use manual mode.',
    );
    return result('read-only', sites);
  }
  if (missing.length > 0) {
    messages.push(
      `Missing MCP tools for publication: ${missing.map((c) => ATLASSIAN_TOOLS[c]).join(', ')}. ` +
        'Automatic publication is off; use manual mode.',
    );
    return result(tools.writeComment ? 'unknown' : 'read-only', sites);
  }
  if (resources?.ok !== true || issue?.ok !== true) {
    messages.push(
      'The tools are visible, but a successful read through them was not reported, so access ' +
        'is not verified yet. Run the read-only probes again from the Skill.',
    );
    return result('unknown', sites);
  }
  messages.push(
    'Reading Jira through MCP works. Comment creation is available as a tool, but write ' +
      'permission is only confirmed when the first report is published.',
  );
  return result('ready', sites);
}

type ProbeErrorKind = 'auth' | 'policy' | 'forbidden' | 'other';

export function classifyProbeError(error: {
  message: string;
  status?: number | undefined;
}): ProbeErrorKind {
  const { message, status } = error;
  const policy = /admin|organi[sz]ation|policy|blocked|disabled|not enabled|allow ?list/i;
  if (
    status === 401 ||
    /unauthori[sz]ed|not authenticated|authenticat|sign ?in|log ?in|token expired/i.test(message)
  )
    return 'auth';
  if (policy.test(message) && (status === 403 || status === undefined)) return 'policy';
  if (status === 403 || /forbidden|permission|not allowed|access denied/i.test(message))
    return 'forbidden';
  return 'other';
}

function clip(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return clean.length > 160 ? `${clean.slice(0, 160)}…` : clean;
}

/** What `git2jira mcp verify` remembers (no secrets): shown by `mcp status`. */
export const McpVerificationRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  verifiedAt: z.iso.datetime(),
  state: z.enum(MCP_ACCESS_STATES),
  server: z.string().max(64).optional(),
  tools: z.record(z.string(), z.string().max(200)),
  sites: z.array(
    z.strictObject({
      cloudId: z.string().max(100),
      url: z.string().max(200),
      name: z.string().max(200).optional(),
    }),
  ),
  messages: z.array(z.string().max(1000)),
});
export type McpVerificationRecord = z.infer<typeof McpVerificationRecordSchema>;
