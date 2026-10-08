import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ExitCode, Git2JiraError } from '../core/errors';
import type { ProcessRunner } from '../core/process';
import { terminalSafeLine } from '../core/sanitize';
import type { ReportPrompt } from './prompt';
import type { AIReportProvider } from './types';

/**
 * Report writer for the standalone CLI: Claude Code's documented non-interactive mode,
 * `claude -p --output-format json --json-schema <schema>`, signed in with the user's own
 * Claude Code account. Checked against Claude Code 2.1.294.
 *
 * - Never started from inside a Claude Code session (`CLAUDECODE` is set there): the
 *   session itself writes the report (Skill hand-off), so there is no nested process.
 * - Never reads Claude Code's files or credentials. It asks `claude auth status --json`
 *   how Claude Code would authenticate, and refuses API-key or third-party billing
 *   unless the user explicitly allowed it for this run.
 * - The child runs with no tools (`--tools ""`), no MCP servers (`--strict-mcp-config`),
 *   no skills, no session persistence, a replaced system prompt, and an empty working
 *   directory, so repository files such as CLAUDE.md are not loaded as instructions.
 */
export class ClaudeCodeUnavailableError extends Git2JiraError {}

export class ApiBillingRefusedError extends Git2JiraError {
  constructor(detail: string) {
    super(
      `Claude Code would bill this report to an API account (${detail}), not to your Claude subscription. ` +
        'Git2Jira does not switch billing silently. Unset the API key or provider setting and sign in with ' +
        '"claude auth login", or rerun with --allow-api-billing to accept API billing for this run.',
      ExitCode.Failure,
    );
  }
}

export class NestedClaudeCodeError extends Git2JiraError {
  constructor() {
    super(
      'This command runs inside a Claude Code session. Git2Jira does not start another Claude Code ' +
        'process from there: the session writes the report itself. Use "git2jira report" without ' +
        '--ai headless (it prepares the request for the session), or /jira-report.',
      ExitCode.Usage,
    );
  }
}

/** `claude auth status --json`: only the fields needed to decide billing. */
const AuthStatusSchema = z.looseObject({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  apiProvider: z.string().optional(),
  apiKeySource: z.string().optional(),
  subscriptionType: z.string().optional(),
});

/** `claude -p --output-format json` result envelope. */
const ResultEnvelopeSchema = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
});

/** Sign-in methods that use the user's Claude subscription. */
const SUBSCRIPTION_METHODS = new Set(['claude.ai', 'oauth', 'oauth_token', 'subscription']);

export interface HeadlessOptions {
  executable?: string;
  /** Environment of this process; used for nesting detection and passed to the child. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The user explicitly accepted API-key or third-party billing for this run. */
  allowApiBilling?: boolean;
  model?: string | undefined;
  timeoutMs?: number;
}

export class ClaudeCodeHeadlessProvider implements AIReportProvider {
  readonly mode = 'headless' as const;
  private readonly executable: string;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private checked: string | undefined;

  constructor(
    private readonly runner: ProcessRunner,
    private readonly options: HeadlessOptions = {},
  ) {
    this.executable = options.executable ?? 'claude';
    this.env = options.env ?? process.env;
  }

  describe(): string {
    return this.checked ?? 'Claude Code (not checked yet)';
  }

