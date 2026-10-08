import { z } from 'zod';
import { isCheckpoint, type ReportRecord } from '../checkpoints/types';
import type { Draft } from './draft';
import { markerLine } from './render';

/**
 * Publication receipt: what Git2Jira knows about one report's delivery, derived each
 * time from the CLI's own state (the draft and the lineage journal).
 *
 * A receipt is output only. The CLI never accepts one as input, so a receipt written or
 * edited by anyone else proves nothing; run `git2jira report receipt` to get the real one.
 * `checkpoint.advanced` is read from the journal and the checkpoint ref, not from the
 * draft, so it is true only when the next report really starts after this snapshot.
 */
export const RECEIPT_OPERATIONS = [
  /** No text yet, or text not yet approved or confirmed. */
  'pending',
  /** MCP: approved and handed to the comment tool; result not recorded yet. */
  'in-flight',
  /** MCP: the tool result carried this report's marker. */
  'published',
  /** MCP: found in a comment listing after an unclear result. */
  'recovered',
  /** Manual: the user confirmed this digest is in Jira (not verified). */
  'user-attested',
  /** MCP: Jira refused it, or it was not sent. Not in Jira. */
  'failed',
  /** MCP: may or may not be in Jira. Nothing is re-sent until it is settled. */
  'uncertain',
  'cancelled',
  /** Manual: local state needs `report recover`. */
  'recovery-required',
] as const;

export const PublicationReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('git2jira-publication-receipt'),
  issuedAt: z.iso.datetime(),
  cliVersion: z.string(),
  reportId: z.uuid(),
  mode: z.enum(['manual', 'mcp']),
  issueKey: z.string(),
  sequence: z.int().positive(),
  site: z.strictObject({ url: z.string().nullable(), placeholder: z.boolean() }),
  snapshot: z.strictObject({
    id: z.string(),
    tree: z.string(),
    includesUncommittedChanges: z.boolean(),
  }),
  reportDigest: z.string().nullable(),
  /** The line in the comment that identifies this report. */
  marker: z.string(),
  status: z.string(),
  operation: z.enum(RECEIPT_OPERATIONS),
  comment: z.strictObject({ id: z.string(), url: z.string() }).nullable(),
  evidence: z.enum(['tool-result', 'read-back', 'user-attested']).nullable(),
  /** True only when a comment listing showed this report's marker on the issue. */
  verifiedInJira: z.boolean(),
  checkpoint: z.strictObject({
    advanced: z.boolean(),
    confirmedBy: z.enum(['jira-api', 'mcp-tool', 'user-attested']).nullable(),
  }),
  notes: z.array(z.string()),
});

export type PublicationReceipt = z.infer<typeof PublicationReceiptSchema>;

export function buildReceipt(input: {
  draft: Draft;
  /** This report's record in the lineage journal, if any. */
  record: ReportRecord | undefined;
  now: Date;
  cliVersion: string;
}): PublicationReceipt {
  const { draft, record } = input;
  const checkpoint =
    record !== undefined && isCheckpoint(record) && record.reportId === draft.reportId
      ? record
      : undefined;
  const advanced = checkpoint !== undefined;
  const notes: string[] = [];
  let operation: PublicationReceipt['operation'];
  let comment: PublicationReceipt['comment'] = null;
  let evidence: PublicationReceipt['evidence'] = null;
  let verifiedInJira = false;

  if (draft.mode === 'manual') {
    switch (draft.status) {
      case 'MANUALLY_CONFIRMED':
        operation = 'user-attested';
        evidence = 'user-attested';
        notes.push('Confirmed by the user; Git2Jira did not check Jira.');
        break;
      case 'CANCELLED':
        operation = 'cancelled';
        break;
      case 'RECOVERY_REQUIRED':
        operation = 'recovery-required';
        if (draft.recovery) notes.push(draft.recovery.reason);
        break;
      default:
        operation = 'pending';
    }
  } else {
    switch (draft.status) {
      case 'PUBLISHED':
      case 'RECOVERED':
        operation = draft.status === 'PUBLISHED' ? 'published' : 'recovered';
        if (draft.publication) {
          comment = { id: draft.publication.commentId, url: draft.publication.commentUrl };
          evidence = draft.publication.evidence;
          verifiedInJira =
            draft.publication.evidence === 'read-back' ||
            draft.publication.readBack?.result === 'found';
          const readBack = draft.publication.readBack;
          if (readBack && readBack.result !== 'found') {
            notes.push(
              `A later comment listing did not confirm it (${readBack.result}${readBack.detail ? `: ${readBack.detail}` : ''}).`,
            );
          }
        }
        break;
      case 'PUBLISHING':
        operation = 'in-flight';
        break;
      case 'UNCERTAIN':
        operation = 'uncertain';
        notes.push('It may or may not be in Jira; reconcile it with a comment listing.');
        break;
      case 'FAILED':
        operation = 'failed';
        if (draft.failure) notes.push(draft.failure.reason);
        break;
      case 'CANCELLED':
        operation = 'cancelled';
        break;
      default:
        operation = 'pending';
    }
  }
  if (!advanced && ['published', 'recovered', 'user-attested'].includes(operation)) {
    notes.push('The checkpoint was not saved; run "git2jira report recover".');
  }

  return {
    schemaVersion: 1,
    kind: 'git2jira-publication-receipt',
    issuedAt: input.now.toISOString(),
    cliVersion: input.cliVersion,
    reportId: draft.reportId,
    mode: draft.mode,
    issueKey: draft.issueKey,
    sequence: draft.sequence,
    site: {
      url: draft.siteIsPlaceholder ? null : draft.site.url,
      placeholder: draft.siteIsPlaceholder,
    },
    snapshot: {
      id: draft.snapshot.commit,
      tree: draft.snapshot.tree,
      includesUncommittedChanges: draft.snapshot.includesUncommittedChanges,
    },
    reportDigest: draft.reportDigest ?? null,
    marker: markerLine({ reportId: draft.reportId, sequence: draft.sequence }),
    status: draft.status,
    operation,
    comment,
    evidence,
    verifiedInJira,
    checkpoint: {
      advanced,
      // Records from before Phase 2.5 were all confirmed through the Jira REST API.
      confirmedBy: checkpoint ? (checkpoint.publication.confirmedBy ?? 'jira-api') : null,
    },
    notes,
  };
}
