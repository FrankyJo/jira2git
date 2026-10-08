import type { DeliveryMode } from '../delivery/mode';
import type { Language } from '../localization/languages';
import type { Prompter } from './prompter';

/**
 * `git2jira init` (Phase 5) runs these steps in order: report language, Jira mode
 * (Atlassian MCP or manual; API token only as an optional legacy choice), Claude Code
 * Skill, diagnostics. Each step is idempotent and can be re-run. The language and Jira
 * mode steps exist now (src/installer/steps.ts); the wizard command is Phase 5.
 */
export interface InstallerContext {
  prompter: Prompter;
  /** Answers collected so far, available to later steps. */
  answers: Partial<InstallerAnswers>;
}

export interface InstallerAnswers {
  language: Language;
  /** What the user chose; `jiraMode` is what was configured after any fallback. */
  requestedJiraMode: Exclude<DeliveryMode, 'api-token'>;
  jiraMode: DeliveryMode;
  /** Claude Code MCP server name, when MCP mode was configured. */
  mcpServer?: string;
  /** Why MCP mode was not configured, when the step fell back to manual. */
  fallbackReason?: string;
  installSkill: boolean;
}

export interface InstallerStep {
  readonly id: string;
  readonly title: string;
  run(context: InstallerContext): Promise<void>;
}
