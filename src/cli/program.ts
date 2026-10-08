import { Command } from 'commander';
import { VERSION } from '../core/version';
import { createConnectionsCommand, createLoginCommand, createLogoutCommand } from './commands/auth';
import { createConfigCommand } from './commands/config';
import { createHistoryCommand, createRecoverCommand } from './commands/history';
import { createMcpCommand } from './commands/mcp';
import { createReportCommand } from './commands/report';
import { createDoctorCommand, createInitCommand, createUninstallCommand } from './commands/setup';
import { createSkillCommand } from './commands/skill';
import { createStatusCommand } from './commands/status';
import type { CliContext } from './context';

export function createProgram(ctx: CliContext): Command {
  const program = new Command('git2jira')
    .description('Turn Git changes into incremental, professional Jira implementation reports.')
    .version(VERSION, '-v, --version', 'print the version')
    .helpOption('-h, --help', 'show help')
    .showHelpAfterError('(run "git2jira --help" for usage)')
    // Lets "report" have options of its own without taking them from its subcommands.
    .enablePositionalOptions()
    .configureOutput({
      writeOut: (text) => ctx.stdout.write(text),
      writeErr: (text) => ctx.stderr.write(text),
    })
    .exitOverride();

  program.addCommand(createConfigCommand(ctx));
  program.addCommand(createStatusCommand(ctx));
  program.addCommand(createLoginCommand(ctx));
  program.addCommand(createLogoutCommand(ctx));
  program.addCommand(createConnectionsCommand(ctx));
  program.addCommand(createHistoryCommand(ctx));
  program.addCommand(createRecoverCommand(ctx));
  program.addCommand(createReportCommand(ctx));
  program.addCommand(createMcpCommand(ctx));
  program.addCommand(createSkillCommand(ctx));
  program.addCommand(createInitCommand(ctx));
  program.addCommand(createDoctorCommand(ctx));
  program.addCommand(createUninstallCommand(ctx));

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
