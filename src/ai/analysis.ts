import path from 'node:path';
import { z } from 'zod';
import type { ReportFile } from '../adf/types';
import type { Baseline } from '../checkpoints/types';
import { IssueKeySchema, type RepositoryInfo } from '../git/types';
import { LanguageSchema, type Language } from '../localization/languages';
import {
  ChangeCoverageSchema,
  SnapshotIdentitySchema,
  type ChangeCoverage,
  type OmittedFile,
  type SnapshotIdentity,
  type TestStatus,
} from '../report/schema';
import type { ReportFacts } from '../report/validate';
import type {
  ChangeSet,
  DiffOptions,
  FileChange,
  IncrementalDiffEngine,
  Snapshot,
} from '../snapshots/types';
import { isNoisePath, isSensitivePath, redactSecrets } from './redact';

/**
 * The analysis package: everything the report writer may see, validated and bounded.
 * It has no field that could hold credentials. Repository and Jira text in it
 * (`untrusted`) is data, never instructions, and is redacted before it gets here.
 *
 * The Git engine owns the baseline and the snapshot; the package only describes the
 * diff between them, so the writer cannot move the baseline.
 */

/** Limits for one report generation. The diff engine's own budget comes first. */
export interface AnalysisLimits {
  /** Patch bytes requested from Git for report generation. */
  maxPatchBytes: number;
  /** A single file's diff is cut here (at a line boundary). */
  maxFileBytes: number;
  /** Diff bytes per model call. */
  maxChunkBytes: number;
  /** Model calls for one report; files beyond them are omitted and reported. */
  maxChunks: number;
}

export const DEFAULT_ANALYSIS_LIMITS: AnalysisLimits = {
  maxPatchBytes: 1024 * 1024,
  maxFileBytes: 32 * 1024,
  maxChunkBytes: 64 * 1024,
  maxChunks: 8,
};

export function reportDiffOptions(limits: AnalysisLimits = DEFAULT_ANALYSIS_LIMITS) {
  return { maxPatchBytes: limits.maxPatchBytes } satisfies Partial<DiffOptions>;
}

/**
 * Test results available to the report. `git2jira` evidence comes from a command the
 * CLI ran itself; `reported` evidence was handed in (by the user or the Claude Code
 * session) and is shown as such.
 */
export const TestEvidenceSchema = z.strictObject({
  command: z.string().trim().min(1).max(500),
  outcome: z.enum(['passed', 'failed', 'error', 'timed-out']),
  exitCode: z.int().nullable().optional(),
  source: z.enum(['git2jira', 'reported']),
  ranAt: z.iso.datetime().optional(),
  durationMs: z.int().nonnegative().optional(),
  /** Tail of the output. Untrusted, redacted. */
  summary: z.string().max(4000).optional(),
});

export type TestEvidence = z.infer<typeof TestEvidenceSchema>;

/** `--test-results <file>`: results the user or the session hands in. */
export const TestResultsInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  results: z
    .array(
      z.strictObject({
        command: z.string().trim().min(1).max(500),
        outcome: z.enum(['passed', 'failed']),
        summary: z.string().max(4000).optional(),
      }),
    )
    .min(1)
    .max(20),
});

export function deriveTestStatus(evidence: readonly TestEvidence[]): TestStatus {
  if (evidence.length === 0) return 'not-run';
  const passed = evidence.filter((e) => e.outcome === 'passed').length;
  if (passed === evidence.length) return 'passed';
  return passed === 0 ? 'failed' : 'partial';
}

const FileEntrySchema = z.strictObject({
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'type-changed']),
  path: z.string().min(1),
  previousPath: z.string().min(1).optional(),
  additions: z.int().nonnegative(),
  deletions: z.int().nonnegative(),
  binary: z.boolean(),
});

const FileDiffSchema = z.strictObject({
  path: z.string().min(1),
  /** Redacted unified diff of this file. Untrusted. */
  diff: z.string(),
  truncated: z.boolean(),
});

export type FileDiff = z.infer<typeof FileDiffSchema>;

