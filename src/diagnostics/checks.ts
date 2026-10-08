import type { GlobalConfig, RepoConfig } from '../config/schema';
import type { DeliveryMode } from '../delivery/mode';
import type { LanguageSource } from '../localization/resolve';
import type { Language } from '../localization/languages';
import type { McpRegistrationState } from '../mcp/setup';
import type { McpVerificationRecord } from '../mcp/verification';
import type { SkillInstallState } from '../skill/types';
import { GUIDANCE, type EnvironmentReport } from './environment';
import type { DiagnosticCheck, DiagnosticResult, DiagnosticsRunner } from './types';

/**
 * `git2jira doctor` checks. Each one reports what it could establish and says so when it
 * could not: an unverifiable item is `warn` (or `skip` when it does not apply), never
 * `pass`. MCP access is split into four separate facts, because registration, OAuth,
 * read access, and write access are proven by different evidence.
 */
export interface DoctorInputs {
  environment: () => Promise<EnvironmentReport>;
  skill: () => Promise<SkillInstallState>;
  /** Global and repository configuration; throws if a file is invalid. */
  config: () => Promise<{ global: GlobalConfig; repo: RepoConfig; globalPath: string }>;
  language: (
    global: GlobalConfig,
    repo: RepoConfig,
  ) => { language: Language; source: LanguageSource };
  mode: (global: GlobalConfig, repo: RepoConfig) => { mode: DeliveryMode; source: string };
  credentialStore: () => Promise<{ available: boolean; backend: string }>;
  connections: () => Promise<string[]>;
  mcpRegistration: (server: string) => Promise<McpRegistrationState>;
  lastVerification: () => Promise<McpVerificationRecord | undefined>;
  cliVersion: string;
}

const pass = (message: string): DiagnosticResult => ({ status: 'pass', message });
const warn = (message: string, remedy?: string): DiagnosticResult =>
  remedy === undefined ? { status: 'warn', message } : { status: 'warn', message, remedy };
const fail = (message: string, remedy?: string): DiagnosticResult =>
  remedy === undefined ? { status: 'fail', message } : { status: 'fail', message, remedy };
const skip = (message: string): DiagnosticResult => ({ status: 'skip', message });

function check(id: string, title: string, run: () => Promise<DiagnosticResult>): DiagnosticCheck {
  return { id, title, run };
}