  async ensureAvailable(): Promise<void> {
    if (this.checked) return;
    if (this.env.CLAUDECODE) throw new NestedClaudeCodeError();

    const version = await this.runner.run(this.executable, ['--version'], {
      timeoutMs: 15_000,
      env: this.childEnv(),
    });
    if (version.notFound || version.exitCode !== 0) {
      throw new ClaudeCodeUnavailableError(
        'Claude Code ("claude") is not installed or does not start. Install it, sign in with "claude auth login", ' +
          'or write the report inside Claude Code with /jira-report.',
      );
    }
    const versionText = /\d+\.\d+\.\d+/.exec(version.stdout)?.[0] ?? 'unknown version';

    const status = await this.runner.run(this.executable, ['auth', 'status', '--json'], {
      timeoutMs: 30_000,
      env: this.childEnv(),
    });
    let parsed: z.infer<typeof AuthStatusSchema> | undefined;
    try {
      const result = AuthStatusSchema.safeParse(JSON.parse(status.stdout));
      parsed = result.success ? result.data : undefined;
    } catch {
      parsed = undefined;
    }
    if (!parsed) {
      throw new ClaudeCodeUnavailableError(
        `Could not read the sign-in status of Claude Code ${versionText} ("claude auth status --json"). ` +
          'Update Claude Code, or write the report inside Claude Code with /jira-report.',
      );
    }
    if (!parsed.loggedIn) {
      throw new ClaudeCodeUnavailableError(
        'Claude Code is not signed in. Run "claude auth login" (or /login inside Claude Code), then try again.',
      );
    }
    const method = parsed.authMethod ?? 'unknown';
    const provider = parsed.apiProvider ?? 'firstParty';
    const subscription =
      provider === 'firstParty' && SUBSCRIPTION_METHODS.has(method) && !parsed.apiKeySource;
    if (!subscription && !this.options.allowApiBilling) {
      const detail =
        provider !== 'firstParty'
          ? `provider ${terminalSafeLine(provider, 40)}`
          : parsed.apiKeySource
            ? `API key from ${terminalSafeLine(parsed.apiKeySource, 60)}`
            : `sign-in method ${terminalSafeLine(method, 40)}`;
      throw new ApiBillingRefusedError(detail);
    }
    this.checked = `Claude Code ${versionText} (${subscription ? `${terminalSafeLine(method, 30)} sign-in` : 'API billing, explicitly allowed'})`;
  }

  async complete(prompt: ReportPrompt): Promise<unknown> {
    await this.ensureAvailable();
    // An empty directory: no CLAUDE.md, settings, or files from the analyzed repository.
    const cwd = await mkdtemp(path.join(tmpdir(), 'git2jira-claude-'));
    try {
      const args = [
        '-p',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(prompt.schema),
        '--tools',
        '',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--system-prompt',
        prompt.system,
        ...(this.options.model ? ['--model', this.options.model] : []),
      ];
      const result = await this.runner.run(this.executable, args, {
        input: prompt.user,
        env: this.childEnv(),
        cwd,
        timeoutMs: this.options.timeoutMs ?? 10 * 60_000,
        maxOutputBytes: 8 * 1024 * 1024,
      });
      if (result.timedOut) {
        throw new ClaudeCodeUnavailableError('Claude Code did not finish the report in time.');
      }
      let envelope: z.infer<typeof ResultEnvelopeSchema> | undefined;
      try {
        const parsed = ResultEnvelopeSchema.safeParse(JSON.parse(result.stdout));
        envelope = parsed.success ? parsed.data : undefined;
      } catch {
        envelope = undefined;
      }
      if (!envelope) {
        throw new ClaudeCodeUnavailableError(
          `Claude Code did not return a result (exit code ${String(result.exitCode)}): ${terminalSafeLine(result.stderr || result.stdout, 300)}`,
        );
      }
      if (envelope.is_error || envelope.subtype !== 'success') {
        throw new ClaudeCodeUnavailableError(
          `Claude Code reported an error (${terminalSafeLine(envelope.subtype, 60)}): ${terminalSafeLine(envelope.result ?? '', 300)}`,
        );
      }
      if (envelope.structured_output !== undefined) return envelope.structured_output;
      try {
        return JSON.parse(envelope.result ?? '') as unknown;
      } catch {
        throw new ClaudeCodeUnavailableError('Claude Code returned text instead of a JSON report.');
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  /** The caller's environment, minus the variable that marks a Claude Code session. */
  private childEnv(): Record<string, string | undefined> {
    const { CLAUDECODE: _session, ...rest } = this.env;
    return rest;
  }
}
