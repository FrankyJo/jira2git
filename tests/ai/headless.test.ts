import { describe, expect, it } from 'vitest';
import {
  ApiBillingRefusedError,
  ClaudeCodeHeadlessProvider,
  ClaudeCodeUnavailableError,
  NestedClaudeCodeError,
} from '../../src/ai/claude-headless';
import { RecordingRunner } from '../fixtures/ai';

const PROMPT = { system: 'sys', user: 'data', schema: { type: 'object' } };
const signedIn = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
});

function runner(auth = signedIn, result: unknown = { answer: 1 }) {
  return new RecordingRunner((_file, args) => {
    if (args[0] === '--version') return { stdout: '2.1.294 (Claude Code)\n' };
    if (args[0] === 'auth') return { stdout: auth };
    return {
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '',
        structured_output: result,
      }),
    };
  });
}

describe('Claude Code headless provider', () => {
  it('never starts Claude Code from inside a Claude Code session', async () => {
    const r = runner();
    const provider = new ClaudeCodeHeadlessProvider(r, { env: { CLAUDECODE: '1' } });
    await expect(provider.complete(PROMPT)).rejects.toThrow(NestedClaudeCodeError);
    expect(r.calls).toHaveLength(0);
  });

  it('explains a missing or signed-out Claude Code', async () => {
    const missing = new RecordingRunner(() => ({ notFound: true, exitCode: null }));
    await expect(
      new ClaudeCodeHeadlessProvider(missing, { env: {} }).ensureAvailable(),
    ).rejects.toThrow(/not installed/);
    const out = runner(JSON.stringify({ loggedIn: false }));
    await expect(
      new ClaudeCodeHeadlessProvider(out, { env: {} }).ensureAvailable(),
    ).rejects.toThrow(/claude auth login/);
    const garbage = runner('not json');
    await expect(
      new ClaudeCodeHeadlessProvider(garbage, { env: {} }).ensureAvailable(),
    ).rejects.toThrow(ClaudeCodeUnavailableError);
  });

  it('refuses API-key or third-party billing unless explicitly allowed', async () => {
    const apiKey = JSON.stringify({
      loggedIn: true,
      authMethod: 'api_key',
      apiProvider: 'firstParty',
      apiKeySource: 'ANTHROPIC_API_KEY',
    });
    const bedrock = JSON.stringify({ loggedIn: true, authMethod: 'aws', apiProvider: 'bedrock' });
    for (const auth of [apiKey, bedrock]) {
      const r = runner(auth);
      await expect(new ClaudeCodeHeadlessProvider(r, { env: {} }).complete(PROMPT)).rejects.toThrow(
        ApiBillingRefusedError,
      );
      expect(r.calls.some((c) => c.args.includes('-p'))).toBe(false);
    }
    const allowed = new ClaudeCodeHeadlessProvider(runner(apiKey), {
      env: {},
      allowApiBilling: true,
    });
    await expect(allowed.complete(PROMPT)).resolves.toEqual({ answer: 1 });
    expect(allowed.describe()).toContain('API billing, explicitly allowed');
  });

  it('runs claude -p with no tools, no MCP, its own system prompt, and an empty directory', async () => {
    const r = runner();
    const provider = new ClaudeCodeHeadlessProvider(r, {
      env: { CLAUDECODE: undefined, PATH: '/bin' },
    });
    await expect(provider.complete(PROMPT)).resolves.toEqual({ answer: 1 });
    const call = r.calls.find((c) => c.args.includes('-p'));
    expect(call?.args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      '{"type":"object"}',
      '--tools',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--system-prompt',
      'sys',
    ]);
    expect(call?.options.input).toBe('data');
    expect(call?.options.cwd).toMatch(/git2jira-claude-/);
    expect(provider.describe()).toBe('Claude Code 2.1.294 (claude.ai sign-in)');
  });

  it('reports errors from Claude Code instead of inventing a report', async () => {
    const r = new RecordingRunner((_file, args) => {
      if (args[0] === '--version') return { stdout: '2.1.294' };
      if (args[0] === 'auth') return { stdout: signedIn };
      return {
        stdout: JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }),
      };
    });
    await expect(new ClaudeCodeHeadlessProvider(r, { env: {} }).complete(PROMPT)).rejects.toThrow(
      /reported an error/,
    );
  });
});
