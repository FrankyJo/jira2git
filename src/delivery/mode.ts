import type { z } from 'zod';
import { UsageError } from '../core/errors';
import {
  DELIVERY_MODES,
  DeliveryModeSchema,
  type GlobalConfig,
  type RepoConfig,
} from '../config/schema';

export { DELIVERY_MODES, DeliveryModeSchema };

/**
 * How a finished report reaches Jira.
 * - `manual`: the user copies the report and pastes it into Jira. No Jira credentials,
 *   no MCP. The checkpoint moves only after the user confirms (user-attested).
 * - `mcp`: the user's Claude Code session publishes through the Atlassian Rovo MCP
 *   server, authorized with OAuth inside Claude Code. The CLI never sees that authorization.
 * - `api-token`: the CLI publishes with a personal Jira API token (Phase 2). Optional.
 */
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;

/** Used when nothing is configured: it needs no authorization of any kind. */
export const DEFAULT_DELIVERY_MODE: DeliveryMode = 'manual';

export type DeliveryModeSource = 'option' | 'repository' | 'global' | 'default';

export function parseDeliveryMode(raw: string): DeliveryMode {
  const parsed = DeliveryModeSchema.safeParse(raw.trim().toLowerCase());
  if (!parsed.success) {
    throw new UsageError(`Unknown Jira mode "${raw}". Supported: ${DELIVERY_MODES.join(', ')}.`);
  }
  return parsed.data;
}

/**
 * `--mode`, then `jira.mode` in the repository, then globally, then `manual`.
 * There is no automatic fallback between modes: if the resolved mode cannot be
 * used, the command stops and says so, and the user picks another mode.
 */
export function resolveDeliveryMode(input: {
  override?: string | undefined;
  repoConfig?: RepoConfig | undefined;
  globalConfig?: GlobalConfig | undefined;
}): { mode: DeliveryMode; source: DeliveryModeSource } {
  if (input.override !== undefined)
    return { mode: parseDeliveryMode(input.override), source: 'option' };
  const repo = input.repoConfig?.jira?.mode;
  if (repo !== undefined) return { mode: repo, source: 'repository' };
  const global = input.globalConfig?.jira?.mode;
  if (global !== undefined) return { mode: global, source: 'global' };
  return { mode: DEFAULT_DELIVERY_MODE, source: 'default' };
}