export const AnalysisPackageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  reportId: z.uuid(),
  issueKey: IssueKeySchema,
  language: LanguageSchema,
  deliveryMode: z.enum(['manual', 'mcp', 'api-token']),
  repository: z.strictObject({ id: z.uuid(), name: z.string().max(200) }),
  branch: z.string().min(1).max(500),
  previousCheckpoint: z
    .strictObject({ sequence: z.int().positive(), reportId: z.uuid() })
    .nullable(),
  baseline: z.strictObject({
    kind: z.enum(['merge-base', 'empty', 'checkpoint']),
    /** Base branch name for a first report. */
    baseName: z.string().optional(),
  }),
  snapshot: z.strictObject({
    capturedAt: z.iso.datetime(),
    includesUncommittedChanges: z.boolean(),
  }),
  snapshotIdentity: SnapshotIdentitySchema,
  files: z.array(FileEntrySchema),
  tests: z.array(TestEvidenceSchema).max(20),
  testStatus: z.enum(['passed', 'failed', 'partial', 'not-run', 'reported']),
  untrusted: z.strictObject({
    issue: z
      .strictObject({
        title: z.string().max(2000).optional(),
        description: z.string().max(20_000).optional(),
      })
      .nullable(),
    userContext: z.string().max(4000).nullable(),
    commits: z.array(z.strictObject({ sha: z.string(), subject: z.string().max(500) })),
    /** Diffs grouped into the chunks the writer analyzes, one model call each. */
    chunks: z.array(z.array(FileDiffSchema)).min(1),
  }),
  coverage: ChangeCoverageSchema,
  /** Secret patterns removed, by rule name. Never the values. */
  redactions: z.record(z.string(), z.int().nonnegative()),
  /** Paths (or sources) whose text looks like instructions aimed at an AI. Data only. */
  injectionWarnings: z.array(z.string().max(600)),
});

export type AnalysisPackage = z.infer<typeof AnalysisPackageSchema>;

export interface AnalysisInput {
  reportId: string;
  issueKey: string;
  language: Language;
  deliveryMode: 'manual' | 'mcp' | 'api-token';
  repositoryId: string;
  repositoryRoot: string;
  branch: string;
  sequence: number;
  baseline: Baseline;
  snapshot: Snapshot;
  changeSet: ChangeSet;
  tests?: readonly TestEvidence[] | undefined;
  issue?: { title?: string | undefined; description?: string | undefined } | undefined;
  userContext?: string | undefined;
  limits?: AnalysisLimits | undefined;
}

export function snapshotIdentity(
  sequence: number,
  baseline: Baseline,
  snapshot: Snapshot,
): SnapshotIdentity {
  return {
    sequence,
    baselineKind: baseline.kind,
    baseTree: baseline.tree,
    targetTree: snapshot.tree,
    snapshotCommit: snapshot.commit,
  };
}

