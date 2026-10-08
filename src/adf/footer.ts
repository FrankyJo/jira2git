import type { ReportFooter } from './types';

/**
 * Every comment ends with a fixed, language-independent footer line such as
 *
 *   Git2Jira report 3f2a9c1e-…-… · #2 · 1a2b3c4d5e6f..9f8e7d6c5b4a · git2jira 0.1.0
 *
 * The report id in it is the recovery marker: when the comment property is
 * missing or Jira's response was lost, the comment is still recognized by
 * this text. It contains no secrets, paths, or branch names.
 */
const MARKER =
  /Git2Jira report ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) · #([1-9][0-9]*)/g;

export function footerText(footer: ReportFooter): string {
  return (
    `Git2Jira report ${footer.reportId} · #${String(footer.sequence)} · ` +
    `${footer.baseTree.slice(0, 12)}..${footer.targetTree.slice(0, 12)} · git2jira ${footer.toolVersion}`
  );
}

export interface ReportMarker {
  reportId: string;
  sequence: number;
}

/** All report markers in a comment's text. More than one means the comment is not ours to trust. */
export function findReportMarkers(text: string): ReportMarker[] {
  return [...text.matchAll(MARKER)].map((m) => ({
    reportId: m[1] ?? '',
    sequence: Number(m[2]),
  }));
}
