import { UsageError } from '../core/errors';
import type { ProcessRunner } from '../core/process';
import type { TestEvidence } from './analysis';

/**
 * Runs a test command the user named explicitly (`--test-command "pnpm test"`) and
 * records the outcome as verified evidence. No shell: the command is split on
 * whitespace into a program and arguments, so quotes, pipes, and variables are not
 * interpreted. Nothing found in the repository can add or change a command.
 */
export async function runTestCommand(
  runner: ProcessRunner,
  command: string,
  options: {
    cwd: string;
    now?: () => Date;
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
  },
): Promise<TestEvidence> {
  const [file, ...args] = command.trim().split(/\s+/);
  if (!file)
    throw new UsageError('--test-command needs a command, e.g. --test-command "pnpm test".');
  const now = options.now ?? (() => new Date());
  const started = now();
  const result = await runner.run(file, args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 15 * 60_000,
    maxOutputBytes: 4 * 1024 * 1024,
    ...(options.env ? { env: options.env } : {}),
  });
  const outcome: TestEvidence['outcome'] = result.timedOut
    ? 'timed-out'
    : result.notFound || result.exitCode === null
      ? 'error'
      : result.exitCode === 0
        ? 'passed'
        : 'failed';
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return {
    command: command.trim().slice(0, 500),
    outcome,
    exitCode: result.exitCode,
    source: 'git2jira',
    ranAt: started.toISOString(),
    durationMs: Math.max(0, now().getTime() - started.getTime()),
    ...(output ? { summary: output.slice(-2000) } : {}),
  };
}