/** Builds and validates the package. Pure: the change set must already be computed. */
export function buildAnalysisPackage(input: AnalysisInput): AnalysisPackage {
  const limits = input.limits ?? DEFAULT_ANALYSIS_LIMITS;
  const { changeSet } = input;
  const redactions: Record<string, number> = {};
  const redact = (text: string): string => {
    const result = redactSecrets(text);
    for (const [rule, count] of Object.entries(result.findings))
      redactions[rule] = (redactions[rule] ?? 0) + count;
    return result.text;
  };

  const sections = splitPatch(changeSet.patch, changeSet.files, changeSet.patchTruncated);
  const diffs: FileDiff[] = [];
  const omitted: OmittedFile[] = [];
  const truncated: string[] = [];
  const ignored: string[] = [];
  const injectionWarnings: string[] = [];

  const ordered = [...changeSet.files].sort((a, b) => compare(a.path, b.path));
  for (const file of ordered) {
    if (isSensitivePath(file.path) || (file.previousPath && isSensitivePath(file.previousPath))) {
      omitted.push({ path: file.path, reason: 'sensitive' });
      continue;
    }
    if (isNoisePath(file.path)) {
      ignored.push(file.path);
      continue;
    }
    const section = sections.get(file.path);
    if (section === undefined) {
      omitted.push({
        path: file.path,
        reason: changeSet.patchTruncated ? 'budget' : excludedByEngine(file, changeSet),
      });
      continue;
    }
    let text = section.text;
    let cut = section.cutByEngine;
    if (Buffer.byteLength(text) > limits.maxFileBytes) {
      text = cutAtLine(text, limits.maxFileBytes);
      cut = true;
    }
    const diff = redact(text);
    if (looksLikeInjection(addedLines(diff))) injectionWarnings.push(file.path);
    if (cut) truncated.push(file.path);
    diffs.push({ path: file.path, diff, truncated: cut });
  }

  const { chunks, overflow } = chunkDiffs(diffs, limits);
  for (const file of overflow) {
    omitted.push({ path: file.path, reason: 'budget' });
    const index = truncated.indexOf(file.path);
    if (index >= 0) truncated.splice(index, 1);
  }

  const commits = changeSet.commits.map((c) => ({
    sha: c.sha,
    subject: redact(c.subject).slice(0, 500),
  }));
  if (commits.some((c) => looksLikeInjection(c.subject))) injectionWarnings.push('commit messages');

  const issue = input.issue
    ? {
        ...(input.issue.title ? { title: redact(input.issue.title).slice(0, 2000) } : {}),
        ...(input.issue.description
          ? { description: redact(input.issue.description).slice(0, 20_000) }
          : {}),
      }
    : null;
  if (issue && looksLikeInjection(`${issue.title ?? ''}\n${issue.description ?? ''}`))
    injectionWarnings.push('Jira issue text');
  const userContext = input.userContext ? redact(input.userContext).slice(0, 4000) : null;
  if (userContext && looksLikeInjection(userContext)) injectionWarnings.push('report context');

  const tests = (input.tests ?? []).map((t) =>
    t.summary === undefined ? t : { ...t, summary: redact(t.summary).slice(-4000) },
  );

  const analyzed = changeSet.files.length - omitted.length - ignored.length;
  const coverage: ChangeCoverage = {
    totalFiles: changeSet.files.length,
    analyzedFiles: analyzed - truncated.length,
    truncatedFiles: truncated.sort(compare),
    omittedFiles: omitted.sort((a, b) => compare(a.path, b.path)),
    ignoredFiles: ignored.sort(compare),
    chunks: Math.max(1, chunks.length),
    complete: omitted.length === 0 && truncated.length === 0,
  };

  const baseline = input.baseline;
  const previous =
    baseline.kind === 'checkpoint'
      ? { sequence: baseline.sequence, reportId: baseline.reportId }
      : null;

  return AnalysisPackageSchema.parse({
    schemaVersion: 1,
    reportId: input.reportId,
    issueKey: input.issueKey,
    language: input.language,
    deliveryMode: input.deliveryMode,
    repository: { id: input.repositoryId, name: path.basename(input.repositoryRoot).slice(0, 200) },
    branch: input.branch,
    previousCheckpoint: previous,
    baseline: {
      kind: baseline.kind,
      ...(baseline.kind === 'merge-base' ? { baseName: baseline.baseName } : {}),
    },
    snapshot: {
      capturedAt: input.snapshot.capturedAt,
      includesUncommittedChanges: input.snapshot.includesUncommittedChanges,
    },
    snapshotIdentity: snapshotIdentity(input.sequence, baseline, input.snapshot),
    files: ordered.map((f) => ({
      status: f.status,
      path: f.path,
      ...(f.previousPath !== undefined ? { previousPath: f.previousPath } : {}),
      additions: f.additions,
      deletions: f.deletions,
      binary: f.binary,
    })),
    tests,
    testStatus: deriveTestStatus(tests),
    untrusted: {
      issue,
      userContext,
      commits,
      chunks: chunks.length > 0 ? chunks : [[]],
    },
    coverage,
    redactions,
    injectionWarnings,
  });
}

/**
 * Recomputes the change set of a prepared report from its two trees. Deterministic, so
 * the package (and the coverage the report states) is the same whenever it is rebuilt,
 * even after the working tree changed: the snapshot, not the working tree, is analyzed.
 */
export async function snapshotChangeSet(
  diff: IncrementalDiffEngine,
  repository: RepositoryInfo,
  baseline: Baseline,
  snapshot: Snapshot,
  limits: AnalysisLimits = DEFAULT_ANALYSIS_LIMITS,
): Promise<ChangeSet> {
  const fromCommit =
    baseline.kind === 'merge-base'
      ? baseline.mergeBase
      : baseline.kind === 'checkpoint'
        ? baseline.headCommit
        : null;
  return diff.diff(
    repository,
    {
      baseTree: baseline.tree,
      targetTree: snapshot.tree,
      fromCommit,
      toCommit: snapshot.headCommit,
    },
    reportDiffOptions(limits),
  );
}

export function toReportFile(file: FileChange): ReportFile {
  return {
    status: file.status,
    path: file.path,
    ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
  };
}

// ---------------------------------------------------------------------------

interface Section {
  text: string;
  /** The diff engine's byte budget ended inside this file. */
  cutByEngine: boolean;
}

