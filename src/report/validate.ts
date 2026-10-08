import { z } from 'zod';
import type { ReportFile } from '../adf/types';
import type { Language } from '../localization/languages';
import { ReportValidationError } from '../publication/errors';
import {
  ReportContentSchema,
  StructuredReportSchema,
  StructuredReportV1Schema,
  upgradeV1Content,
  type ChangeCoverage,
  type CompletedWork,
  type FileNote,
  type RenamedFile,
  type ReportContent,
  type SnapshotIdentity,
  type StructuredReport,
  type TestRun,
  type TestStatus,
} from './schema';

/** Facts the CLI owns; a report is checked against them and completed with them. */
export interface ReportFacts {
  reportId: string;
  issueKey: string;
  language: Language;
  /** Git's change list for the snapshot pair. The only source of file names. */
  files: readonly ReportFile[];
  snapshotIdentity: SnapshotIdentity;
  coverage: ChangeCoverage;
  /** Derived from test evidence; `not-run` without any. */
  testStatus: TestStatus;
  testRuns: readonly TestRun[];
}

export interface ParsedReportInput {
  content: ReportContent;
  /** v1 input: its testing lines carry no evidence and are shown as `reported`. */
  legacy: boolean;
}

/** Accepts v2 content, a full v2 report, or a v1 report. Strict: unknown keys are rejected. */
export function parseReportInput(input: unknown): ParsedReportInput {
  const version =
    input !== null && typeof input === 'object' && 'schemaVersion' in input
      ? input.schemaVersion
      : undefined;
  if (version === 1) {
    const v1 = StructuredReportV1Schema.safeParse(input);
    if (!v1.success) throw new ReportValidationError(prettify(v1.error));
    return { content: upgradeV1Content(v1.data), legacy: true };
  }
  const parsed = ReportContentSchema.safeParse(input);
  if (!parsed.success) throw new ReportValidationError(prettify(parsed.error));
  return { content: parsed.data, legacy: false };
}

/**
 * Everything wrong with `content` relative to the facts, as short sentences. Empty when
 * the report can be finalized. Used to reject a report, and to tell the writer what to
 * fix when it is asked to try again.
 */
export function reportProblems(
  content: ReportContent,
  facts: ReportFacts,
  options: { legacy?: boolean } = {},
): string[] {
  const problems: string[] = [];
  // Which issue a report goes to is decided by Git and the user, never by model output.
  if (content.issueKey !== facts.issueKey)
    problems.push(`it is for ${content.issueKey}, but was prepared for ${facts.issueKey}`);
  if (content.language !== facts.language)
    problems.push(`it is written in "${content.language}", expected "${facts.language}"`);
  if (content.reportId !== undefined && content.reportId !== facts.reportId)
    problems.push(`its reportId ${content.reportId} is not ${facts.reportId}`);
  if (
    content.snapshotIdentity !== undefined &&
    JSON.stringify(sortedIdentity(content.snapshotIdentity)) !==
      JSON.stringify(sortedIdentity(facts.snapshotIdentity))
  ) {
    problems.push(
      'its snapshotIdentity differs from the prepared snapshot (the baseline is fixed)',
    );
  }

  problems.push(...fileProblems(content, facts.files));
  problems.push(...testingProblems(content, facts, options.legacy === true));
  problems.push(...claimProblems(content, facts.testStatus));
  problems.push(...languageProblems(content, facts.language));
  return problems;
}

/**
 * Validates `content` against the facts and completes it: CLI-owned fields are set, and
 * the file lists become Git's lists with the writer's notes attached. Throws
 * ReportValidationError listing the problems.
 */