export function doctorChecks(inputs: DoctorInputs): DiagnosticCheck[] {
  // Shared lazily so every check sees the same snapshot of the machine and config.
  let env: Promise<EnvironmentReport> | undefined;
  let cfg: ReturnType<DoctorInputs['config']> | undefined;
  const environment = () => (env ??= inputs.environment());
  const config = () => (cfg ??= inputs.config());
  const mode = async () => {
    const { global, repo } = await config();
    return inputs.mode(global, repo);
  };
  let registration: Promise<McpRegistrationState> | undefined;
  const mcpRegistration = async () => {
    const { global } = await config();
    return (registration ??= inputs.mcpRegistration(global.mcp?.server ?? 'atlassian'));
  };

  return [
    check('cli', 'Git2Jira CLI', async () => {
      const { node, cliOnPath, viaNpx } = await environment();
      if (!node.supported) {
        return fail(`Node.js ${node.version} is too old.`, GUIDANCE.node);
      }
      if (!cliOnPath.installed) {
        // /jira-report runs `git2jira` from PATH; without it the Skill cannot work.
        return fail(
          `git2jira ${inputs.cliVersion} runs${viaNpx ? ' through npx' : ''}, but "git2jira" is not on PATH.`,
          GUIDANCE.cliOnPath,
        );
      }
      if (!cliOnPath.matchesThisCli) {
        return warn(
          `"git2jira" on PATH is ${cliOnPath.version ?? 'an unknown version'}; this is ${inputs.cliVersion}.`,
          'Install the same version globally (npm install -g git2jira-ai), then "git2jira skill install".',
        );
      }
      return pass(`git2jira ${inputs.cliVersion} on PATH; Node.js ${node.version}`);
    }),
    check('os', 'Operating system', async () => {
      const { os } = await environment();
      return pass(`${os.platform} ${os.release} (${os.arch})`);
    }),
    check('git', 'Git', async () => {
      const { git } = await environment();
      return git.installed
        ? pass(`git ${git.version ?? ''}`.trim())
        : fail('Git is not installed.', GUIDANCE.git);
    }),
    check('claude', 'Claude Code', async () => {
      const { claude } = await environment();
      return claude.installed
        ? pass(`Claude Code ${claude.version ?? ''}`.trim())
        : fail('Claude Code is not installed; /jira-report needs it.', GUIDANCE.claude);
    }),
    check('claude-auth', 'Claude Code sign-in', async () => {
      const { claudeAuth, anthropicApiKeySet } = await environment();
      switch (claudeAuth.state) {
        case 'not-installed':
          return skip('Claude Code is not installed.');
        case 'signed-out':
          return warn('Claude Code is not signed in.', GUIDANCE.claudeAuth);
        case 'unknown':
          return warn(
            `The sign-in status could not be read (${claudeAuth.detail}).`,
            GUIDANCE.claudeAuth,
          );
        case 'signed-in':
          if (claudeAuth.billing === 'api' || anthropicApiKeySet) {
            return warn(
              `Signed in (${claudeAuth.detail}); usage may be billed to an API account.`,
              GUIDANCE.apiKey,
            );
          }
          return pass(`Signed in (${claudeAuth.detail})`);
      }
    }),
    check('skill', '/jira-report Skill', async () => {
      const state = await inputs.skill();
      switch (state.state) {
        case 'installed':
          return pass(`installed (${state.version}) in ${state.skillDir}`);
        case 'not-installed':
          return fail('not installed', 'Run "git2jira skill install".');
        case 'outdated':
          return warn(
            `version ${state.installedVersion} installed; this CLI ships ${state.currentVersion}`,
            'Run "git2jira skill install" to upgrade.',
          );
        case 'modified':
          return warn(
            `changed since installation (${[...state.modifiedFiles, ...state.missingFiles].join(', ')})`,
            'Run "git2jira skill install --force" to restore it.',
          );
        case 'conflict':
          return fail(
            state.reason,
            `Move ${state.paths.join(', ')} away, then run "git2jira skill install".`,
          );
      }
    }),
    check('config', 'Configuration', async () => {
      try {
        const { globalPath } = await config();
        return pass(globalPath);
      } catch (error) {
        return fail((error as Error).message, 'Fix or remove the file named above.');
      }
    }),
    check('language', 'Report language', async () => {
      const { global, repo } = await config();
      const { language, source } = inputs.language(global, repo);
      return pass(`${language} (${source})`);
    }),
    check('mode', 'Delivery mode', async () => {
      const { mode: value, source } = await mode();
      return pass(`${value} (${source})`);
    }),
    check('credentials', 'Secure credential storage', async () => {
      const { mode: value } = await mode();
      if (value !== 'api-token') return skip(`not needed in ${value} mode`);
      const store = await inputs.credentialStore();
      if (!store.available) {
        return fail(
          `${store.backend} is not available.`,
          'API-token mode needs the OS credential store; use manual or MCP mode instead.',
        );
      }
      const connections = await inputs.connections();
      return connections.length > 0
        ? pass(`${store.backend}; connections: ${connections.join(', ')}`)
        : fail('no Jira connection is configured', 'Run "git2jira login".');
    }),
    check('mcp-installed', 'Atlassian MCP: registered in Claude Code', async () => {
      const { mode: value } = await mode();
      if (value !== 'mcp') return skip(`not used in ${value} mode`);
      const state = await mcpRegistration();
      switch (state.kind) {
        case 'claude-not-installed':
          return fail('Claude Code is not installed.', GUIDANCE.claude);
        case 'unknown':
          return warn(`"claude mcp list" failed: ${state.error}`);
        case 'not-registered':
          return fail('no Atlassian MCP server is registered', 'Run "git2jira mcp setup".');
        case 'registered':
          return state.official
            ? pass(`"${state.entry.name}" ${state.entry.url ?? state.entry.target}`)
            : warn(
                `"${state.entry.name}" uses ${state.entry.url ?? state.entry.target}, not the current endpoint`,
                'Re-add it with https://mcp.atlassian.com/v2/mcp.',
              );
      }
    }),
    check('mcp-authenticated', 'Atlassian MCP: OAuth authorization', async () => {
      const { mode: value } = await mode();
      if (value !== 'mcp') return skip(`not used in ${value} mode`);
      const state = await mcpRegistration();
      if (state.kind !== 'registered') return skip('no registered server');
      // Claude Code's own health check is the only outside view of the OAuth state.
      switch (state.entry.health) {
        case 'connected':
          return pass(`Claude Code reports "${state.entry.status}"`);
        case 'needs-authentication':
          return warn(
            'not authorized yet (Claude Code reports that it needs authentication)',
            `In Claude Code run /mcp, select "${state.entry.name}", and choose Authenticate.`,
          );
        case 'failed':
          return warn(
            `Claude Code reports "${state.entry.status}"`,
            'Check the connection with /mcp in Claude Code. If your organization restricts Rovo MCP, use manual mode.',
          );
        default:
          return warn(
            `cannot be verified from outside Claude Code (status: "${state.entry.status}")`,
            'Run /jira-report --mode mcp; it checks access with read-only calls.',
          );
      }
    }),
    check('jira-read', 'Atlassian MCP: Jira read access', async () => {
      const { mode: value } = await mode();
      if (value !== 'mcp') return skip(`not used in ${value} mode`);
      const record = await inputs.lastVerification();
      if (!record) {
        return warn(
          'not verified yet',
          'Run /jira-report --mode mcp in Claude Code; it reads the issue before anything else.',
        );
      }
      switch (record.state) {
        case 'ready':
        case 'read-only':
          return pass(`verified ${record.verifiedAt} (${record.state})`);
        case 'blocked-by-policy':
          return fail(
            `blocked by an organization policy (checked ${record.verifiedAt})`,
            'Ask your Atlassian administrator, or use manual mode: git2jira config set jira.mode manual',
          );
        case 'not-authenticated':
        case 'no-tools':
          return warn(
            `not available at the last check (${record.state}, ${record.verifiedAt})`,
            'Authorize the server with /mcp in Claude Code, then run /jira-report again.',
          );
        default:
          return warn(`last check: ${record.state} (${record.verifiedAt})`, record.messages[0]);
      }
    }),
    check('jira-write', 'Atlassian MCP: comment creation', async () => {
      const { mode: value } = await mode();
      if (value !== 'mcp') return skip(`not used in ${value} mode`);
      const record = await inputs.lastVerification();
      if (!record) return warn('not verified yet (no access check has run)');
      if (record.state === 'ready') {
        // Seeing the tool is not proof that Jira accepts a write; the first publication is.
        return pass(
          `the comment tool is available (since ${record.verifiedAt}); writing itself is confirmed by the first publication`,
        );
      }
      if (record.state === 'read-only') {
        return warn(
          'the comment tool is not available (read-only access)',
          'Your organization or the server configuration does not grant write access; manual mode still works.',
        );
      }
      return warn(`unknown (last check: ${record.state})`);
    }),
  ];
}