/**
 * Splits `git diff-tree -p` output into per-file sections. A section is attributed to
 * a changed file only when its header is exactly the one Git prints for that file;
 * anything else (for example quoted unusual paths) is left out and reported as not
 * analyzed rather than guessed.
 */
export function splitPatch(
  patch: string,
  files: readonly FileChange[],
  patchTruncated = false,
): Map<string, Section> {
  const headers = new Map<string, string>();
  for (const file of files) {
    const before = file.previousPath ?? file.path;
    headers.set(`diff --git a/${before} b/${file.path}`, file.path);
  }
  const sections = new Map<string, Section>();
  const starts = [...patch.matchAll(/^diff --git .*$/gm)];
  starts.forEach((match, index) => {
    const start = match.index;
    const end = starts[index + 1]?.index ?? patch.length;
    const owner = headers.get(match[0]);
    if (owner === undefined) return;
    const last = index === starts.length - 1;
    sections.set(owner, {
      text: patch.slice(start, end),
      cutByEngine: last && patchTruncated,
    });
  });
  return sections;
}

function excludedByEngine(file: FileChange, changeSet: ChangeSet): OmittedFile['reason'] {
  const excluded = changeSet.patchExclusions.some((pattern) => globMatch(pattern, file.path));
  if (excluded) return 'excluded';
  return file.binary ? 'binary' : 'not-in-diff';
}

/** Minimal `**`/`*` glob matcher for the diff engine's exclusion patterns. */
function globMatch(pattern: string, file: string): boolean {
  const regex = pattern
    .split('**/')
    .map((part) =>
      part
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]'),
    )
    .join('(?:.*/)?');
  return new RegExp(`^${regex}$`).test(file);
}

/** Groups diffs into chunks of at most `maxChunkBytes`, keeping each file whole. */
export function chunkDiffs(
  diffs: readonly FileDiff[],
  limits: Pick<AnalysisLimits, 'maxChunkBytes' | 'maxChunks'>,
): { chunks: FileDiff[][]; overflow: FileDiff[] } {
  const chunks: FileDiff[][] = [];
  const overflow: FileDiff[] = [];
  let current: FileDiff[] = [];
  let size = 0;
  for (const diff of diffs) {
    const bytes = Buffer.byteLength(diff.diff);
    if (current.length > 0 && size + bytes > limits.maxChunkBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    if (chunks.length >= limits.maxChunks) {
      overflow.push(diff);
      continue;
    }
    current.push(diff);
    size += bytes;
  }
  if (current.length > 0 && chunks.length < limits.maxChunks) chunks.push(current);
  else if (current.length > 0) overflow.push(...current);
  return { chunks, overflow };
}

function cutAtLine(text: string, maxBytes: number): string {
  const slice = Buffer.from(text).subarray(0, maxBytes).toString('utf8');
  const lastNewline = slice.lastIndexOf('\n');
  return (lastNewline > 0 ? slice.slice(0, lastNewline + 1) : slice).replace(/�$/, '');
}

function addedLines(diff: string): string {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
}

const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:previous|prior|above|earlier|all|system|your)\b.{0,20}\b(?:instructions?|prompts?|rules?|directions?)\b/i,
  /\byou are (?:now|no longer)\b/i,
  /\b(?:new|updated|real) (?:system )?instructions?\s*:/i,
  /<\/?\s*(?:system|instructions?|assistant|repository-data)\b/i,
  /\b(?:system|developer) prompt\b/i,
  /\b(?:as an? (?:ai|llm|language model)|dear (?:ai|assistant|claude|model))\b/i,
  /\b(?:publish|post|confirm|approve)\b.{0,30}\b(?:without|no)\b.{0,15}\b(?:asking|approval|confirmation|review)\b/i,
  /(?:ігноруй|забудь|проігноруй).{0,40}(?:інструкці|правил|вказів)/i,
];

/** Heuristic only: it adds a warning, it never changes what is analyzed or published. */
export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The facts a report is validated against and completed with (see finalizeReport). */
export function reportFacts(pkg: AnalysisPackage, files: readonly ReportFile[]): ReportFacts {
  return {
    reportId: pkg.reportId,
    issueKey: pkg.issueKey,
    language: pkg.language,
    files,
    snapshotIdentity: pkg.snapshotIdentity,
    coverage: pkg.coverage,
    testStatus: pkg.testStatus,
    testRuns: pkg.tests.map((t) => ({ command: t.command, outcome: t.outcome, source: t.source })),
  };
}
