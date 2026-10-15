import type {
  AdfBlock,
  AdfDocument,
  AdfInline,
  AdfListItem,
  AdfMark,
  AdfParagraph,
} from '../adf/types';
import { escapeMarkdown } from '../delivery/render';
import type { ReleaseNoteLabels } from '../localization/catalog';
import type { ReleaseNote, ReleaseNoteBlock } from './schema';

/**
 * Deterministic ReleaseNote → ADF, Markdown, and plain text. Same input, same output, so
 * the approval digest covers exactly what is published. Writer text goes into `text`
 * nodes only (ADF) or is escaped (Markdown), so it cannot become links or mentions.
 * Sources and evidence are never rendered.
 *
 * Every rendering ends with the release note marker. It differs from the report marker
 * (`Git2Jira report <id> · #n`), so report history never mistakes a release note for a
 * report, and the reverse.
 */
export interface ReleaseNoteRenderInput {
  note: ReleaseNote;
  labels: ReleaseNoteLabels;
  toolVersion: string;
}

export interface ReleaseNoteRendering {
  markdown: string;
  text: string;
  adf: AdfDocument;
}

const MARKER =
  /Git2Jira release note ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

export function releaseNoteMarker(noteId: string): string {
  return `Git2Jira release note ${noteId}`;
}

/** Release note ids marked in a comment's text. More than one means it is not ours to trust. */
export function findReleaseNoteMarkers(text: string): string[] {
  return [...text.matchAll(MARKER)].map((m) => m[1] ?? '');
}

export function renderReleaseNote(input: ReleaseNoteRenderInput): ReleaseNoteRendering {
  return {
    markdown: renderText(input, MARKDOWN),
    text: renderText(input, PLAIN),
    adf: renderAdf(input),
  };
}

// --- ADF --------------------------------------------------------------------

function renderAdf({ note, labels, toolVersion }: ReleaseNoteRenderInput): AdfDocument {
  const content: AdfBlock[] = [
    heading(2, `${labels.title}: ${note.issueKey}`),
    paragraph([...text(`${labels.goal} – `, [{ type: 'strong' }]), ...prose(note.goal.statement)]),
  ];
  if (note.goal.objectives.length > 0) {
    content.push(
      list(
        'bulletList',
        note.goal.objectives.map((o) => [
          ...text(line(o.title), o.description ? [{ type: 'strong' }] : undefined),
          ...(o.description ? [...text(' – '), ...prose(o.description)] : []),
        ]),
      ),
    );
  }
  content.push(paragraph(text(labels.implemented)));
  for (const section of note.sections) {
    content.push(heading(3, section.title));
    for (const block of section.blocks) content.push(...adfBlock(block, labels));
  }
  content.push(
    { type: 'rule' },
    paragraph(
      text(`${releaseNoteMarker(note.noteId)} · git2jira ${toolVersion}`, [{ type: 'em' }]),
    ),
  );
  return { type: 'doc', version: 1, content };
}

function adfBlock(block: ReleaseNoteBlock, labels: ReleaseNoteLabels): AdfBlock[] {
  switch (block.type) {
    case 'paragraph':
      return [paragraph(prose(block.text))];
    case 'steps':
      return [list('orderedList', block.items.map(prose))];
    case 'bullets':
      return [list('bulletList', block.items.map(prose))];
    case 'definitions':
      return [
        list(
          'bulletList',
          block.items.map((i) => [
            ...text(line(i.term), [{ type: 'strong' }]),
            ...text(' – '),
            ...prose(i.description),
          ]),
        ),
      ];
    case 'table':
      return [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: block.columns.map((c) => ({
                type: 'tableHeader',
                content: [paragraph(text(line(c)))],
              })),
            },
            ...block.rows.map((row) => ({
              type: 'tableRow' as const,
              content: row.map((c) => ({
                type: 'tableCell' as const,
                content: [paragraph(text(line(c)))],
              })),
            })),
          ],
        },
      ];
    case 'uiMessage':
      return [
        {
          type: 'panel',
          attrs: { panelType: 'info' },
          content: [
            paragraph(text(`«${line(block.text)}»`, [{ type: 'strong' }])),
            paragraph(prose(block.meaning)),
          ],
        },
      ];
    case 'note':
      return [
        {
          type: 'panel',
          attrs: { panelType: 'note' },
          content: [
            paragraph([...text(`${labels.note}: `, [{ type: 'strong' }]), ...prose(block.text)]),
          ],
        },
      ];
    case 'screenshot':
      return [
        paragraph(
          text(labels.screenshot.replace('{description}', line(block.description)), [
            { type: 'em' },
          ]),
        ),
      ];
  }
}

