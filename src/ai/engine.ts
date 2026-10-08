import { Git2JiraError } from '../core/errors';
import { ReportValidationError } from '../publication/errors';
import { ReportContentSchema, type ReportContent } from '../report/schema';
import {
  dedupeText,
  dedupeWork,
  finalizeReport,
  reportProblems,
  type ReportFacts,
} from '../report/validate';
import type { AnalysisPackage } from './analysis';
import { buildReportPrompt } from './prompt';
import type { AIReportProvider, GenerationResult, ReportGenerator } from './types';

export interface ReportEngineOptions {
  /** Extra attempts per model call when the output is rejected. */
  repairAttempts?: number;
}

/**
 * Generates a report with a model provider:
 * one call per diff chunk → validate each (one repair attempt with the problems) →
 * merge partial results → one consolidation call (validated; on failure the
 * deterministic merge is used) → finalize against Git's facts.
 *
 * Nothing here decides the baseline, the issue, the files, or the test status; those
 * come from the package and the facts.
 */
export class ReportEngine implements ReportGenerator {
  private readonly repairAttempts: number;

  constructor(
    private readonly provider: AIReportProvider,
    options: ReportEngineOptions = {},
  ) {
    this.repairAttempts = options.repairAttempts ?? 1;
  }

  describe(): string {
    return this.provider.describe();
  }

  async generate(
    pkg: AnalysisPackage,
    facts: ReportFacts,
    signal?: AbortSignal,
  ): Promise<GenerationResult> {
    await this.provider.ensureAvailable(signal);
    const warnings = packageWarnings(pkg);
    let calls = 0;

    const partials: ReportContent[] = [];
    for (let chunk = 0; chunk < pkg.untrusted.chunks.length; chunk++) {
      const chunkFiles = new Set((pkg.untrusted.chunks[chunk] ?? []).map((d) => d.path));
      const chunkFacts =
        pkg.untrusted.chunks.length > 1
          ? { ...facts, files: facts.files.filter((f) => chunkFiles.has(f.path)) }
          : facts;
      const { content, used } = await this.attempt(
        (problems) => buildReportPrompt(pkg, { chunk, problems }),
        chunkFacts,
        signal,
      );
      calls += used;
      partials.push(content);
    }

    let content = partials[0] as ReportContent;
    if (partials.length > 1) {
      const merged = mergePartials(partials);
      try {
        const result = await this.attempt(
          (problems) => buildReportPrompt(pkg, { partials, problems }),
          facts,
          signal,
        );
        calls += result.used;
        content = result.content;
      } catch (error) {
        if (!(error instanceof ReportValidationError)) throw error;
        warnings.push(
          'The partial results could not be consolidated by the model; they were merged without it.',
        );
        content = merged;
      }
    }

    const report = finalizeReport(content, facts);
    for (const uncertainty of report.uncertainties) warnings.push(`Writer: ${uncertainty}`);
    return { content, report, warnings, calls };
  }

  /** One model call, plus repair attempts when the output is rejected. */
  private async attempt(
    prompt: (problems?: readonly string[]) => ReturnType<typeof buildReportPrompt>,
    facts: ReportFacts,
    signal?: AbortSignal,
  ): Promise<{ content: ReportContent; used: number }> {
    let problems: string[] | undefined;
    for (let used = 1; used <= 1 + this.repairAttempts; used++) {
      const raw = await this.provider.complete(prompt(problems), signal);
      const parsed = ReportContentSchema.safeParse(withVersion(raw));
      if (!parsed.success) {
        problems = parsed.error.issues
          .slice(0, 8)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
        continue;
      }
      problems = reportProblems(parsed.data, facts);
      if (problems.length === 0) return { content: parsed.data, used };
    }
    throw new ReportValidationError(
      `the generated report was rejected: ${(problems ?? []).slice(0, 6).join('; ')}. Nothing was saved.`,
    );
  }
}

/** The writer's schema omits `schemaVersion` defaults; accept output without it. */
function withVersion(raw: unknown): unknown {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && !('schemaVersion' in raw))
    return { schemaVersion: 2, ...raw };
  return raw;
}

/** Deterministic merge of partial results: union of lists, duplicates removed. */
export function mergePartials(partials: readonly ReportContent[]): ReportContent {
  const [first] = partials;
  if (!first) throw new Git2JiraError('No partial results to merge.');
  const notes = <T extends { path: string }>(lists: T[][]): T[] => {
    const byPath = new Map<string, T>();
    for (const list of lists)
      for (const item of list) if (!byPath.has(item.path)) byPath.set(item.path, item);
    return [...byPath.values()];
  };
  return {
    schemaVersion: 2,
    issueKey: first.issueKey,
    language: first.language,
    summary: dedupeText(partials.map((p) => p.summary))
      .join('\n\n')
      .slice(0, 2000),
    completedWork: dedupeWork(partials.flatMap((p) => p.completedWork)),
    createdFiles: notes(partials.map((p) => p.createdFiles)),
    modifiedFiles: notes(partials.map((p) => p.modifiedFiles)),
    deletedFiles: notes(partials.map((p) => p.deletedFiles)),
    renamedFiles: notes(partials.map((p) => p.renamedFiles.map((r) => ({ ...r, path: r.to })))).map(
      ({ path: _path, ...rest }) => rest,
    ),
    testing: {
      status: first.testing.status,
      notes: dedupeText(partials.flatMap((p) => p.testing.notes)),
    },
    limitations: dedupeText(partials.flatMap((p) => p.limitations)),
    uncertainties: dedupeText(partials.flatMap((p) => p.uncertainties)),
  };
}

/** Warnings every preview shows, whoever wrote the report. */
export function packageWarnings(pkg: AnalysisPackage): string[] {
  const warnings: string[] = [];
  const { coverage } = pkg;
  if (!coverage.complete) {
    const parts: string[] = [];
    if (coverage.truncatedFiles.length > 0)
      parts.push(`${String(coverage.truncatedFiles.length)} cut short`);
    const reasons = new Map<string, number>();
    for (const file of coverage.omittedFiles)
      reasons.set(file.reason, (reasons.get(file.reason) ?? 0) + 1);
    for (const [reason, count] of reasons) parts.push(`${String(count)} not analyzed (${reason})`);
    warnings.push(
      `Coverage incomplete: ${String(coverage.analyzedFiles)} of ${String(coverage.totalFiles)} changed files analyzed in full; ${parts.join(', ')}. The report says so.`,
    );
  }
  const redacted = Object.entries(pkg.redactions);
  if (redacted.length > 0) {
    warnings.push(
      `Possible secrets were redacted before analysis (${redacted.map(([rule, n]) => `${rule} ×${String(n)}`).join(', ')}). Check that none were committed.`,
    );
  }
  if (pkg.injectionWarnings.length > 0) {
    warnings.push(
      `Text that looks like instructions to an AI was found in ${pkg.injectionWarnings.slice(0, 5).join(', ')}${pkg.injectionWarnings.length > 5 ? ', …' : ''}. It was treated as data; review the report carefully.`,
    );
  }
  return warnings;
}
