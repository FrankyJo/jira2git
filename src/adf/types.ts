import type { ReportLabels } from '../localization/catalog';
import type { StructuredReport } from '../report/schema';

/**
 * The subset of Atlassian Document Format that Git2Jira emits. Text from the
 * report is always placed in `text` nodes, never interpreted as markup, so
 * model output cannot inject links or mentions. Implemented in Phase 2.
 */
export type AdfMark = { type: 'strong' } | { type: 'em' } | { type: 'code' };

export interface AdfText {
  type: 'text';
  text: string;
  marks?: AdfMark[];
}

export interface AdfParagraph {
  type: 'paragraph';
  content: AdfInline[];
}

export interface AdfHeading {
  type: 'heading';
  attrs: { level: 1 | 2 | 3 | 4 | 5 | 6 };
  content: AdfInline[];
}

export interface AdfListItem {
  type: 'listItem';
  content: (AdfParagraph | AdfBulletList)[];
}

export interface AdfBulletList {
  type: 'bulletList';
  content: AdfListItem[];
}

export interface AdfRule {
  type: 'rule';
}

export type AdfInline = AdfText | { type: 'hardBreak' };
export type AdfBlock = AdfParagraph | AdfHeading | AdfBulletList | AdfRule;

export interface AdfDocument {
  type: 'doc';
  version: 1;
  content: AdfBlock[];
}

/** Metadata appended to every comment so history can be recovered from Jira. */
export interface ReportFooter {
  sequence: number;
  baseTree: string | null;
  targetTree: string;
  toolVersion: string;
}

export interface AdfRenderer {
  render(report: StructuredReport, labels: ReportLabels, footer: ReportFooter): AdfDocument;
}
