import { ATLASSIAN_TOOLS, claudeToolPrefix } from '../mcp/tools';

/**
 * The approval boundary of `/jira-report`.
 *
 * The Skill may pre-approve (`allowed-tools`) only `git2jira` subcommands that neither
 * write to Jira nor move a checkpoint, and only read-only Atlassian tools. Everything
 * that records a publication, authorizes a Jira write, or abandons a report goes through
 * Claude Code's own permission prompt, which the model cannot answer for the user.
 */
export const PREAPPROVABLE_SUBCOMMANDS = [
  'skill context',
  'skill status',
  'skill verify',
  'report prepare',
  'report request',
  'report submit',
  'report show',
  'report pending',
  'report copy',
  'report export',
  'report receipt',
  'mcp status',
  'mcp verify',
] as const;

/** Never pre-approved: each one moves a checkpoint, authorizes a write, or discards work. */
export const GATED_SUBCOMMANDS = [
  'report confirm',
  'report revoke',
  'report cancel',
  'report recover',
  'report publish',
  'report record-result',
  'report reconcile',
  'report verify-comment',
  'report fallback',
  'mcp setup',
  'skill install',
  'skill uninstall',
] as const;

const READ_ONLY_MCP_TOOLS: readonly string[] = [
  ATLASSIAN_TOOLS.resources,
  ATLASSIAN_TOOLS.userInfo,
  ATLASSIAN_TOOLS.issue,
  ATLASSIAN_TOOLS.listComments,
];

/** Built-in tools a Skill may pre-approve: none of them changes anything. */
const READ_ONLY_BUILTINS = new Set(['Read', 'Grep', 'Glob']);

/**
 * Whether a Claude Code permission rule covers a Bash command. Approximates Claude
 * Code's matching (`Bash`, `Bash(*)`, `Bash(prefix:*)`, and `*` wildcards, where a
 * trailing ` *` also matches the bare command) and errs on the side of "matches".
 */
export function bashRuleMatches(rule: string, command: string): boolean {
  const trimmed = rule.trim();
  if (trimmed === 'Bash' || trimmed === 'Bash(*)') return true;
  const inner = /^Bash\((.*)\)$/s.exec(trimmed)?.[1];
  if (inner === undefined) return false;
  if (inner.endsWith(':*')) return command.startsWith(inner.slice(0, -2));
  if (inner.endsWith(' *') && command === inner.slice(0, -2)) return true;
  const pattern = inner
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pattern}$`, 's').test(command);
}

/** Whether a permission rule covers an MCP tool (`mcp__server`, `mcp__server__*`, exact). */
export function toolRuleMatches(rule: string, tool: string): boolean {
  const trimmed = rule.trim();
  if (trimmed === tool) return true;
  if (!trimmed.startsWith('mcp__')) return false;
  if (trimmed.endsWith('*')) return tool.startsWith(trimmed.slice(0, -1));
  // A bare server rule (`mcp__atlassian`) approves every tool of that server.
  return !trimmed.slice(5).includes('__') && tool.startsWith(`${trimmed}__`);
}

function sampleCommand(subcommand: string): string {
  return `git2jira ${subcommand} --report 00000000-0000-4000-8000-000000000000 --json`;
}

/**
 * Problems with a Skill's `allowed-tools`: any entry that could pre-approve something
 * outside the read-only set. An empty result means the boundary holds.
 */
export function checkAllowedTools(allowed: readonly string[]): string[] {
  const problems: string[] = [];
  for (const entry of allowed) {
    if (READ_ONLY_BUILTINS.has(entry)) continue;
    if (entry.startsWith('mcp__')) {
      const tool = entry.split('__')[2];
      if (tool === undefined || !READ_ONLY_MCP_TOOLS.includes(tool)) {
        problems.push(`${entry} is not a read-only Atlassian tool`);
      }
      continue;
    }
    if (!entry.startsWith('Bash')) {
      problems.push(`${entry} is not allowed in the Skill's allowed-tools`);
      continue;
    }
    const gated = GATED_SUBCOMMANDS.filter((s) => bashRuleMatches(entry, sampleCommand(s)));
    if (gated.length > 0) {
      problems.push(`${entry} would pre-approve ${gated.map((g) => `"${g}"`).join(', ')}`);
      continue;
    }
    if (!PREAPPROVABLE_SUBCOMMANDS.some((s) => entry === `Bash(git2jira ${s} *)`)) {
      problems.push(`${entry} is not one of the read-only git2jira subcommands`);
    }
  }
  return problems;
}

export interface PermissionSettings {
  /** Where the rules came from, for messages (e.g. `~/.claude/settings.json`). */
  source: string;
  allow: readonly string[];
  defaultMode?: string | undefined;
}

/**
 * Warnings about Claude Code permission settings that would remove the approval
 * boundary: rules pre-approving a gated `git2jira` subcommand or the MCP comment tool,
 * or a mode that skips permission prompts. Only `permissions.allow` and
 * `permissions.defaultMode` are ever looked at.
 */
export function scanPermissionSettings(
  settings: readonly PermissionSettings[],
  mcpServers: readonly string[],
): string[] {
  const commentTools = mcpServers.map(
    (server) => `${claudeToolPrefix(server)}${ATLASSIAN_TOOLS.writeComment}`,
  );
  const warnings: string[] = [];
  for (const { source, allow, defaultMode } of settings) {
    if (defaultMode === 'bypassPermissions') {
      warnings.push(
        `${source}: defaultMode "bypassPermissions" skips every permission prompt, so nothing stops a ` +
          'report from being confirmed or published without you. Do not run /jira-report in that mode.',
      );
    }
    for (const rule of allow) {
      const gated = GATED_SUBCOMMANDS.filter((s) => bashRuleMatches(rule, sampleCommand(s)));
      if (gated.length > 0) {
        warnings.push(
          `${source}: "${rule}" pre-approves ${gated.map((g) => `git2jira ${g}`).join(', ')}. ` +
            'Confirmations and publications would no longer ask you first.',
        );
      }
      if (
        commentTools.some((tool) => toolRuleMatches(rule, tool)) ||
        (rule.startsWith('mcp__') && rule.endsWith(`__${ATLASSIAN_TOOLS.writeComment}`))
      ) {
        warnings.push(
          `${source}: "${rule}" pre-approves the Jira comment tool; MCP publications would not ask you first.`,
        );
      }
    }
  }
  return warnings;
}
