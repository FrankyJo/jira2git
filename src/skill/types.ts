/**
 * Installation of the global Claude Code Skill that provides `/jira-report`
 * (Phase 4). The Skill runs inside the user's existing Claude Code session:
 * it calls the `git2jira` CLI for all deterministic work (Git, checkpoints,
 * Jira, approval, publication) and uses the session itself only to write the
 * structured report. It never reads credentials and never launches a nested
 * Claude Code process. See docs/architecture.md.
 */
export const SKILL_NAME = 'jira-report';

export type SkillInstallState =
  | { state: 'installed'; path: string; version: string }
  | { state: 'outdated'; path: string; installedVersion: string; currentVersion: string }
  | { state: 'not-installed'; path: string };

export interface SkillInstaller {
  /** User-level skills directory, e.g. `~/.claude/skills/jira-report`. */
  readonly targetDir: string;
  status(): Promise<SkillInstallState>;
  install(): Promise<SkillInstallState>;
  uninstall(): Promise<boolean>;
}
