import { Command, Option } from 'commander';
import { NotImplementedError } from '../../core/errors';
import type { Phase } from '../../core/phases';
import { SUPPORTED_LANGUAGES } from '../../localization/languages';

interface PlannedCommand {
  name: string;
  description: string;
  phase: Phase;
  configure?: (command: Command) => void;
}

/**
 * Commands that are part of the public CLI surface but delivered by later
 * phases. They are registered so `--help` documents the product, and they
 * exit with ExitCode.NotImplemented instead of pretending to succeed.
 */
export const PLANNED_COMMANDS: readonly PlannedCommand[] = [
  {
    name: 'init',
    description: 'Interactive setup: report language, Jira connection, Claude Code Skill.',
    phase: 5,
  },
  { name: 'doctor', description: 'Diagnose the installation and environment.', phase: 5 },
  { name: 'login', description: 'Connect to Jira Cloud and store credentials securely.', phase: 2 },
  { name: 'logout', description: 'Remove stored Jira credentials.', phase: 2 },
  {
    name: 'status',
    description: 'Show the issue, last published report, and pending changes for this branch.',
    phase: 2,
  },
  {
    name: 'report',
    description: 'Generate, preview, and publish an incremental Jira report.',
    phase: 3,
    configure: (command) =>
      command.addOption(
        new Option('-l, --language <code>', 'report language for this run').choices(
          SUPPORTED_LANGUAGES,
        ),
      ),
  },
  { name: 'history', description: 'List reports published for the current issue.', phase: 2 },
  {
    name: 'recover',
    description: 'Reconcile interrupted publications and rebuild lost checkpoints.',
    phase: 2,
  },
  {
    name: 'uninstall',
    description: 'Remove the Claude Code Skill, credentials, and local configuration.',
    phase: 5,
  },
];

export function createPlannedCommand(spec: PlannedCommand): Command {
  const command = new Command(spec.name).description(`${spec.description} [Phase ${spec.phase}]`);
  spec.configure?.(command);
  return command.action(() => {
    throw new NotImplementedError(`"git2jira ${spec.name}"`, spec.phase);
  });
}
