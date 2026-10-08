import type { ReportContent, StructuredReport } from '../report/schema';
import type { ReportFacts } from '../report/validate';
import type { AnalysisPackage } from './analysis';
import type { ReportPrompt } from './prompt';

/**
 * Where the report writer runs:
 * - `session`: the user's current Claude Code session (`/jira-report`). The CLI hands
 *   the analysis package and instructions to the session and validates what comes
 *   back through `report submit`. No nested Claude Code process, no API key.
 * - `headless`: a standalone terminal. The CLI calls Claude Code's supported
 *   non-interactive interface (`claude -p`) with the user's own sign-in. It verifies
 *   that sign-in first and never switches to API-key billing silently.
 */
export type ReportGenerationMode = 'session' | 'headless';

/** Sends one prompt to a model and returns its raw JSON output (unvalidated). */
export interface AIReportProvider {
  readonly mode: ReportGenerationMode;
  /** Short name for messages, e.g. "Claude Code 2.1.294 (claude.ai sign-in)". */
  describe(): string;
  /** Throws a Git2JiraError explaining why the provider cannot be used. */
  ensureAvailable(signal?: AbortSignal): Promise<void>;
  complete(prompt: ReportPrompt, signal?: AbortSignal): Promise<unknown>;
}

export interface GenerationResult {
  /** The writer's validated content, as `report submit` accepts it. */
  content: ReportContent;
  /** Validated and finalized against Git's facts. */
  report: StructuredReport;
  /** Preview warnings: coverage, redactions, injection heuristics, merge fallbacks. */
  warnings: string[];
  /** Model calls made. */
  calls: number;
}

/** Turns an analysis package into a finished report. */
export interface ReportGenerator {
  /** Who writes the report, for the preview. */
  describe(): string;
  generate(
    pkg: AnalysisPackage,
    facts: ReportFacts,
    signal?: AbortSignal,
  ): Promise<GenerationResult>;
}

/** Options the CLI passes when it needs a headless report writer. */
export interface GeneratorOptions {
  env: Readonly<Record<string, string | undefined>>;
  allowApiBilling: boolean;
  model?: string | undefined;
}

export type ReportGeneratorFactory = (options: GeneratorOptions) => ReportGenerator;