export function finalizeReport(
  content: ReportContent,
  facts: ReportFacts,
  options: { legacy?: boolean } = {},
): StructuredReport {
  const problems = reportProblems(content, facts, options);
  if (problems.length > 0) {
    const shown = problems.slice(0, 8).join('; ');
    const more = problems.length > 8 ? ` (and ${String(problems.length - 8)} more)` : '';
    throw new ReportValidationError(`${shown}${more}.`);
  }
  const notes = new Map<string, string>();
  for (const entry of [...content.createdFiles, ...content.modifiedFiles, ...content.deletedFiles])
    if (entry.note) notes.set(entry.path, entry.note);
  for (const entry of content.renamedFiles) if (entry.note) notes.set(entry.to, entry.note);

  const note = (path: string): FileNote => {
    const value = notes.get(path);
    return value ? { path, note: value } : { path };
  };
  const sorted = [...facts.files].sort((a, b) => compare(a.path, b.path));
  const renamed: RenamedFile[] = sorted
    .filter((f) => f.status === 'renamed')
    .map((f) => {
      const value = notes.get(f.path);
      return { from: f.previousPath ?? f.path, to: f.path, ...(value ? { note: value } : {}) };
    });

  return StructuredReportSchema.parse({
    schemaVersion: 2,
    reportId: facts.reportId,
    issueKey: facts.issueKey,
    language: facts.language,
    summary: content.summary,
    completedWork: dedupeWork(content.completedWork),
    createdFiles: sorted.filter((f) => CREATED.has(f.status)).map((f) => note(f.path)),
    modifiedFiles: sorted.filter((f) => MODIFIED.has(f.status)).map((f) => note(f.path)),
    deletedFiles: sorted.filter((f) => f.status === 'deleted').map((f) => note(f.path)),
    renamedFiles: renamed,
    testing: {
      status:
        options.legacy && content.testing.status === 'reported' ? 'reported' : facts.testStatus,
      notes: dedupeText(content.testing.notes),
      runs: facts.testRuns.map((r) => ({ ...r })),
    },
    limitations: dedupeText(content.limitations),
    uncertainties: dedupeText(content.uncertainties),
    changeCoverage: facts.coverage,
    snapshotIdentity: facts.snapshotIdentity,
  });
}

const CREATED = new Set(['added', 'copied']);
const MODIFIED = new Set(['modified', 'type-changed']);

function fileProblems(content: ReportContent, files: readonly ReportFile[]): string[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const previous = new Map(
    files.filter((f) => f.previousPath !== undefined).map((f) => [f.previousPath ?? '', f]),
  );
  const unknown = new Set<string>();
  const misplaced: string[] = [];

  const expect = (entries: readonly FileNote[], allowed: Set<string>, section: string) => {
    for (const { path } of entries) {
      const file = byPath.get(path);
      if (!file) unknown.add(path);
      else if (!allowed.has(file.status))
        misplaced.push(`${path} is ${file.status}, not ${section}`);
    }
  };
  expect(content.createdFiles, CREATED, 'created');
  expect(content.modifiedFiles, MODIFIED, 'modified');
  expect(content.deletedFiles, new Set(['deleted']), 'deleted');
  for (const entry of content.renamedFiles) {
    const file = byPath.get(entry.to);
    if (!file) unknown.add(entry.to);
    else if (file.status !== 'renamed' || file.previousPath !== entry.from)
      misplaced.push(`${entry.from} → ${entry.to} is not a rename in this change set`);
  }
  for (const work of content.completedWork) {
    for (const path of work.files) if (!byPath.has(path) && !previous.has(path)) unknown.add(path);
  }

  const problems: string[] = [];
  if (unknown.size > 0) {
    const list = [...unknown].sort(compare);
    problems.push(
      `it names files that are not in this change set: ${list.slice(0, 10).join(', ')}${list.length > 10 ? ', …' : ''}`,
    );
  }
  problems.push(...misplaced.slice(0, 10));
  return problems;
}

function testingProblems(content: ReportContent, facts: ReportFacts, legacy: boolean): string[] {
  const claimed = content.testing.status;
  if (legacy && claimed === 'reported') return [];
  const problems: string[] = [];
  if (claimed !== facts.testStatus) {
    problems.push(
      `its testing status is "${claimed}", but the test evidence says "${facts.testStatus}"`,
    );
  }
  if (facts.testStatus === 'not-run' && content.testing.notes.length > 0)
    problems.push('it has testing notes although no tests were run');
  if (
    content.testing.runs !== undefined &&
    JSON.stringify(content.testing.runs.map(runKey)) !== JSON.stringify(facts.testRuns.map(runKey))
  ) {
    problems.push('its test runs differ from the runs Git2Jira recorded');
  }
  return problems;
}

