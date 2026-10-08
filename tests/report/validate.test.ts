import { describe, expect, it } from 'vitest';
import { ReportValidationError } from '../../src/publication/errors';
import { ReportContentSchema } from '../../src/report/schema';
import {
  finalizeReport,
  parseReportInput,
  reportProblems,
  type ReportFacts,
} from '../../src/report/validate';
import { sampleContent, sampleReport } from '../fixtures/publication';
import { COMPLETE_COVERAGE } from '../fixtures/report';

const FACTS: ReportFacts = {
  reportId: '3f2a9c1e-1b2c-4d3e-8f40-5a6b7c8d9e0f',
  issueKey: 'LSND-1234',
  language: 'en',
  files: [
    { status: 'added', path: 'src/UserProfileView.vue' },
    { status: 'modified', path: 'src/router.ts' },
    { status: 'renamed', path: 'src/api/users.ts', previousPath: 'src/api/user.ts' },
    { status: 'deleted', path: 'src/Old.vue' },
  ],
  snapshotIdentity: {
    sequence: 1,
    baselineKind: 'merge-base',
    baseTree: 'a'.repeat(40),
    targetTree: 'b'.repeat(40),
    snapshotCommit: 'c'.repeat(40),
  },
  coverage: { ...COMPLETE_COVERAGE, totalFiles: 4, analyzedFiles: 4 },
  testStatus: 'not-run',
  testRuns: [],
};

const content = (overrides: Record<string, unknown> = {}, language: 'en' | 'uk' = 'en') =>
  ReportContentSchema.parse(sampleContent(language, overrides, ['src/UserProfileView.vue']));

describe('report validation', () => {
  it('rejects unknown keys, missing work, and oversized text', () => {
    expect(() => parseReportInput({ ...sampleContent(), mention: '@all' })).toThrow(
      ReportValidationError,
    );
    expect(() => parseReportInput(sampleContent('en', { completedWork: [] }))).toThrow(
      ReportValidationError,
    );
    expect(() => parseReportInput(sampleContent('en', { summary: 'x'.repeat(2001) }))).toThrow(
      ReportValidationError,
    );
    expect(() => parseReportInput({ schemaVersion: 3 })).toThrow(ReportValidationError);
  });

  it('accepts v1 reports and marks their testing lines as unverified', () => {
    const { content: upgraded, legacy } = parseReportInput(sampleReport('en'));
    expect(legacy).toBe(true);
    const report = finalizeReport(upgraded, FACTS, { legacy });
    expect(report.testing).toMatchObject({ status: 'reported', notes: ['pnpm test'] });
  });

  it('rejects hallucinated or misplaced file names', () => {
    const invented = content({
      completedWork: [
        {
          kind: 'added',
          category: 'feature',
          subject: 'X',
          description: 'Added X.',
          files: ['src/Invented.vue'],
        },
      ],
    });
    expect(reportProblems(invented, FACTS)).toEqual([
      'it names files that are not in this change set: src/Invented.vue',
    ]);
    const misplaced = content({ createdFiles: [{ path: 'src/router.ts' }] });
    expect(reportProblems(misplaced, FACTS)).toEqual(['src/router.ts is modified, not created']);
    const wrongRename = content({ renamedFiles: [{ from: 'src/x.ts', to: 'src/api/users.ts' }] });
    expect(reportProblems(wrongRename, FACTS)[0]).toContain('is not a rename');
  });

  it('never lets the report change the issue, language, or snapshot', () => {
    expect(reportProblems(content({ issueKey: 'EVIL-1' }), FACTS)[0]).toContain('EVIL-1');
    expect(
      reportProblems(
        content({ snapshotIdentity: { ...FACTS.snapshotIdentity, baseTree: 'f'.repeat(40) } }),
        FACTS,
      ),
    ).toContain('its snapshotIdentity differs from the prepared snapshot (the baseline is fixed)');
    expect(reportProblems(content({}, 'uk'), FACTS)[0]).toContain('expected "en"');
  });

  it('rejects invented tests, deployments, and approvals', () => {
    const claims = [
      { summary: 'Implemented the page. All tests pass.' },
      { testing: { status: 'passed', notes: [] } },
      { testing: { status: 'not-run', notes: ['Tested manually.'] } },
      { summary: 'Deployed to production and approved by QA.' },
    ];
    for (const overrides of claims) {
      expect(reportProblems(content(overrides), FACTS).length, JSON.stringify(overrides)).toBe(
        overrides.summary?.includes('Deployed') ? 2 : 1,
      );
    }
    // With evidence the same statement is fine.
    const passed: ReportFacts = {
      ...FACTS,
      testStatus: 'passed',
      testRuns: [{ command: 'pnpm test', outcome: 'passed', source: 'git2jira' }],
    };
    expect(
      reportProblems(
        content({
          summary: 'Implemented the page. All tests pass.',
          testing: { status: 'passed', notes: [] },
        }),
        passed,
      ),
    ).toEqual([]);
  });

  it('checks that free text is in the requested language', () => {
    const uk: ReportFacts = { ...FACTS, language: 'uk' };
    expect(reportProblems(content({}, 'uk'), uk)).toEqual([]);
    expect(
      reportProblems(content({ language: 'uk', summary: 'Implemented the profile page.' }), uk),
    ).toEqual(['parts of it are not written in Ukrainian']);
  });

  it('finalizes with Git file lists, the writer notes, and the CLI-owned fields', () => {
    const report = finalizeReport(
      content({
        createdFiles: [{ path: 'src/UserProfileView.vue', note: 'Profile page.' }],
        completedWork: [...sampleContent('en').completedWork, ...sampleContent('en').completedWork],
      }),
      FACTS,
    );
    expect(report.reportId).toBe(FACTS.reportId);
    expect(report.snapshotIdentity).toEqual(FACTS.snapshotIdentity);
    expect(report.completedWork).toHaveLength(1);
    expect(report.createdFiles).toEqual([
      { path: 'src/UserProfileView.vue', note: 'Profile page.' },
    ]);
    expect(report.modifiedFiles).toEqual([{ path: 'src/router.ts' }]);
    expect(report.deletedFiles).toEqual([{ path: 'src/Old.vue' }]);
    expect(report.renamedFiles).toEqual([{ from: 'src/api/user.ts', to: 'src/api/users.ts' }]);
    expect(report.testing).toEqual({ status: 'not-run', notes: [], runs: [] });
  });
});
