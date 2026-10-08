import { describe, expect, it } from 'vitest';
import type { ProcessOptions, ProcessResult, ProcessRunner } from '../../src/core/process';
import { ClaudeCliRegistry, parseMcpList } from '../../src/mcp/claude-code';
import { McpSetupService } from '../../src/mcp/setup';
import { ATLASSIAN_MCP_ENDPOINT } from '../../src/mcp/tools';

/** Scripted `claude` executable: answers by argument list, records every call. */
class FakeClaude implements ProcessRunner {
  calls: string[][] = [];
  servers: string[];
  constructor(
    servers: string[],
    private readonly installed = true,
  ) {
    this.servers = [...servers];
  }

  run(file: string, args: readonly string[], _options?: ProcessOptions): Promise<ProcessResult> {
    this.calls.push([file, ...args]);
    const ok = (stdout: string): ProcessResult => ({
      stdout,
      stderr: '',
      exitCode: 0,
      notFound: false,
      timedOut: false,
    });
    if (!this.installed) {
      return Promise.resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        notFound: true,
        timedOut: false,
      });
    }
    if (args[0] === '--version') return Promise.resolve(ok('2.1.294 (Claude Code)\n'));
    if (args[0] === 'mcp' && args[1] === 'list') {
      return Promise.resolve(ok(`Checking MCP server health…\n\n${this.servers.join('\n')}\n`));
    }
    if (args[0] === 'mcp' && args[1] === 'add') {
      const name = args[6] ?? '';
      const url = args[7] ?? '';
      this.servers.push(`${name}: ${url} (HTTP) - ⚠ Needs authentication`);
      return Promise.resolve(ok(`Added HTTP MCP server ${name}`));
    }
    return Promise.resolve({
      stdout: '',
      stderr: 'unknown',
      exitCode: 1,
      notFound: false,
      timedOut: false,
    });
  }

  adds(): string[][] {
    return this.calls.filter((c) => c[1] === 'mcp' && c[2] === 'add');
  }
}

const setupWith = (claude: FakeClaude) => new McpSetupService(new ClaudeCliRegistry(claude));
const yes = () => Promise.resolve(true);

describe('Atlassian MCP registration', () => {
  it('registers the official endpoint at user scope after confirmation, without claiming OAuth', async () => {
    const claude = new FakeClaude([
      'memory: npx -y @modelcontextprotocol/server-memory - ✔ Connected',
    ]);
    const result = await setupWith(claude).ensureRegistered({ confirm: yes });
    expect(claude.adds()).toEqual([
      [
        'claude',
        'mcp',
        'add',
        '--transport',
        'http',
        '--scope',
        'user',
        'atlassian',
        ATLASSIAN_MCP_ENDPOINT,
      ],
    ]);
    expect(result).toMatchObject({ kind: 'registered', name: 'atlassian', scope: 'user' });
    if (result.kind === 'registered') expect(result.entry?.health).toBe('needs-authentication');
  });

  it('changes nothing when the user declines', async () => {
    const claude = new FakeClaude([]);
    const result = await setupWith(claude).ensureRegistered({
      confirm: () => Promise.resolve(false),
    });
    expect(result.kind).toBe('declined');
    expect(claude.adds()).toEqual([]);
  });

  it('reuses an existing Atlassian MCP connection under any name', async () => {
    const claude = new FakeClaude([
      'jira-work: https://mcp.atlassian.com/v2/mcp (HTTP) - ✔ Connected',
    ]);
    const result = await setupWith(claude).ensureRegistered({ confirm: yes });
    expect(result).toMatchObject({ kind: 'already-registered', official: true });
    if (result.kind === 'already-registered') expect(result.entry.name).toBe('jira-work');
    expect(claude.adds()).toEqual([]);
  });

  it('reports a legacy endpoint as not official and leaves it alone', async () => {
    const claude = new FakeClaude([
      'atlassian: https://mcp.atlassian.com/v1/sse (SSE) - ✔ Connected',
    ]);
    const result = await setupWith(claude).ensureRegistered({ confirm: yes });
    expect(result).toMatchObject({ kind: 'already-registered', official: false });
    expect(claude.adds()).toEqual([]);
  });

  it('never overwrites an unrelated server that uses the name "atlassian"', async () => {
    const claude = new FakeClaude([
      'atlassian: https://example.com/my-own-mcp (HTTP) - ✔ Connected',
      'atlassian-rovo: npx something - ✔ Connected',
    ]);
    const result = await setupWith(claude).ensureRegistered({ confirm: yes });
    expect(result).toMatchObject({ kind: 'registered', name: 'atlassian-rovo-2' });
    expect(claude.adds()).toHaveLength(1);
  });

  it('reports a missing Claude Code installation', async () => {
    const claude = new FakeClaude([], false);
    expect((await setupWith(claude).ensureRegistered({ confirm: yes })).kind).toBe(
      'claude-not-installed',
    );
  });

  it('parses claude mcp list output defensively', () => {
    const entries = parseMcpList(
      [
        'Checking MCP server health…',
        '',
        'claude.ai Atlassian: https://mcp.atlassian.com/v2/mcp - ✔ Connected',
        'atl: https://mcp.atlassian.com/v2/mcp?tools=all (HTTP) - ✗ Failed to connect',
        'pending: https://x.example/mcp - ⏸ Pending approval',
        'garbage line without separator',
      ].join('\n'),
    );
    expect(entries.map((e) => [e.name, e.url, e.health])).toEqual([
      ['claude.ai Atlassian', 'https://mcp.atlassian.com/v2/mcp', 'connected'],
      ['atl', 'https://mcp.atlassian.com/v2/mcp?tools=all', 'failed'],
      ['pending', 'https://x.example/mcp', 'pending-approval'],
    ]);
  });
});
