import type { IssueKey } from '../git/types';
import type { Language } from '../localization/languages';
import type { StructuredReport } from '../report/schema';
import type { ChangeSet } from '../snapshots/types';

/**
 * Everything the AI layer may see. It deliberately has no field for Jira
 * credentials, site tokens, or configuration secrets. All string content
 * originating from the repository or Jira is untrusted data, never
 * instructions. Implemented in Phase 3.
 */
export interface ReportGenerationRequest {
  issueKey: IssueKey;
  language: Language;
  changeSet: ChangeSet;
  /** Issue title and description fetched from Jira, if available. Untrusted. */
  issueContext?: { summary: string; description?: string };
  /** Report sequence number this request will produce. */
  sequence: number;
}

/**
 * How the analysis runs:
 * - `skill`: inside the user's current Claude Code session (Phase 4). The CLI
 *   emits the request, the session writes the structured report, and the CLI
 *   validates it. No nested Claude Code process, no API key.
 * - `headless`: the supported non-interactive Claude Code interface for the
 *   standalone CLI. Must verify subscription authentication and never fall back
 *   to API-key billing silently.
 */
export type ReportGenerationMode = 'skill' | 'headless';

export interface ReportGenerator {
  readonly mode: ReportGenerationMode;
  /** Returns a report that has already passed StructuredReportSchema validation. */
  generate(request: ReportGenerationRequest, signal?: AbortSignal): Promise<StructuredReport>;
}