export class SequentialDiagnosticsRunner implements DiagnosticsRunner {
  async run(
    checks: readonly DiagnosticCheck[],
  ): Promise<{ check: DiagnosticCheck; result: DiagnosticResult }[]> {
    const results: { check: DiagnosticCheck; result: DiagnosticResult }[] = [];
    for (const item of checks) {
      let result: DiagnosticResult;
      try {
        result = await item.run();
      } catch (error) {
        result = fail(`check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      results.push({ check: item, result });
    }
    return results;
  }
}

/** One-line verdict that never says "all good" when something was not verified. */
export function doctorSummary(results: readonly { result: DiagnosticResult }[]): {
  ok: boolean;
  text: string;
} {
  const count = (status: DiagnosticResult['status']) =>
    results.filter((r) => r.result.status === status).length;
  const failed = count('fail');
  const warned = count('warn');
  if (failed > 0) {
    return {
      ok: false,
      text: `${String(failed)} problem(s) found${warned > 0 ? `, ${String(warned)} item(s) need attention or could not be verified` : ''}.`,
    };
  }
  if (warned > 0) {
    return {
      ok: true,
      text: `No problems found, but ${String(warned)} item(s) need attention or could not be verified.`,
    };
  }
  return { ok: true, text: 'All applicable checks passed.' };
}
