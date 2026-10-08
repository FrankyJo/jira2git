import { AuthStatusSchema, SUBSCRIPTION_METHODS } from '../ai/claude-headless';
import type { ProcessRunner } from '../core/process';
import { terminalSafeLine } from '../core/sanitize';

/**
 * What `git2jira init` and `git2jira doctor` learn about the machine. Everything comes
 * from version commands and `claude auth status --json`; Claude Code's own files and
 * credentials are never read.
 */
export const REQUIRED_NODE = { major: 22, minor: 12 } as const;

export interface ToolInfo {
  installed: boolean;
  version?: string;
}

export type ClaudeAuthState =
  | { state: 'not-installed' }
  | { state: 'signed-in'; method: string; billing: 'subscription' | 'api'; detail: string }
  | { state: 'signed-out' }
  /** `claude auth status` failed or printed something unreadable. */
  | { state: 'unknown'; detail: string };

export interface EnvironmentReport {
  os: { platform: NodeJS.Platform; release: string; arch: string };
  node: { version: string; supported: boolean };
  git: ToolInfo;
  claude: ToolInfo;
  claudeAuth: ClaudeAuthState;
  /** `ANTHROPIC_API_KEY` is set: Claude Code may bill an API account instead of a subscription. */
  anthropicApiKeySet: boolean;
  /** The `git2jira` that `/jira-report` will run: the one on PATH. */
  cliOnPath: ToolInfo & { matchesThisCli: boolean };
  /** Running through `npx` (a temporary copy that `/jira-report` cannot call later). */
  viaNpx: boolean;
}

export interface EnvironmentProbeOptions {
  runner: ProcessRunner;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  release: string;
  arch: string;
  nodeVersion: string;
  cliVersion: string;
  /** Path of the running script (`process.argv[1]`), for npx detection. */
  scriptPath?: string | undefined;
}

export class EnvironmentProbe {
  constructor(private readonly options: EnvironmentProbeOptions) {}

  async inspect(): Promise<EnvironmentReport> {
    const { options } = this;
    const [git, claude, cliOnPath] = await Promise.all([
      this.version('git', ['--version']),
      this.version('claude', ['--version']),
      this.version(options.platform === 'win32' ? 'git2jira.cmd' : 'git2jira', ['--version']),
    ]);
    return {
      os: { platform: options.platform, release: options.release, arch: options.arch },
      node: { version: options.nodeVersion, supported: nodeSupported(options.nodeVersion) },
      git,
      claude,
      claudeAuth: claude.installed ? await this.claudeAuth() : { state: 'not-installed' },
      anthropicApiKeySet: Boolean(options.env.ANTHROPIC_API_KEY),
      cliOnPath: { ...cliOnPath, matchesThisCli: cliOnPath.version === options.cliVersion },
      viaNpx:
        options.env.npm_command === 'exec' ||
        /[\\/]_npx[\\/]/.test(options.scriptPath ?? '') ||
        /[\\/]dlx-[^\\/]+[\\/]/.test(options.scriptPath ?? ''),
    };
  }

  private async version(file: string, args: string[]): Promise<ToolInfo> {
    const result = await this.options.runner.run(file, args, {
      timeoutMs: 15_000,
      env: this.childEnv(),
    });
    if (result.notFound || result.exitCode !== 0) return { installed: false };
    const version = /\d+\.\d+\.\d+[^\s)]*/.exec(result.stdout)?.[0];
    return version === undefined ? { installed: true } : { installed: true, version };
  }

  private async claudeAuth(): Promise<ClaudeAuthState> {
    const result = await this.options.runner.run('claude', ['auth', 'status', '--json'], {
      timeoutMs: 30_000,
      env: this.childEnv(),
    });
    let parsed;
    try {
      const value = AuthStatusSchema.safeParse(JSON.parse(result.stdout));
      parsed = value.success ? value.data : undefined;
    } catch {
      parsed = undefined;
    }
    if (!parsed) {
      return {
        state: 'unknown',
        detail: terminalSafeLine(result.stderr || result.stdout || 'no output', 200),
      };
    }
    if (!parsed.loggedIn) return { state: 'signed-out' };
    const method = terminalSafeLine(parsed.authMethod ?? 'unknown', 40);
    const provider = parsed.apiProvider ?? 'firstParty';
    const subscription =
      provider === 'firstParty' &&
      SUBSCRIPTION_METHODS.has(parsed.authMethod ?? '') &&
      !parsed.apiKeySource;
    const detail =
      provider !== 'firstParty'
        ? `provider ${terminalSafeLine(provider, 40)}`
        : parsed.apiKeySource
          ? `API key from ${terminalSafeLine(parsed.apiKeySource, 60)}`
          : `${method} sign-in${parsed.subscriptionType ? ` (${terminalSafeLine(parsed.subscriptionType, 30)})` : ''}`;
    return { state: 'signed-in', method, billing: subscription ? 'subscription' : 'api', detail };
  }

  /** Without `CLAUDECODE`, so `claude` answers as it would in the user's terminal. */
  private childEnv(): Record<string, string | undefined> {
    const { CLAUDECODE: _session, ...rest } = this.options.env;
    return rest;
  }
}

export function nodeSupported(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (
    major > REQUIRED_NODE.major || (major === REQUIRED_NODE.major && minor >= REQUIRED_NODE.minor)
  );
}

/** Official places to get what is missing. */
export const GUIDANCE = {
  node: 'Install Node.js 22.12 or newer: https://nodejs.org/en/download',
  git: 'Install Git: https://git-scm.com/downloads',
  claude:
    'Install Claude Code: https://docs.anthropic.com/en/docs/claude-code/setup (then run "claude" once).',
  claudeAuth: 'Sign in to Claude Code: run "claude auth login", or /login inside Claude Code.',
  apiKey:
    'ANTHROPIC_API_KEY is set. Claude Code may use it instead of your Claude subscription, which bills ' +
    'an API account. Unset it if you want subscription billing; Git2Jira never switches billing for you.',
  cliOnPath:
    '/jira-report runs "git2jira" from your PATH. Install the CLI globally: npm install -g git2jira-ai',
} as const;
