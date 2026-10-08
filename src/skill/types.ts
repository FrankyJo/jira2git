/**
 * Installation of the global Claude Code Skill that provides `/jira-report`
 * (Phase 4). The Skill runs inside the user's existing Claude Code session:
 * it calls the `git2jira` CLI for all deterministic work (Git, checkpoints,
 * approval, publication state) and uses the session itself only to write the
 * structured report and, in MCP mode, to call the Atlassian tools. It never reads
 * credentials and never launches a nested Claude Code process. See docs/skill.md.
 */
export const SKILL_NAME = 'jira-report';
/** Read-only analysis subagent shipped with the Skill. */
export const AGENT_NAME = 'jira-reporter';
/** Written into the Skill directory; marks it as installed (and owned) by Git2Jira. */
export const MANIFEST_FILE = '.git2jira-skill.json';

export interface SkillLocation {
  /** `<claude home>/skills/jira-report`. */
  skillDir: string;
  /** `<claude home>/agents/jira-reporter.md`. */
  agentPath: string;
}

export type SkillInstallState = SkillLocation &
  (
    | { state: 'not-installed' }
    /** Installed by Git2Jira, unmodified, identical to this CLI's package. */
    | { state: 'installed'; version: string }
    /** Installed by Git2Jira, unmodified, from another version of the package. */
    | { state: 'outdated'; installedVersion: string; currentVersion: string }
    /** Installed by Git2Jira, but files were changed or removed since. */
    | {
        state: 'modified';
        installedVersion: string;
        modifiedFiles: string[];
        missingFiles: string[];
      }
    /** Something not installed by Git2Jira occupies the Skill directory or the agent file. */
    | { state: 'conflict'; reason: string; paths: string[] }
  );

export type SkillInstallAction = 'installed' | 'upgraded' | 'repaired' | 'unchanged';

export interface SkillInstallResult {
  action: SkillInstallAction;
  state: SkillInstallState;
  /** Files in the Skill directory that Git2Jira does not manage; kept as they are. */
  keptFiles: string[];
}

export interface SkillUninstallResult {
  removed: boolean;
  /** Files Git2Jira did not install, left in place (the directory stays if any). */
  keptFiles: string[];
}

export interface SkillVerification {
  ok: boolean;
  state: SkillInstallState;
  /** Reasons the installed Skill cannot be trusted to work as shipped. */
  problems: string[];
  /** Settings that weaken the approval boundary; the Skill still works. */
  warnings: string[];
}

export interface SkillInstaller {
  readonly location: SkillLocation;
  status(): Promise<SkillInstallState>;
  /**
   * Installs or upgrades. Never touches a directory or agent file that Git2Jira did not
   * install (`conflict`); replaces modified files only with `force`.
   */
  install(options?: { force?: boolean }): Promise<SkillInstallResult>;
  /** Removes only what Git2Jira installed; modified files only with `force`. */
  uninstall(options?: { force?: boolean }): Promise<SkillUninstallResult>;
  /**
   * Checks the installed files against the package and the approval boundary, and scans
   * Claude Code permission settings (`permissions.allow`, `permissions.defaultMode` only)
   * for rules that would pre-approve gated commands.
   */
  verify(options?: SkillVerifyOptions): Promise<SkillVerification>;
}

export interface SkillVerifyOptions {
  /** Project settings files to scan as well (e.g. `<repo>/.claude/settings.json`). */
  projectSettingsFiles?: readonly string[];
  /** Claude Code MCP server names that may be Atlassian servers. */
  mcpServers?: readonly string[];
}
