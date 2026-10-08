import type { ReportFile } from '../adf/types';
import { terminalSafe, terminalSafeLine } from '../core/sanitize';
import { LANGUAGE_NAMES, type Language } from '../localization/languages';
import type { StoredReport } from './schema';

/**
 * Human-readable terminal preview of a report: the facts the user needs to decide
 * (issue, site, branch, language, mode, file counts, tests, snapshot, warnings), then the
 * exact text that would be pasted or published. Never shows credentials; internal
 * checkpoint data is limited to the short snapshot identity.
 */
export interface PreviewInput {
  issueKey: string;
  site: string | null;
  branch: string;
  language: Language;
  mode: 'manual' | 'mcp' | 'api-token';
  sequence: number;
  reportId: string | null;
  files: readonly ReportFile[];
  report: StoredReport | undefined;
  baseTree: string;
  targetTree: string;
  snapshotCommit: string;
  /** The rendering that will be pasted or published. */
  body: string;
  digest: string | null;
  writer: string | null;
  warnings: readonly string[];
}

export function renderPreview(input: PreviewInput): string {
  const count = (statuses: string[]) =>
    input.files.filter((f) => statuses.includes(f.status)).length;
  const created = count(['added', 'copied']);
  const modified = count(['modified', 'type-changed']);
  const removed = count(['deleted', 'renamed']);
  const rule = '─'.repeat(72);
  const lines = [
    rule,
    row('Jira issue', input.issueKey),
    row('Jira site', input.site ?? 'not configured (manual reports do not need one)'),
    row('Git branch', input.branch),
    row('Language', `${input.language} (${LANGUAGE_NAMES[input.language].native})`),
    row('Mode', input.mode),
    row('Report', `#${String(input.sequence)}${input.reportId ? ` · ${input.reportId}` : ''}`),
    row(
      'Files',
      `${String(created)} created · ${String(modified)} modified · ${String(removed)} deleted or renamed`,
    ),
    row('Tests', testLine(input.report)),
    row(
      'Snapshot',
      `${input.baseTree.slice(0, 12)}..${input.targetTree.slice(0, 12)} (commit ${input.snapshotCommit.slice(0, 12)})`,
    ),
    ...(input.writer ? [row('Written by', input.writer)] : []),
    ...(input.digest ? [row('Digest', input.digest)] : []),
  ];
  if (input.warnings.length > 0) {
    lines.push('Warnings:');
    for (const warning of input.warnings) lines.push(`  ! ${terminalSafeLine(warning, 400)}`);
  }
  lines.push(rule, terminalSafe(input.body, 100_000).trimEnd(), rule);
  return lines.join('\n');
}

function row(label: string, value: string): string {
  return `${`${label}:`.padEnd(12)} ${terminalSafeLine(value, 300)}`;
}

function testLine(report: StoredReport | undefined): string {
  if (!report) return 'unknown';
  if (report.schemaVersion === 1) return 'stated by the author (not verified)';
  const { status, runs } = report.testing;
  const label =
    status === 'not-run'
      ? 'not run (the report says so)'
      : status === 'reported'
        ? 'stated by the author (not verified)'
        : status;
  const commands = runs.map((r) => `${r.command}: ${r.outcome}, ${r.source}`);
  return commands.length > 0 ? `${label} — ${commands.join('; ')}` : label;
}