/** Statements no report may make without evidence the CLI does not have. */
const UNSUPPORTED_CLAIMS: readonly { pattern: RegExp; what: string }[] = [
  {
    pattern:
      /\b(?:deployed|released|shipped|rolled out)\b.{0,20}\b(?:to|in|on)\b.{0,10}\b(?:production|prod|staging|live|customers)\b/i,
    what: 'a deployment or release',
  },
  {
    pattern:
      /\b(?:QA|quality assurance)\b.{0,20}\b(?:approved|signed[- ]off|sign-off|verified|passed|accepted)\b|\b(?:approved|verified|accepted|signed off) by (?:QA|quality assurance|the client|the customer|the product owner)\b|\bpassed QA\b/i,
    what: 'QA or stakeholder approval',
  },
  {
    pattern:
      /(?:розгорнуто|задеплоєно|випущено|викладено)\s.{0,20}(?:продакшн|продакшені|прод\b|production|staging|бойов)/i,
    what: 'a deployment or release',
  },
  {
    pattern: /(?:QA|тестувальник\w*).{0,20}(?:затверди|погоди|підтверди|схвали)/i,
    what: 'QA or stakeholder approval',
  },
];

const TEST_PASS_CLAIMS: readonly RegExp[] = [
  /\b(?:all |the )?(?:unit |integration |e2e |end-to-end |automated )?tests? (?:pass|passed|are passing|succeeded|were successful|run successfully)\b/i,
  /\b(?:fully|thoroughly|successfully) tested\b/i,
  /(?:усі |всі )?(?:тести|тестування)\s.{0,20}(?:пройдено|пройшли|проходять|успішн)/i,
  /(?:протестовано|перевірено тестами)/i,
];

function claimProblems(content: ReportContent, testStatus: TestStatus): string[] {
  const texts = [
    content.summary,
    ...content.completedWork.map((w) => w.description),
    ...content.testing.notes,
    ...content.limitations,
    ...[...content.createdFiles, ...content.modifiedFiles, ...content.deletedFiles]
      .map((f) => f.note)
      .filter((n): n is string => n !== undefined),
  ];
  const problems = new Set<string>();
  for (const text of texts) {
    for (const claim of UNSUPPORTED_CLAIMS)
      if (claim.pattern.test(text)) problems.add(`it claims ${claim.what}, which Git cannot show`);
    if (
      testStatus !== 'passed' &&
      testStatus !== 'partial' &&
      TEST_PASS_CLAIMS.some((p) => p.test(text))
    )
      problems.add('it claims passing tests without test evidence');
  }
  return [...problems];
}

/**
 * Cheap check that free text is in the requested language. Identifiers and paths are
 * Latin in both languages, so Ukrainian text only needs some Cyrillic per field, and
 * English text must be essentially free of it.
 */
function languageProblems(content: ReportContent, language: Language): string[] {
  const fields = [content.summary, ...content.completedWork.map((w) => w.description)];
  const cyrillic = (t: string) => (t.match(/[Ѐ-ӿ]/g) ?? []).length;
  const letters = (t: string) => (t.match(/\p{L}/gu) ?? []).length;
  if (language === 'uk') {
    const latinOnly = fields.filter((t) => letters(t) >= 12 && cyrillic(t) === 0);
    return latinOnly.length > 0 ? ['parts of it are not written in Ukrainian'] : [];
  }
  const mostlyCyrillic = fields.filter((t) => cyrillic(t) > letters(t) * 0.2);
  return mostlyCyrillic.length > 0 ? ['parts of it are not written in English'] : [];
}

/** Merges entries that describe the same work (same kind, subject, and description). */
export function dedupeWork(items: readonly CompletedWork[]): CompletedWork[] {
  const seen = new Map<string, CompletedWork>();
  for (const item of items) {
    const key = `${item.kind}|${normalize(item.subject)}|${normalize(item.description)}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...item, files: [...new Set(item.files)] });
      continue;
    }
    existing.files = [...new Set([...existing.files, ...item.files])].slice(0, 100);
    const endpoints = new Map(
      [...existing.endpoints, ...item.endpoints].map((e) => [`${e.method ?? ''} ${e.endpoint}`, e]),
    );
    existing.endpoints = [...endpoints.values()].slice(0, 20);
  }
  return [...seen.values()].slice(0, 50);
}

export function dedupeText(items: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const item of items) if (!seen.has(normalize(item))) seen.set(normalize(item), item);
  return [...seen.values()].slice(0, 20);
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, ' ')
    .trim();
}

function runKey(run: TestRun): string {
  return `${run.source}|${run.outcome}|${run.command}`;
}

function sortedIdentity(identity: SnapshotIdentity) {
  return {
    sequence: identity.sequence,
    baselineKind: identity.baselineKind,
    baseTree: identity.baseTree,
    targetTree: identity.targetTree,
    snapshotCommit: identity.snapshotCommit,
  };
}

function prettify(error: z.ZodError): string {
  return z.prettifyError(error).split('\n').slice(0, 6).join(' ');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
