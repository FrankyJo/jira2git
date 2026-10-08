import type { Language } from './languages';

/**
 * Localized labels for rendered reports (Phase 3). Structured report data stays
 * language-independent; only presentation strings are looked up here. File names,
 * issue keys, branch names, identifiers, and API endpoints are never translated.
 */
export interface ReportLabels {
  title: string;
  summary: string;
  changes: string;
  added: string;
  modified: string;
  removed: string;
  apiChanges: string;
  testing: string;
  risks: string;
  followUps: string;
  commitRange: string;
}

export interface LabelCatalog {
  labels(language: Language): ReportLabels;
}
