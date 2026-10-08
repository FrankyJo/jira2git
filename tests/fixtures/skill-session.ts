import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createDefaultContainer } from '../../src/app/bootstrap';
import type { ServiceContainer } from '../../src/app/container';
import { repoConfigPath } from '../../src/config/paths';
import { FileConfigStore } from '../../src/config/store';
import type { ProcessRunner } from '../../src/core/process';
import type { CredentialStore } from '../../src/credentials/types';
import { runCli } from '../../src/cli/run';
import { SpawnGitRunner } from '../../src/git/runner';
import type { ClaudeMcpRegistry } from '../../src/mcp/claude-code';
import { McpVerificationStore } from '../../src/mcp/setup';
import { parseFrontmatter, stringList } from '../../src/skill/frontmatter';
import { FileSkillInstaller } from '../../src/skill/installer';
import { findSkillAssets, loadSkillPackage } from '../../src/skill/package';
import { bashRuleMatches, toolRuleMatches } from '../../src/skill/permissions';
import { MemoryStream, must } from '../helpers';
import { GitRepo } from './git-repo';

const NO_CREDENTIALS: CredentialStore = new Proxy({} as CredentialStore, {
  get: () => () => {
    throw new Error('credentials must not be used');
  },
});

const assets = must(findSkillAssets(path.dirname(fileURLToPath(import.meta.url))));

/** `allowed-tools` of the shipped SKILL.md: what the Skill runs without a prompt. */
export async function shippedAllowedTools(): Promise<string[]> {
  const skill = await readFile(path.join(assets, 'jira-report', 'SKILL.md'), 'utf8');
  return stringList(parseFrontmatter(skill).frontmatter['allowed-tools']);
}

export interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Claude Code would have asked the user before running this. */
  prompted: boolean;
  /** The user denied the permission prompt; the command did not run. */
  denied: boolean;
}

/**
 * A controlled stand-in for a Claude Code session running `/jira-report`:
 *
 * - `bash()` runs a `git2jira` command in-process, the way the Skill's Bash calls would,
 *   with JSON on stdin like the Skill's heredocs. A command not covered by the shipped
 *   `allowed-tools` goes through a permission prompt answered by `approve`, exactly the
 *   boundary Claude Code enforces.
 * - `mcpTool()` stands for an Atlassian MCP tool call: same prompt rule, results scripted
 *   by the test.
 *
 * No real Claude Code, Jira, or MCP server is involved. Git and the CLI are real.
 */
export async function createSkillSession(options: { repo?: GitRepo } = {}) {
  const repo = options.repo ?? (await GitRepo.create({ branch: 'feature/LSND-1234-profile' }));
  const allowed = await shippedAllowedTools();
  const configStore = new FileConfigStore({
    globalPath: path.join(repo.sandbox, 'cfg', 'config.json'),
    repoPath: repoConfigPath,
  });
  const claudeHome = path.join(repo.sandbox, 'claude-home');
  const clipboard: string[] = [];
  const processRunner: ProcessRunner = {
    run: (_file, _args, opts) => {
      clipboard.push(opts?.input ?? '');
      return Promise.resolve({
        stdout: '',
        stderr: '',
        exitCode: 0,
        notFound: false,
        timedOut: false,
      });
    },
  };
  const registry: ClaudeMcpRegistry = {
    version: () => Promise.resolve('2.1.294'),
    list: () => Promise.resolve([]),
    addHttpServer: () => Promise.reject(new Error('the Skill never registers servers')),
  };
  const installer = new FileSkillInstaller({
    claudeHome,
    loadPackage: () => loadSkillPackage(assets, '0.0.0-test'),
  });
  const container: ServiceContainer = createDefaultContainer()
    .register('gitRunner', () => new SpawnGitRunner({ env: repo.env }))
    .register('configStore', () => configStore)
    .register('credentialStore', () => NO_CREDENTIALS)
    .register('jiraConnections', () => {
      throw new Error('Jira connections must not be used');
    })
    .register('processRunner', () => processRunner)
    .register('claudeMcpRegistry', () => registry)
    .register(
      'mcpVerificationStore',
      () => new McpVerificationStore(path.join(repo.sandbox, 'cfg', 'mcp-verification.json')),
    )
    .register('skillInstaller', () => installer);

  const prompts: string[] = [];
  let approve: (what: string) => boolean = () => true;

  const gate = (what: string, preApproved: boolean): boolean => {
    if (preApproved) return true;
    prompts.push(what);
    return approve(what);
  };

  const session = {
    repo,
    configStore,
    installer,
    claudeHome,
    clipboard,
    /** Commands and tools that needed the user's approval, in order. */
    prompts,
    setApproval(fn: (what: string) => boolean) {
      approve = fn;
    },
    async bash(argv: string[], stdin?: unknown, cwd = repo.root): Promise<BashResult> {
      const command = `git2jira ${argv.join(' ')}`;
      const preApproved = allowed.some((rule) => bashRuleMatches(rule, command));
      if (!gate(command, preApproved)) {
        return { exitCode: 1, stdout: '', stderr: 'denied', prompted: true, denied: true };
      }
      const stdout = new MemoryStream();
      const stderr = new MemoryStream();
      const input = stdin === undefined ? undefined : JSON.stringify(stdin);
      const exitCode = await runCli(argv, {
        container,
        cwd,
        stdout,
        stderr,
        interactive: false,
        env: { CLAUDECODE: '1' },
        ...(input === undefined ? {} : { stdin: Readable.from([Buffer.from(input)]) }),
      });
      return {
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        prompted: !preApproved,
        denied: false,
      };
    },
    /** `bash` that must succeed and print JSON. */
    async json<T = Record<string, unknown>>(
      argv: string[],
      stdin?: unknown,
      cwd?: string,
    ): Promise<T> {
      const result = await session.bash(argv, stdin, cwd);
      if (result.exitCode !== 0) {
        throw new Error(`${argv.join(' ')} failed (${String(result.exitCode)}): ${result.stderr}`);
      }
      return JSON.parse(result.stdout) as T;
    },
    /** An MCP tool call. Returns undefined when the user denied the prompt. */
    mcpTool<T>(tool: string, result: () => T): T | undefined {
      const preApproved = allowed.some((rule) => toolRuleMatches(rule, tool));
      return gate(tool, preApproved) ? result() : undefined;
    },
    async cleanup() {
      await repo.cleanup();
    },
  };
  return session;
}

export type SkillSession = Awaited<ReturnType<typeof createSkillSession>>;
