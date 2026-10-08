import { describe, expect, it } from 'vitest';
import { findReportMarkers } from '../../src/adf/footer';
import { escapeMarkdown, renderTextReport } from '../../src/delivery/render';
import { REPORT_LABELS } from '../../src/localization/catalog';
import { finishedReport } from '../fixtures/report';

const REPORT_ID = '3f2a9c1e-0000-4000-8000-000000000001';

function render(overrides: Record<string, unknown> = {}, language: 'en' | 'uk' = 'en') {
  const report = finishedReport({ issueKey: 'ABC-1', language, ...overrides });
  return renderTextReport({
    report,
    files: [
      { status: 'added', path: 'src/new`odd`.ts' },
      { status: 'modified', path: 'src/b.ts' },
      { status: 'renamed', path: 'src/c2.ts', previousPath: 'src/c.ts' },
      { status: 'deleted', path: 'src/d.ts' },
    ],
    labels: REPORT_LABELS[language],
    marker: { reportId: REPORT_ID, sequence: 3 },
  });
}

describe('text report renderer', () => {
  it('is deterministic and ends with one recognizable marker', () => {
    const a = render();
    expect(render()).toEqual(a);
    expect(findReportMarkers(a.markdown)).toEqual([{ reportId: REPORT_ID, sequence: 3 }]);
    expect(findReportMarkers(a.text)).toEqual([{ reportId: REPORT_ID, sequence: 3 }]);
    expect(a.markdown).not.toMatch(/[0-9a-f]{40}/);
  });

  it('lists files from Git in sections, with safe code spans', () => {
    const { markdown, text } = render();
    expect(markdown).toContain('### Created Files\n\n- ``src/new`odd`.ts``');
    expect(markdown).toContain(
      '### Deleted or Renamed Files\n\n- `src/c.ts` → `src/c2.ts`\n- `src/d.ts`',
    );
    expect(text).toContain('Modified Files\n--------------\n\n• src/b.ts');
  });

  it('keeps model text from becoming links, images, headings, or HTML', () => {
    const { markdown } = render({
      summary: '# Heading\n\n[click](https://evil.example) ![img](x) <b>bold</b> *em* | cell',
      limitations: ['1. not a list'],
    });
    expect(markdown).toContain('\\# Heading');
    expect(markdown).toContain(
      '\\[click\\](https://evil.example) \\!\\[img\\](x) \\<b\\>bold\\</b\\> \\*em\\* \\| cell',
    );
    expect(markdown).toContain('- 1\\. not a list');
    expect(escapeMarkdown('see issue #12 (done)')).toBe('see issue #12 (done)');
  });

  it('states that tests were not run, and uses Ukrainian labels', () => {
    const { markdown } = render({ limitations: ['Ризик.'] }, 'uk');
    expect(markdown).toContain('## Звіт про реалізацію #3');
    expect(markdown).toContain('### Відомі обмеження\n\n- Ризик.');
    expect(markdown).toContain(
      '### Тестування та перевірки\n\nДля цього звіту тести не запускалися.',
    );
  });

  it('adds file notes, endpoints, test runs, and a coverage warning', () => {
    const { markdown } = render({
      completedWork: [
        {
          kind: 'added',
          category: 'api-integration',
          subject: 'Client',
          description: 'Calls the API.',
          files: ['src/b.ts'],
          endpoints: [{ method: 'POST', endpoint: '/api/items' }],
        },
      ],
      modifiedFiles: [{ path: 'src/b.ts', note: 'Uses the *new* client.' }],
      testing: {
        status: 'failed',
        notes: [],
        runs: [{ command: 'pnpm test', outcome: 'failed', source: 'git2jira' }],
      },
      changeCoverage: {
        totalFiles: 4,
        analyzedFiles: 3,
        truncatedFiles: ['src/b.ts'],
        omittedFiles: [],
        ignoredFiles: [],
        chunks: 1,
        complete: false,
      },
    });
    expect(markdown).toContain('**Client** (Added): Calls the API. — `POST /api/items`');
    expect(markdown).toContain('- `src/b.ts` — Uses the \\*new\\* client.');
    expect(markdown).toContain(
      'The recorded test runs failed.\n\n- `pnpm test`: failed (run by Git2Jira)',
    );
    expect(markdown).toContain('Only 3 of 4 changed files were analyzed in full');
  });
});
