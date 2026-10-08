import { Command } from 'commander';
import { VERSION } from '../core/version';
import { createConfigCommand } from './commands/config';
import { PLANNED_COMMANDS, createPlannedCommand } from './commands/planned';
import { createStatusCommand } from './commands/status';
import type { CliContext } from './context';

export function createProgram(ctx: CliContext): Command {
  const program = new Command('git2jira')
    .description('Turn Git changes into incremental, professional Jira implementation reports.')
    .version(VERSION, '-v, --version', 'print the version')
    .helpOption('-h, --help', 'show help')
    .showHelpAfterError('(run "git2jira --help" for usage)')
    .configureOutput({
      writeOut: (text) => ctx.stdout.write(text),
      writeErr: (text) => ctx.stderr.write(text),
    })
    .exitOverride();

  program.addCommand(createConfigCommand(ctx));
  program.addCommand(createStatusCommand(ctx));
  for (const spec of PLANNED_COMMANDS) program.addCommand(createPlannedCommand(spec));

  // Apply the same output and exit behaviour to every subcommand.
  const propagate = (command: Command): void => {
    for (const sub of command.commands) {
      sub.configureOutput(program.configureOutput()).exitOverride();
      propagate(sub);
    }
  };
  propagate(program);

  return program;
}
