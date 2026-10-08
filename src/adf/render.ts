import { footerText } from './footer';
import type {
  AdfBlock,
  AdfBulletList,
  AdfDocument,
  AdfInline,
  AdfListItem,
  AdfMark,
  AdfParagraph,
  AdfRenderer,
  ReportFile,
  ReportRenderInput,
} from './types';
import type { ReportLabels } from '../localization/catalog';
import type { StructuredReport } from '../report/schema';

/** Longer file lists end with "… and N more" so the comment stays within Jira's size limit. */
export const MAX_FILES_PER_SECTION = 100;

/**
 * Deterministic StructuredReport → ADF. The same input always yields the same
 * document (no timestamps, no randomness), so the previewed digest is exactly
 * what gets published. Report text is placed in `text` nodes only; file paths
 * come from Git and are shown verbatim in `code` marks.
 */
export class StructuredReportRenderer implements AdfRenderer {
  render({ report, files, labels, footer }: ReportRenderInput): AdfDocument {
    const content: AdfBlock[] = [
      heading(2, `${labels.title} #${String(footer.sequence)}`),
      heading(3, labels.summary),
      ...report.summary.split(/\n{2,}/).map((part) => paragraph(prose(part))),
      heading(3, labels.completedWork),
      list(
        report.completedWork.map((work) => [
          ...text(cleanLine(work.subject), [{ type: 'strong' }]),
          ...text(` (${labels.changeKinds[work.kind]}): `),
          ...prose(work.description),
          ...work.endpoints.flatMap((endpoint, index) => [
            ...text(index === 0 ? ' — ' : ', '),
            ...text(cleanLine(endpointLabel(endpoint)), [{ type: 'code' }]),
          ]),
        ]),
      ),
    ];

    const notes = fileNotes(report);
    for (const [title, group] of groupFiles(files, labels)) {
      const shown = group.slice(0, MAX_FILES_PER_SECTION).map((file) => {
        const note = notes.get(file.path);
        return [...fileLine(file, labels), ...(note ? [...text(' — '), ...prose(note)] : [])];
      });
      const hidden = group.length - shown.length;
      if (hidden > 0) shown.push(text(labels.moreItems.replace('{count}', String(hidden))));
      content.push(heading(3, title), list(shown));
    }

    content.push(
      heading(3, labels.testing),
      paragraph(text(labels.testStatus[report.testing.status])),
    );
    const testing = [
      ...report.testing.runs.map((run) => [
        ...text(cleanLine(run.command), [{ type: 'code' }]),
        ...text(`: ${labels.testOutcomes[run.outcome]} (${labels.testSources[run.source]})`),
      ]),
      ...report.testing.notes.map(prose),
    ];
    if (testing.length > 0) content.push(list(testing));

    const limitations = limitationLines(report, labels);
    if (limitations.length > 0) {
      content.push(heading(3, labels.knownLimitations), list(limitations.map(prose)));
    }

    content.push({ type: 'rule' }, paragraph(text(footerText(footer), [{ type: 'em' }])));
    return { type: 'doc', version: 1, content };
  }
}

/** Created, modified, and deleted/renamed groups from Git's list, sorted by path. */
export function groupFiles(
  files: readonly ReportFile[],
  labels: ReportLabels,
): [string, ReportFile[]][] {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const groups: [string, ReportFile[]][] = [
    [labels.createdFiles, sorted.filter((f) => f.status === 'added' || f.status === 'copied')],
    [
      labels.modifiedFiles,
      sorted.filter((f) => f.status === 'modified' || f.status === 'type-changed'),
    ],
    [
      labels.deletedOrRenamedFiles,
      sorted.filter((f) => f.status === 'deleted' || f.status === 'renamed'),
    ],
  ];
  return groups.filter(([, group]) => group.length > 0);
}

/** The writer's notes by (new) path; only paths Git confirmed survive finalization. */
export function fileNotes(report: StructuredReport): Map<string, string> {
  const notes = new Map<string, string>();
  for (const entry of [...report.createdFiles, ...report.modifiedFiles, ...report.deletedFiles])
    if (entry.note) notes.set(entry.path, entry.note);
  for (const entry of report.renamedFiles) if (entry.note) notes.set(entry.to, entry.note);
  return notes;
}

/** Writer's limitations, then the coverage statement when not everything was analyzed. */
export function limitationLines(report: StructuredReport, labels: ReportLabels): string[] {
  const lines = [...report.limitations];
  const coverage = report.changeCoverage;
  if (!coverage.complete) {
    lines.push(
      labels.coverageIncomplete
        .replace('{analyzed}', String(coverage.analyzedFiles))
        .replace('{total}', String(coverage.totalFiles)),
    );
  }
  return lines;
}

export function endpointLabel(endpoint: { method?: string | undefined; endpoint: string }): string {
  return endpoint.method ? `${endpoint.method} ${endpoint.endpoint}` : endpoint.endpoint;
}

function fileLine(file: ReportFile, labels: ReportRenderInput['labels']): AdfInline[] {
  const path = text(cleanLine(file.path), [{ type: 'code' }]);
  const previous = file.previousPath ? text(cleanLine(file.previousPath), [{ type: 'code' }]) : [];
  switch (file.status) {
    case 'renamed':
      return [...previous, ...text(' → '), ...path];
    case 'copied': {
      const [before = '', after = ''] = labels.copiedFrom.split('{path}');
      return [...path, ...text(` (${before}`), ...previous, ...text(`${after})`)];
    }
    case 'type-changed':
      return [...path, ...text(` (${labels.typeChanged})`)];
    default:
      return path;
  }
}

function heading(level: 2 | 3, value: string): AdfBlock {
  return { type: 'heading', attrs: { level }, content: text(cleanLine(value)) };
}

function paragraph(content: AdfInline[]): AdfParagraph {
  return { type: 'paragraph', content };
}

function list(items: AdfInline[][]): AdfBulletList {
  return {
    type: 'bulletList',
    content: items.map((inline): AdfListItem => ({
      type: 'listItem',
      content: [paragraph(inline)],
    })),
  };
}

/** Text with line breaks kept as hardBreak nodes. */
function prose(value: string): AdfInline[] {
  const lines = clean(value).trim().split('\n');
  return lines.flatMap((line, index) => [
    ...(index > 0 ? [{ type: 'hardBreak' } as const] : []),
    ...text(line),
  ]);
}

/** ADF forbids empty text nodes. */
function text(value: string, marks?: AdfMark[]): AdfInline[] {
  if (value === '') return [];
  return [marks ? { type: 'text', text: value, marks } : { type: 'text', text: value }];
}

/** Normalizes line endings and replaces control characters that Jira cannot store. */
function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '�');
}

/** For paths and headings: no line breaks at all. */
function cleanLine(value: string): string {
  return clean(value).replace(/\n/g, '�');
}
