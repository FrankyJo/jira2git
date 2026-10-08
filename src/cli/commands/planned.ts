import { Command } from 'commander';
import { NotImplementedError } from '../../core/errors';
import type { Phase } from '../../core/phases';

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
    description: 'Interactive setup: report language, Jira mode (Atlassian MCP or manual), Skill.',
    phase: 5,
  },
  { name: 'doctor', description: 'Diagnose the installation and environment.', phase: 5 },
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
