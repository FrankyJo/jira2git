/**
 * Delivery phases of the Git2Jira AI roadmap. Commands and services that are
 * not implemented yet reference the phase that will deliver them, so users get
 * an honest answer instead of a simulated success.
 */
export const PHASES = {
  0: 'Foundation and architecture',
  1: 'Git snapshots and incremental checkpoints',
  2: 'Jira integration, authentication, ADF, and publication',
  3: 'AI reporting engine and multilingual reports',
  4: 'Claude Code Skill /jira-report',
  5: 'Interactive installer, configuration, and npm packaging',
  6: 'Final QA, security audit, and release preparation',
} as const;

export type Phase = keyof typeof PHASES;
