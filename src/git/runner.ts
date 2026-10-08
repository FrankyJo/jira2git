import { spawn } from 'node:child_process';
import { GitCommandError, GitNotFoundError, GitOutputLimitError } from './errors';
import type { GitCommandOptions, GitCommandResult, GitCommandRunner } from './types';

/**
 * Inherited variables that would redirect git to a different repository,
 * index, or object store, or run external programs. They are removed so every
 * command operates exactly on the repository and index we name explicitly.
 */
const STRIPPED_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'PAGER',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
];

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface SpawnGitRunnerOptions {
  /** Path or name of the git executable. */
  gitBinary?: string;
  /** Base environment; defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Runs git with `spawn(..., { shell: false })` and an argument array. Output is
 * collected as bytes and bounded. Never interpolates arguments into a shell.
 */
export class SpawnGitRunner implements GitCommandRunner {
  private readonly gitBinary: string;
  private readonly baseEnv: Record<string, string>;

  constructor(options: SpawnGitRunnerOptions = {}) {
    this.gitBinary = options.gitBinary ?? 'git';
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env ?? process.env)) {
      if (value !== undefined && !STRIPPED_ENV.includes(key)) env[key] = value;
    }
    this.baseEnv = {
      ...env,
      GIT_TERMINAL_PROMPT: '0',
      // Read-only commands must not refresh or lock the user's index.
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
      LANG: 'C',
    };
  }

  run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult> {
    // core.fsmonitor names a program git would run on index operations; a repository's local
    // config must not be able to make Git2Jira execute anything.
    const fullArgs = [
      '--no-pager',
      '-c',
      'color.ui=never',
      '-c',
      'core.quotePath=false',
      '-c',
      'core.fsmonitor=false',
      ...args,
    ];
    const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    return new Promise((resolve, reject) => {
      const child = spawn(this.gitBinary, fullArgs, {
        cwd: options.cwd,
        env: { ...this.baseEnv, ...options.env },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let truncated = false;
      let overflow = false;

      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated || overflow) return;
        const remaining = limit - stdoutBytes;
        if (chunk.length <= remaining) {
          stdout.push(chunk);
          stdoutBytes += chunk.length;
          return;
        }
        if (options.truncateOutput) {
          stdout.push(chunk.subarray(0, remaining));
          stdoutBytes = limit;
          truncated = true;
        } else {
          overflow = true;
        }
        child.kill();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.reduce((n, b) => n + b.length, 0) < 1024 * 1024) stderr.push(chunk);
      });

      child.on('error', (error: NodeJS.ErrnoException) => {
        reject(error.code === 'ENOENT' ? new GitNotFoundError({ cause: error }) : error);
      });

      child.on('close', (code) => {
        if (overflow) {
          reject(new GitOutputLimitError(args, limit));
          return;
        }
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          // A command we killed after truncating its output counts as success.
          exitCode: truncated ? 0 : (code ?? 1),
          truncated,
        });
      });

      child.stdin.on('error', () => {
        // The child may exit before consuming stdin; the exit code reports the real outcome.
      });
      child.stdin.end(options.input ?? '');
    });
  }
}

/** Runs git and throws GitCommandError on a non-zero exit. */
export async function gitOutput(
  runner: GitCommandRunner,
  args: readonly string[],
  options: GitCommandOptions,
): Promise<string> {
  const result = await runner.run(args, options);
  if (result.exitCode !== 0) throw new GitCommandError(args, result.exitCode, result.stderr);
  return result.stdout;
}

/** Runs git and returns trimmed stdout, or `undefined` when git exits with one of `allowedCodes`. */
export async function gitOptional(
  runner: GitCommandRunner,
  args: readonly string[],
  options: GitCommandOptions,
  allowedCodes: readonly number[] = [1],
): Promise<string | undefined> {
  const result = await runner.run(args, options);
  if (result.exitCode === 0) return result.stdout.trim();
  if (allowedCodes.includes(result.exitCode)) return undefined;
  throw new GitCommandError(args, result.exitCode, result.stderr);
}

/** Splits NUL-delimited git output, dropping the trailing terminator. */
export function splitNul(output: string): string[] {
  const parts = output.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}
