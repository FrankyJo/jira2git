import type { ReportLabels } from '../localization/catalog';
import type { StructuredReport } from '../report/schema';

/**
 * The subset of Atlassian Document Format that Git2Jira emits. Text from the
 * report is always placed in `text` nodes, never interpreted as markup, so
 * model output cannot inject links or mentions.
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

/** Non-secret metadata shown in every comment footer, so reports can be recognized in Jira. */
export interface ReportFooter {
  reportId: string;
  sequence: number;
  baseTree: string;
  targetTree: string;
  toolVersion: string;
}

export type ReportFileStatus =
  'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed';

/** A changed path, taken from Git (never from model output). */
export interface ReportFile {
  status: ReportFileStatus;
  path: string;
  previousPath?: string | undefined;
}

export interface ReportRenderInput {
  report: StructuredReport;
  files: readonly ReportFile[];
  labels: ReportLabels;
  footer: ReportFooter;
}

export interface AdfRenderer {
  render(input: ReportRenderInput): AdfDocument;
}
