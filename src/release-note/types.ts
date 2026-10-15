import type { AnalysisPackage } from '../ai/analysis';
import type { JiraSite } from '../checkpoints/types';
import type { Language } from '../localization/languages';
import type { ChangeSet } from '../snapshots/types';
import type { ReleaseNoteDraft } from './draft';
import type { EarlierReport } from './prompt';

export interface ReleaseNotePrepareRequest {
  mode: 'manual' | 'mcp';
  cwd: string;
  issue?: string | undefined;
  projectKeys?: readonly string[] | undefined;
  /** `--base`, then `base.branch`; the same rules as the first report of an issue. */
  base?: string | undefined;
  configuredBase?: string | undefined;
  language: Language;
  site: JiraSite;
  siteIsPlaceholder: boolean;
  /** Jira issue details, if the user has them. MCP mode reads them from the lookup. */
  issueContext?: { title?: string | undefined; description?: string | undefined } | undefined;
  mcp?: { server: string; cloudId: string; issueLookup: unknown } | undefined;
}

export type ReleaseNotePrepareOutcome =
  | {
      status: 'prepared';
      draft: ReleaseNoteDraft;
      changeSet: ChangeSet;
      analysis: AnalysisPackage;
      earlierReports: EarlierReport[];
      /** Release notes of this issue already in Jira (or stated to be). */
      delivered: ReleaseNoteDraft[];
    }
  | { status: 'no-changes' }
  /** An open release note already exists for this issue: continue or cancel it first. */
  | { status: 'pending'; draft: ReleaseNoteDraft };

/** What the Skill must send with the comment creation tool, exactly. */
export interface ReleaseNotePublishPayload {
  noteId: string;
  server: string;
  cloudId: string;
  issueKey: string;
  /** Documented tool name; the session's full name is `mcp__<server>__<tool>`. */
  tool: string;
  /** Use `markdown` or `adf`, whichever body format the tool's schema accepts. */
  body: { markdown: string; adf: unknown };
  marker: string;
  noteDigest: string;
}

export type ReleaseNoteMcpOutcome =
  | {
      state: 'PUBLISHED' | 'RECOVERED';
      draft: ReleaseNoteDraft;
      commentId: string;
      commentUrl: string;
    }
  | { state: 'FAILED'; draft: ReleaseNoteDraft; retryable: boolean; reason: string }
  | { state: 'UNCERTAIN'; draft: ReleaseNoteDraft; reason: string; retryAfterMs: number };
