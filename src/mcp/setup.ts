import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ClaudeMcpRegistry, McpServerEntry, McpServerScope } from './claude-code';
import {
  ATLASSIAN_MCP_ENDPOINT,
  DEFAULT_MCP_SERVER_NAME,
  isAtlassianMcpUrl,
  isOfficialEndpoint,
} from './tools';
import { McpVerificationRecordSchema, type McpVerificationRecord } from './verification';

/**
 * What Git2Jira can learn and do about the Atlassian MCP connection from outside
 * Claude Code. Registration is visible here; OAuth authorization is not: it happens
 * inside Claude Code (`/mcp`), and only a tool call from the session can verify it.
 */
export type McpRegistrationState =
  | { kind: 'claude-not-installed' }
  | { kind: 'not-registered'; suggestedName: string }
  | { kind: 'registered'; entry: McpServerEntry; official: boolean }
  /** `claude mcp list` failed; we know Claude Code exists but not its servers. */
  | { kind: 'unknown'; error: string };

export type McpSetupResult =
  | { kind: 'claude-not-installed' }
  | { kind: 'already-registered'; entry: McpServerEntry; official: boolean }
  | { kind: 'declined'; suggestedName: string }
  | { kind: 'registered'; entry: McpServerEntry | undefined; name: string; scope: McpServerScope }
  | { kind: 'failed'; error: string };

export interface McpSetupOptions {
  /** Preferred server name; another free name is used if it belongs to an unrelated server. */
  name?: string | undefined;
  scope?: McpServerScope | undefined;
  /** Asked before anything is changed. */
  confirm: (message: string) => Promise<boolean>;
}

export class McpSetupService {
  constructor(private readonly registry: ClaudeMcpRegistry) {}

  async inspect(preferredName = DEFAULT_MCP_SERVER_NAME): Promise<McpRegistrationState> {
    if ((await this.registry.version()) === undefined) return { kind: 'claude-not-installed' };
    let servers: McpServerEntry[];
    try {
      servers = await this.registry.list();
    } catch (error) {
      return { kind: 'unknown', error: error instanceof Error ? error.message : String(error) };
    }
    const atlassian = pickAtlassian(servers, preferredName);
    if (atlassian) {
      return {
        kind: 'registered',
        entry: atlassian,
        official: atlassian.url !== undefined && isOfficialEndpoint(atlassian.url),
      };
    }
    return { kind: 'not-registered', suggestedName: freeName(servers, preferredName) };
  }

  /**
   * Registers the official endpoint at user scope unless an Atlassian server already
   * exists. Never replaces or edits an existing server, whatever its name.
   */
  async ensureRegistered(options: McpSetupOptions): Promise<McpSetupResult> {
    const state = await this.inspect(options.name ?? DEFAULT_MCP_SERVER_NAME);
    if (state.kind === 'claude-not-installed') return state;
    if (state.kind === 'unknown') return { kind: 'failed', error: state.error };
    if (state.kind === 'registered') {
      return { kind: 'already-registered', entry: state.entry, official: state.official };
    }
    const scope = options.scope ?? 'user';
    const name = state.suggestedName;
    const approved = await options.confirm(
      `Register the Atlassian Rovo MCP server "${name}" (${ATLASSIAN_MCP_ENDPOINT}) in Claude Code ` +
        `(${scope} scope)?`,
    );
    if (!approved) return { kind: 'declined', suggestedName: name };
    try {
      await this.registry.addHttpServer(name, ATLASSIAN_MCP_ENDPOINT, scope);
    } catch (error) {
      return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
    // Re-read so the caller reports what Claude Code actually has.
    const after = await this.registry.list().catch(() => []);
    return { kind: 'registered', entry: after.find((s) => s.name === name), name, scope };
  }
}

/** Prefers the configured name, then the official endpoint, then any Atlassian server. */
function pickAtlassian(servers: McpServerEntry[], preferred: string): McpServerEntry | undefined {
  const atlassian = servers.filter((s) => s.url !== undefined && isAtlassianMcpUrl(s.url));
  return (
    atlassian.find((s) => s.name === preferred) ??
    atlassian.find((s) => s.url !== undefined && isOfficialEndpoint(s.url)) ??
    atlassian[0]
  );
}

function freeName(servers: McpServerEntry[], preferred: string): string {
  const taken = new Set(servers.map((s) => s.name));
  if (!taken.has(preferred)) return preferred;
  for (let i = 0; ; i += 1) {
    const candidate = i === 0 ? `${preferred}-rovo` : `${preferred}-rovo-${String(i + 1)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Last `mcp verify` result in `<config dir>/mcp-verification.json`. Contains no secrets. */
export class McpVerificationStore {
  constructor(private readonly file: string) {}

  async read(): Promise<McpVerificationRecord | undefined> {
    try {
      const parsed = McpVerificationRecordSchema.safeParse(
        JSON.parse(await readFile(this.file, 'utf8')),
      );
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async write(record: McpVerificationRecord): Promise<void> {
    const validated = McpVerificationRecordSchema.parse(record);
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.file);
  }
}
