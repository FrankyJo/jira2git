import { CommanderError } from 'commander';
import { ExitCode, Git2JiraError } from '../core/errors';
import { println, type CliContext } from './context';
import { createProgram } from './program';

/** Runs the CLI and returns the process exit code. Never calls process.exit itself. */
export async function runCli(argv: readonly string[], ctx: CliContext): Promise<number> {
  const program = createProgram(ctx);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return ExitCode.Success;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and version are reported by Commander as "errors" with exit code 0.
      return error.exitCode === 0 ? ExitCode.Success : ExitCode.Usage;
    }
    if (error instanceof Git2JiraError) {
      println(ctx.stderr, `git2jira: ${error.message}`);
      return error.exitCode;
    }
    println(
      ctx.stderr,
      `git2jira: unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (process.env.GIT2JIRA_DEBUG && error instanceof Error && error.stack)
      println(ctx.stderr, error.stack);
    return ExitCode.Failure;
  }
}
