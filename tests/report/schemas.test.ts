import { describe, expect, it } from 'vitest';
import { ReportRecordSchema } from '../../src/checkpoints/types';
import { IssueKeySchema } from '../../src/git/types';
import { StructuredReportSchema } from '../../src/report/schema';

describe('domain schemas', () => {
  it.each([
    ['LSND-1234', true],
    ['AB_1-7', true],
    ['lsnd-1', false],
    ['LSND-0', false],
    ['LSND1234', false],
  ])('IssueKeySchema %s → %s', (key, valid) => {
    expect(IssueKeySchema.safeParse(key).success).toBe(valid);
  });

  it('accepts a minimal structured report and applies defaults', () => {
    const report = StructuredReportSchema.parse({
      schemaVersion: 1,
      issueKey: 'LSND-1234',
      language: 'uk',
      summary: 'Реалізовано компоненти профілю.',
      changes: [
        {
          kind: 'added',
          subject: 'UserProfileCard',
          description: 'Нова картка.',
          files: ['src/A.tsx'],
        },
      ],
    });
    expect(report.apiChanges).toEqual([]);
    expect(report.risks).toEqual([]);
  });

  it('rejects reports with extra fields or no changes', () => {
    const base = { schemaVersion: 1, issueKey: 'LSND-1', language: 'en', summary: 'x' };
    expect(StructuredReportSchema.safeParse({ ...base, changes: [] }).success).toBe(false);
    expect(
      StructuredReportSchema.safeParse({
        ...base,
        changes: [{ kind: 'added', subject: 's', description: 'd', files: [] }],
        mention: '@all',
      }).success,
    ).toBe(false);
  });

  it('rejects incomplete report records', () => {
    expect(
      ReportRecordSchema.safeParse({ schemaVersion: 1, issueKey: 'LSND-1', sequence: 1 }).success,
    ).toBe(false);
  });
});
