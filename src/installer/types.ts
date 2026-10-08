import type { Language } from '../localization/languages';
import type { Prompter } from './prompter';

/**
 * `git2jira init` (Phase 5) runs these steps in order: choose report language,
 * configure Jira site and authentication, install the Claude Code Skill, and
 * run diagnostics. Each step is idempotent and can be re-run.
 */
export interface InstallerContext {
  prompter: Prompter;
  /** Answers collected so far, available to later steps. */
  answers: Partial<InstallerAnswers>;
}

export interface InstallerAnswers {
  language: Language;
  siteUrl: string;
  authMethod: 'api-token' | 'oauth';
  installSkill: boolean;
}

export interface InstallerStep {
  readonly id: string;
  readonly title: string;
  run(context: InstallerContext): Promise<void>;
}
