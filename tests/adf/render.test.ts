import { describe, expect, it } from 'vitest';
import { findReportMarkers, footerText } from '../../src/adf/footer';
import { MAX_FILES_PER_SECTION, StructuredReportRenderer } from '../../src/adf/render';
import { adfToPlainText } from '../../src/adf/text';
import type { AdfDocument, ReportFile, ReportFooter } from '../../src/adf/types';
import { AdfValidationError, validateAdfDocument } from '../../src/adf/validate';
import { REPORT_LABELS } from '../../src/localization/catalog';
import { StructuredReportSchema, type StructuredReport } from '../../src/report/schema';

const FOOTER: ReportFooter = {
  reportId: '3f2a9c1e-1b2c-4d3e-8f40-5a6b7c8d9e0f',
  sequence: 2,
  baseTree: 'a'.repeat(40),
  targetTree: 'b'.repeat(40),
  toolVersion: '0.0.0-test',
};

function report(overrides: Partial<StructuredReport> = {}): StructuredReport {
  return StructuredReportSchema.parse({
    schemaVersion: 1,
    issueKey: 'LSND-1234',
    language: 'en',
    summary: 'Added the profile page.\n\nWired it to `GET /api/users/{id}`.',
    changes: [
      {
        kind: 'added',
        subject: 'UserProfileView',
        description: 'New view rendering useUserProfile() data.\nHandles loading state.',
        files: ['src/views/UserProfileView.vue'],
      },
    ],
    apiChanges: [
      { kind: 'added', method: 'GET', endpoint: '/api/users/{id}', description: 'Fetches a user.' },
    ],
    testing: ['pnpm test: 42 passed'],
    risks: ['No pagination yet.'],
    followUps: ['Add avatar upload.'],
    ...overrides,
  });
}

const FILES: ReportFile[] = [
  { status: 'modified', path: 'src/router/index.ts' },
  { status: 'added', path: 'src/views/UserProfileView.vue' },
  { status: 'renamed', path: 'src/api/users.ts', previousPath: 'src/api/user.ts' },
  { status: 'deleted', path: 'src/legacy/Profile.vue' },
  { status: 'copied', path: 'docs/профіль файл.md', previousPath: 'docs/profile.md' },
  { status: 'type-changed', path: 'bin/run' },
];

const renderer = new StructuredReportRenderer();

function headings(doc: AdfDocument): string[] {
  return doc.content.flatMap((block) =>
    block.type === 'heading'
      ? [block.content.map((n) => (n.type === 'text' ? n.text : '')).join('')]
      : [],
  );
}

