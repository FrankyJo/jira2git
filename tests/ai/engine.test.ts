import { describe, expect, it } from 'vitest';
import { buildAnalysisPackage, reportFacts, type AnalysisInput } from '../../src/ai/analysis';
import { ReportEngine } from '../../src/ai/engine';
import { ReportValidationError } from '../../src/publication/errors';
import type { FileChange } from '../../src/snapshots/types';
import { FakeModel } from '../fixtures/ai';

function file(path: string, status: FileChange['status'] = 'modified'): FileChange {
  return {
    path,
    status,
    kind: 'file',
    modeChanged: false,
    additions: 1,
    deletions: 0,
    binary: false,
  };
}

function pkgFor(paths: string[], extra: Partial<AnalysisInput> = {}) {
  const files = paths.map((p) => file(p));
  const patch = paths
    .map(
      (p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n+${'x'.repeat(600)}\n`,
    )
    .join('');
  const pkg = buildAnalysisPackage({
    reportId: '3f2a9c1e-1b2c-4d3e-8f40-5a6b7c8d9e0f',
    issueKey: 'LSND-1234',
    language: 'en',
    deliveryMode: 'manual',
    repositoryId: '11111111-2222-4333-8444-555555555555',
    repositoryRoot: '/work/project',
    branch: 'feature/LSND-1234',
    sequence: 1,
    baseline: { kind: 'empty', tree: 'a'.repeat(40) },
    snapshot: {
      tree: 'b'.repeat(40),
      commit: 'c'.repeat(40),
      headCommit: null,
      branch: 'feature/LSND-1234',
      capturedAt: '2026-10-08T10:00:00.000Z',
      includesUncommittedChanges: true,
    },
    changeSet: {
      baseTree: 'a'.repeat(40),
      targetTree: 'b'.repeat(40),
      files,
      commits: [],
      commitsTruncated: false,
      patch,
      patchTruncated: false,
      patchExclusions: [],
    },
    ...extra,
  });
  return {
    pkg,
    facts: reportFacts(
      pkg,
      files.map((f) => ({ status: f.status, path: f.path })),
    ),
  };
}

describe('ReportEngine', () => {
  it('writes an English report', async () => {
    const { pkg, facts } = pkgFor(['src/a.ts']);
    const result = await new ReportEngine(new FakeModel()).generate(pkg, facts);
    expect(result.report.language).toBe('en');
    expect(result.report.summary).toBe('Implemented changes in 1 file(s).');
    expect(result.report.modifiedFiles).toEqual([{ path: 'src/a.ts', note: 'Updated.' }]);
    expect(result.calls).toBe(1);
  });

  it('writes a Ukrainian report with identifiers untouched', async () => {
    const { pkg, facts } = pkgFor(['src/UserProfileView.vue'], { language: 'uk' });
    const model = new FakeModel();
    const result = await new ReportEngine(model).generate(pkg, facts);
    expect(result.report.language).toBe('uk');
    expect(result.report.completedWork[0]?.description).toBe(
      'Оновлено src/UserProfileView.vue: додано рядків 1.',
    );
    expect(model.prompts[0]?.system).toContain('professional Ukrainian');
  });

  it('analyzes large change sets in chunks and merges the partial results', async () => {
    const paths = Array.from({ length: 6 }, (_, i) => `src/f${String(i)}.ts`);
    const { pkg, facts } = pkgFor(paths, {
      limits: { maxPatchBytes: 1e6, maxFileBytes: 4000, maxChunkBytes: 1500, maxChunks: 8 },
    });
    expect(pkg.untrusted.chunks.length).toBe(3);
    const result = await new ReportEngine(new FakeModel()).generate(pkg, facts);
    expect(result.calls).toBe(4); // three parts + one consolidation
    expect(result.report.summary).toBe('Consolidated summary.');
    expect(result.report.completedWork.map((w) => w.subject).sort()).toEqual(paths);
  });

  it('falls back to a deterministic merge without duplicates when consolidation fails', async () => {
    const paths = ['src/a.ts', 'src/b.ts'];
    const { pkg, facts } = pkgFor(paths, {
      limits: { maxPatchBytes: 1e6, maxFileBytes: 4000, maxChunkBytes: 700, maxChunks: 8 },
    });
    const model = new FakeModel();
    model.override = (output, call) => (call > 2 ? { ...output, issueKey: 'EVIL-1' } : output);
    const result = await new ReportEngine(model).generate(pkg, facts);
    expect(result.warnings).toContain(
      'The partial results could not be consolidated by the model; they were merged without it.',
    );
    expect(result.report.summary).toBe('Implemented changes in 1 file(s).');
    expect(result.report.completedWork).toHaveLength(2);
  });

  it('asks once for a fix, then rejects output that names other files', async () => {
    const { pkg, facts } = pkgFor(['src/a.ts']);
    const model = new FakeModel();
    model.override = (output) => ({ ...output, createdFiles: [{ path: 'src/stolen.ts' }] });
    await expect(new ReportEngine(model).generate(pkg, facts)).rejects.toThrow(
      ReportValidationError,
    );
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]?.user).toContain('src/stolen.ts');
  });

  it('accepts a repaired second attempt', async () => {
    const { pkg, facts } = pkgFor(['src/a.ts']);
    const model = new FakeModel();
    model.override = (output, call) =>
      call === 1 ? { ...output, summary: 'Done. All tests pass.' } : output;
    const result = await new ReportEngine(model).generate(pkg, facts);
    expect(result.calls).toBe(2);
    expect(model.prompts[1]?.user).toContain('claims passing tests without test evidence');
  });
});
