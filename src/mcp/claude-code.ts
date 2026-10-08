import { Git2JiraError } from '../core/errors';
import type { ProcessRunner } from '../core/process';
import { terminalSafeLine } from '../core/sanitize';

/**
 * Talks to the installed Claude Code CLI through its documented `claude mcp`
 * subcommands (list, add). It never reads Claude Code's files, settings, or
 * credentials, and never starts a Claude Code session.
 *
 * `claude mcp list` output is meant for humans and is parsed defensively; the
 * format was checked against Claude Code 2.1.x only.
 */
export type McpServerScope = 'user' | 'local' | 'project';

export type McpHealth =
  'connected' | 'needs-authentication' | 'failed' | 'pending-approval' | 'unknown';

export interface McpServerEntry {
  name: string;
  /** URL (HTTP/SSE servers) or command line (stdio servers), as printed. */
  target: string;
  url: string | undefined;
  health: McpHealth;
  /** Claude Code's status text, sanitized. Informational only. */
  status: string;
}

export interface ClaudeMcpRegistry {
  /** Claude Code version, or undefined when `claude` is not installed. */
  version(): Promise<string | undefined>;
  list(): Promise<McpServerEntry[]>;
  addHttpServer(name: string, url: string, scope: McpServerScope): Promise<void>;
}

export class ClaudeCodeError extends Git2JiraError {}

export class ClaudeCliRegistry implements ClaudeMcpRegistry {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly executable = 'claude',
  ) {}

  async version(): Promise<string | undefined> {
    const result = await this.runner.run(this.executable, ['--version'], { timeoutMs: 15_000 });
    if (result.notFound || result.exitCode !== 0) return undefined;
    return /\d+\.\d+\.\d+[^\s]*/.exec(result.stdout)?.[0] ?? terminalSafeLine(result.stdout, 40);
  }

  async list(): Promise<McpServerEntry[]> {
    // Health checks contact every configured server; allow time for slow ones.
    const result = await this.runner.run(this.executable, ['mcp', 'list'], { timeoutMs: 90_000 });
    if (result.notFound) throw new ClaudeCodeError('Claude Code ("claude") is not installed.');
    if (result.exitCode !== 0) {
      throw new ClaudeCodeError(
        `"claude mcp list" failed: ${terminalSafeLine(result.stderr || result.stdout)}`,
      );
    }
    return parseMcpList(result.stdout);
  }

  async addHttpServer(name: string, url: string, scope: McpServerScope): Promise<void> {
    const result = await this.runner.run(
      this.executable,
      ['mcp', 'add', '--transport', 'http', '--scope', scope, name, url],
      { timeoutMs: 30_000 },
    );
    if (result.notFound) throw new ClaudeCodeError('Claude Code ("claude") is not installed.');
    if (result.exitCode !== 0) {
      throw new ClaudeCodeError(
        `"claude mcp add" failed: ${terminalSafeLine(result.stderr || result.stdout)}`,
      );
    }
  }
}

/** Parses lines like `name: https://host/path (HTTP) - ✔ Connected`. */
export function parseMcpList(output: string): McpServerEntry[] {
  const entries: McpServerEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.+?): (.+) - (.+)$/.exec(line.trim());
    if (!match) continue;
    const [, name = '', target = '', status = ''] = match;
    const url = target
      .split(/\s+/)
      .find((token) => /^https?:\/\//.test(token))
      ?.replace(/[),]+$/, '');
    entries.push({
      name: name.trim(),
      target: terminalSafeLine(target.trim(), 300),
      url,
      health: healthOf(status),
      status: terminalSafeLine(status.trim(), 80),
    });
  }
  return entries;
}

function healthOf(status: string): McpHealth {
  if (/needs auth|authenticat/i.test(status)) return 'needs-authentication';
  if (/pending approval/i.test(status)) return 'pending-approval';
  if (/failed|error|✗/i.test(status)) return 'failed';
  if (/connected/i.test(status)) return 'connected';
  return 'unknown';
}