describe('StructuredReportRenderer', () => {
  it('renders English headings in a fixed order', () => {
    const doc = renderer.render({
      report: report(),
      files: FILES,
      labels: REPORT_LABELS.en,
      footer: FOOTER,
    });
    expect(headings(doc)).toEqual([
      'Implementation Report #2',
      'Summary',
      'Completed Work',
      'Created Files',
      'Modified Files',
      'Deleted or Renamed Files',
      'Testing and Validation',
      'Known Limitations',
    ]);
  });

  it('renders Ukrainian headings and keeps identifiers untranslated', () => {
    const doc = renderer.render({
      report: report({ language: 'uk', summary: 'Додано сторінку профілю для `UserProfileView`.' }),
      files: FILES,
      labels: REPORT_LABELS.uk,
      footer: FOOTER,
    });
    expect(headings(doc)).toEqual([
      'Звіт про реалізацію #2',
      'Підсумок',
      'Виконані роботи',
      'Створені файли',
      'Змінені файли',
      'Видалені або перейменовані файли',
      'Тестування та перевірки',
      'Відомі обмеження',
    ]);
    const text = adfToPlainText(doc);
    expect(text).toContain('src/views/UserProfileView.vue');
    expect(text).toContain('GET /api/users/{id}');
    expect(text).toContain('(Додано)');
    expect(text).toContain('скопійовано з docs/profile.md');
    // The footer is language-independent so it can always be recognized.
    expect(text).toContain(footerText(FOOTER));
  });

  it('is deterministic and validates', () => {
    const a = renderer.render({
      report: report(),
      files: FILES,
      labels: REPORT_LABELS.en,
      footer: FOOTER,
    });
    const b = renderer.render({
      report: report(),
      files: [...FILES].reverse(),
      labels: REPORT_LABELS.en,
      footer: FOOTER,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(validateAdfDocument(a)).toEqual(a);
  });

  it('shows paths verbatim in code marks, and renames as old → new', () => {
    const doc = renderer.render({
      report: report(),
      files: FILES,
      labels: REPORT_LABELS.en,
      footer: FOOTER,
    });
    const json = JSON.stringify(doc);
    expect(json).toContain(
      JSON.stringify({ type: 'text', text: 'docs/профіль файл.md', marks: [{ type: 'code' }] }),
    );
    expect(adfToPlainText(doc)).toContain('src/api/user.ts → src/api/users.ts');
    expect(adfToPlainText(doc)).toContain('bin/run (type changed)');
  });

  it('keeps model text as plain text: no links, mentions, or markup', () => {
    const doc = renderer.render({
      report: report({
        summary: '[click](https://evil.example) @admin <b>x</b> {color:red}',
        changes: [
          {
            kind: 'fixed',
            subject: 'a\u0000b',
            description: 'line1\r\nline2\u001b[31m',
            files: [],
          },
        ],
      }),
      files: [{ status: 'added', path: 'weird\nname\t.txt' }],
      labels: REPORT_LABELS.en,
      footer: FOOTER,
    });
    validateAdfDocument(doc);
    const json = JSON.stringify(doc);
    expect(json).not.toMatch(/"type":"(link|mention|inlineCard|media)"/);
    expect(json).toContain('[click](https://evil.example) @admin <b>x</b> {color:red}');
    expect(json).toContain('a�b');
    expect(json).toContain('{"type":"hardBreak"}');
    expect(json).toContain(JSON.stringify('weird\uFFFDname\t.txt'));
  });

  it('omits empty optional sections and truncates long file lists', () => {
    const many: ReportFile[] = Array.from({ length: MAX_FILES_PER_SECTION + 7 }, (_, i) => ({
      status: 'added',
      path: `f/${String(i).padStart(4, '0')}.ts`,
    }));
    const doc = renderer.render({
      report: report({ testing: [], risks: [], followUps: [], apiChanges: [] }),
      files: many,
      labels: REPORT_LABELS.uk,
      footer: FOOTER,
    });
    expect(headings(doc)).toEqual([
      'Звіт про реалізацію #2',
      'Підсумок',
      'Виконані роботи',
      'Створені файли',
    ]);
    expect(adfToPlainText(doc)).toContain('… та ще 7');
  });
});

describe('validateAdfDocument', () => {
  const ok: AdfDocument = {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
  };

  it.each([
    [
      'a link mark',
      {
        ...ok,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'https://e' } }] },
            ],
          },
        ],
      },
    ],
    [
      'a mention',
      {
        ...ok,
        content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: '1' } }] }],
      },
    ],
    [
      'an empty text node',
      { ...ok, content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] },
    ],
    [
      'code combined with strong',
      {
        ...ok,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'x', marks: [{ type: 'code' }, { type: 'strong' }] }],
          },
        ],
      },
    ],
    [
      'a control character',
      { ...ok, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a\u0007' }] }] },
    ],
    ['an empty document', { ...ok, content: [] }],
    ['a wrong version', { ...ok, version: 2 }],
  ])('rejects %s', (_name, doc) => {
    expect(() => validateAdfDocument(doc)).toThrow(AdfValidationError);
  });

  it('rejects comments over the Jira size limit', () => {
    const big: AdfDocument = {
      type: 'doc',
      version: 1,
      content: Array.from({ length: 20 }, () => ({
        type: 'paragraph' as const,
        content: [{ type: 'text' as const, text: 'x'.repeat(2000) }],
      })),
    };
    expect(() => validateAdfDocument(big)).toThrow(/limited to about 30000/);
  });
});

describe('report markers', () => {
  it('round-trips the footer marker and ignores other text', () => {
    expect(findReportMarkers(`intro ${footerText(FOOTER)} outro`)).toEqual([
      { reportId: FOOTER.reportId, sequence: 2 },
    ]);
    expect(findReportMarkers('Git2Jira report not-a-uuid · #1')).toEqual([]);
  });
});
