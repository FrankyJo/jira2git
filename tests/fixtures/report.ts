import { StructuredReportSchema, type StructuredReport } from '../../src/report/schema';

export const COMPLETE_COVERAGE = {
  totalFiles: 1,
  analyzedFiles: 1,
  truncatedFiles: [],
  omittedFiles: [],
  ignoredFiles: [],
  chunks: 1,
  complete: true,
};

/** A finished v2 report for renderer tests (no Git involved). */
export function finishedReport(overrides: Record<string, unknown> = {}): StructuredReport {
  return StructuredReportSchema.parse({
    schemaVersion: 2,
    reportId: '3f2a9c1e-1b2c-4d3e-8f40-5a6b7c8d9e0f',
    issueKey: 'LSND-1234',
    language: 'en',
    summary: 'Summary text.',
    completedWork: [
      {
        kind: 'fixed',
        category: 'bug-fix',
        subject: 'Parser',
        description: 'Fixed it.',
        files: [],
      },
    ],
    createdFiles: [],
    modifiedFiles: [],
    deletedFiles: [],
    renamedFiles: [],
    testing: { status: 'not-run', notes: [], runs: [] },
    limitations: [],
    uncertainties: [],
    changeCoverage: COMPLETE_COVERAGE,
    snapshotIdentity: {
      sequence: 2,
      baselineKind: 'checkpoint',
      baseTree: 'a'.repeat(40),
      targetTree: 'b'.repeat(40),
      snapshotCommit: 'c'.repeat(40),
    },
    ...overrides,
  });
}