function heading(level: 2 | 3, value: string): AdfBlock {
  return { type: 'heading', attrs: { level }, content: text(line(value)) };
}

function paragraph(content: AdfInline[]): AdfParagraph {
  return { type: 'paragraph', content };
}

function list(type: 'bulletList' | 'orderedList', items: AdfInline[][]): AdfBlock {
  return {
    type,
    content: items.map((inline): AdfListItem => ({
      type: 'listItem',
      content: [paragraph(inline)],
    })),
  };
}

function prose(value: string): AdfInline[] {
  return clean(value)
    .trim()
    .split('\n')
    .flatMap((part, index) => [
      ...(index > 0 ? [{ type: 'hardBreak' } as const] : []),
      ...text(part),
    ]);
}

function text(value: string, marks?: AdfMark[]): AdfInline[] {
  if (value === '') return [];
  return [marks ? { type: 'text', text: value, marks } : { type: 'text', text: value }];
}

// --- Markdown and plain text -------------------------------------------------

interface Style {
  title(text: string): string;
  heading(text: string): string;
  prose(text: string): string;
  strong(text: string): string;
  em(text: string): string;
  table(columns: string[], rows: string[][]): string;
  quote(lines: string[]): string;
}

const MARKDOWN: Style = {
  title: (t) => `## ${escapeMarkdown(t)}`,
  heading: (t) => `### ${escapeMarkdown(t)}`,
  prose: (t) => escapeMarkdown(t),
  strong: (t) => `**${escapeMarkdown(t)}**`,
  em: (t) => `_${escapeMarkdown(t)}_`,
  table: (columns, rows) =>
    [
      `| ${columns.map(escapeMarkdown).join(' | ')} |`,
      `| ${columns.map(() => '---').join(' | ')} |`,
      ...rows.map((row) => `| ${row.map(escapeMarkdown).join(' | ')} |`),
    ].join('\n'),
  quote: (lines) => lines.map((l) => `> ${l}`).join('\n>\n'),
};

const PLAIN: Style = {
  title: (t) => `${t}\n${'='.repeat(Math.max(3, t.length))}`,
  heading: (t) => `${t}\n${'-'.repeat(Math.max(3, t.length))}`,
  prose: (t) => t,
  strong: (t) => t,
  em: (t) => t,
  table: (columns, rows) =>
    [columns.join(' – '), ...rows.map((row) => `• ${row.join(' – ')}`)].join('\n'),
  quote: (lines) => lines.map((l) => `  ${l}`).join('\n'),
};

function renderText({ note, labels }: ReleaseNoteRenderInput, style: Style): string {
  const out: string[] = [];
  const p = (value: string) => style.prose(clean(value).trim());
  const items = (values: string[], ordered = false) =>
    values
      .map((v, i) => `${ordered ? `${String(i + 1)}. ` : '- '}${v.replace(/\n/g, '\n   ')}`)
      .join('\n');

  out.push(style.title(`${labels.title}: ${note.issueKey}`));
  out.push(`${style.strong(`${labels.goal} –`)} ${p(note.goal.statement)}`);
  if (note.goal.objectives.length > 0) {
    out.push(
      items(
        note.goal.objectives.map((o) =>
          o.description
            ? `${style.strong(line(o.title))} – ${p(o.description)}`
            : style.prose(line(o.title)),
        ),
      ),
    );
  }
  out.push(style.prose(labels.implemented));
  for (const section of note.sections) {
    out.push(style.heading(line(section.title)));
    for (const block of section.blocks) {
      switch (block.type) {
        case 'paragraph':
          out.push(p(block.text));
          break;
        case 'steps':
          out.push(items(block.items.map(p), true));
          break;
        case 'bullets':
          out.push(items(block.items.map(p)));
          break;
        case 'definitions':
          out.push(
            items(block.items.map((i) => `${style.strong(line(i.term))} – ${p(i.description)}`)),
          );
          break;
        case 'table':
          out.push(
            style.table(
              block.columns.map(line),
              block.rows.map((r) => r.map(line)),
            ),
          );
          break;
        case 'uiMessage':
          out.push(style.quote([style.strong(`«${line(block.text)}»`), p(block.meaning)]));
          break;
        case 'note':
          out.push(style.quote([`${style.strong(`${labels.note}:`)} ${p(block.text)}`]));
          break;
        case 'screenshot':
          out.push(style.em(labels.screenshot.replace('{description}', line(block.description))));
          break;
      }
    }
  }
  out.push('---', releaseNoteMarker(note.noteId));
  return `${out.join('\n\n')}\n`;
}

function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '�');
}

/** Headings, terms, cells, and labels: one line. */
function line(value: string): string {
  return clean(value).replace(/\n+/g, ' ').trim();
}
