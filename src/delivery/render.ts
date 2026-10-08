import {
  MAX_FILES_PER_SECTION,
  endpointLabel,
  fileNotes,
  groupFiles,
  limitationLines,
} from '../adf/render';
import type { ReportFile } from '../adf/types';
import type { ReportLabels } from '../localization/catalog';
import type { StructuredReport } from '../report/schema';

/**
 * Deterministic StructuredReport → text for pasting into Jira (manual mode) and for
 * MCP comment bodies. Same input, same output: the approval digest covers it.
 *
 * Model-written text is escaped so it cannot become links, images, mentions, or
 * headings when Jira (or the MCP server) interprets Markdown. Paths come from Git and
 * are shown verbatim in code spans.
 */
export interface TextRenderInput {
  report: StructuredReport;
  files: readonly ReportFile[];
  labels: ReportLabels;
  /** Compact recovery marker; see `markerLine`. */
  marker: { reportId: string; sequence: number };
}

export interface TextRendering {
  markdown: string;
  text: string;
}

/**
 * The only machine-oriented line in a pasted report. It lets a later MCP or API-token
 * scan recognize this report in Jira (duplicate detection, recovery). It matches the
 * ADF footer marker that `findReportMarkers` reads, without trees or tool version.
 */
export function markerLine(marker: { reportId: string; sequence: number }): string {
  return `Git2Jira report ${marker.reportId} · #${String(marker.sequence)}`;
}

export function renderTextReport(input: TextRenderInput): TextRendering {
  return { markdown: render(input, MARKDOWN), text: render(input, PLAIN) };
}

interface Style {
  title(text: string): string;
  heading(text: string): string;
  prose(text: string): string;
  strong(text: string): string;
  code(text: string): string;
  bullet: string;
}

const MARKDOWN: Style = {
  title: (t) => `## ${escapeMarkdown(t)}`,
  heading: (t) => `### ${escapeMarkdown(t)}`,
  prose: (t) => escapeMarkdown(t),
  strong: (t) => `**${escapeMarkdown(t)}**`,
  code: codeSpan,
  bullet: '- ',
};

const PLAIN: Style = {
  title: (t) => `${t}\n${'='.repeat(Math.max(3, t.length))}`,
  heading: (t) => `${t}\n${'-'.repeat(Math.max(3, t.length))}`,
  prose: (t) => t,
  strong: (t) => t,
  code: (t) => t,
  bullet: '• ',
};

function render({ report, files, labels, marker }: TextRenderInput, style: Style): string {
  const blocks: string[] = [];
  const list = (items: string[]) =>
    items.map((item) => style.bullet + item.replace(/\n/g, `\n${' '.repeat(2)}`)).join('\n');

  blocks.push(style.title(`${labels.title} #${String(marker.sequence)}`));
  blocks.push(style.heading(labels.summary));
  blocks.push(
    report.summary
      .split(/\n{2,}/)
      .map((part) => style.prose(clean(part).trim()))
      .join('\n\n'),
  );

  blocks.push(style.heading(labels.completedWork));
  blocks.push(
    list(
      report.completedWork.map((work) => {
        const endpoints = work.endpoints.map((e) => style.code(cleanLine(endpointLabel(e))));
        return (
          `${style.strong(cleanLine(work.subject))} (${labels.changeKinds[work.kind]}): ${style.prose(clean(work.description).trim())}` +
          (endpoints.length > 0 ? ` — ${endpoints.join(', ')}` : '')
        );
      }),
    ),
  );

  const notes = fileNotes(report);
  for (const [title, group] of groupFiles(files, labels)) {
    const shown = group.slice(0, MAX_FILES_PER_SECTION).map((f) => {
      const note = notes.get(f.path);
      return fileLine(f, labels, style) + (note ? ` — ${style.prose(clean(note).trim())}` : '');
    });
    const hidden = group.length - shown.length;
    if (hidden > 0) shown.push(labels.moreItems.replace('{count}', String(hidden)));
    blocks.push(style.heading(title), list(shown));
  }

  blocks.push(style.heading(labels.testing), style.prose(labels.testStatus[report.testing.status]));
  const testing = [
    ...report.testing.runs.map(
      (run) =>
        `${style.code(cleanLine(run.command))}: ${labels.testOutcomes[run.outcome]} (${labels.testSources[run.source]})`,
    ),
    ...report.testing.notes.map((t) => style.prose(clean(t).trim())),
  ];
  if (testing.length > 0) blocks.push(list(testing));

  const limitations = limitationLines(report, labels);
  if (limitations.length > 0) {
    blocks.push(
      style.heading(labels.knownLimitations),
      list(limitations.map((t) => style.prose(clean(t).trim()))),
    );
  }

  blocks.push('---', markerLine(marker));
  return `${blocks.join('\n\n')}\n`;
}

function fileLine(file: ReportFile, labels: ReportLabels, style: Style): string {
  const current = style.code(cleanLine(file.path));
  const previous = file.previousPath ? style.code(cleanLine(file.previousPath)) : '';
  switch (file.status) {
    case 'renamed':
      return `${previous} → ${current}`;
    case 'copied':
      return `${current} (${labels.copiedFrom.replace('{path}', previous)})`;
    case 'type-changed':
      return `${current} (${labels.typeChanged})`;
    default:
      return current;
  }
}

/**
 * Backslash-escapes the characters that can start Markdown syntax anywhere in a line
 * (emphasis, code, links, images, autolinks, HTML, tables, strikethrough), and the
 * markers that only count at the start of a line (headings, quotes, lists, rules).
 * Links need `[`; escaping it makes `(…)` harmless, so parentheses stay readable.
 */
export function escapeMarkdown(value: string): string {
  return value
    .replace(/[\\`*_[\]<>!|~]/g, (c) => `\\${c}`)
    .replace(/^(\s*)(#{1,6}|[-+=]|\d+[.)])(?=\s|$)/gm, (_m, space: string, mark: string) =>
      /^\d/.test(mark) ? `${space}${mark.slice(0, -1)}\\${mark.slice(-1)}` : `${space}\\${mark}`,
    );
}

/** A code span that cannot be closed early by backticks inside the value. */
function codeSpan(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '�');
}

function cleanLine(value: string): string {
  return clean(value).replace(/\n/g, '�');
}
