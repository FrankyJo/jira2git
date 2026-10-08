import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AdfDocumentSchema } from '../adf/validate';
import { CheckpointCorruptedError } from '../checkpoints/errors';
import { BaselineSchema, BranchIdentitySchema, JiraSiteSchema } from '../checkpoints/types';
import { McpServerNameSchema } from '../config/schema';
import { Git2JiraError } from '../core/errors';
import { IssueKeySchema, type RepositoryInfo } from '../git/types';
import { LanguageSchema } from '../localization/languages';
import {
  PublicationAttemptSchema,
  PublicationStatusSchema,
  ReportFileSchema,
  canTransition,
  type PublicationStatus,
} from '../publication/plan';
import { StructuredReportSchema } from '../report/schema';
import { stateDir } from '../snapshots/engine';
import { SnapshotSchema } from '../snapshots/types';

/**
 * Manual report states:
 *
 *   DRAFT ─► READY_TO_COPY ─► AWAITING_MANUAL_CONFIRMATION ─► MANUALLY_CONFIRMED
 *     │          ▲  │                 │      ▲                       │
 *     │          └──┘ (new text)      │      └──── revoke ───────────┘
 *     └──────────┴────────────────────┴─► CANCELLED
 *   any open state ─► RECOVERY_REQUIRED ─► (back to its state) | CANCELLED | MANUALLY_CONFIRMED
 *
 * - DRAFT: snapshot captured under a candidate ref; no report text yet.
 * - READY_TO_COPY: report validated and rendered; digest computed; saved locally.
 * - AWAITING_MANUAL_CONFIRMATION: the report was copied or exported for pasting.
 * - MANUALLY_CONFIRMED: the user stated that it is in Jira; checkpoint promoted.
 *   This is user-attested, never verified against Jira.
 * - CANCELLED: abandoned; the baseline did not move.
 * - RECOVERY_REQUIRED: local state disagrees (snapshot ref lost, a newer report was
 *   confirmed first, or a confirmation was interrupted). `report recover` explains.
 */
export const MANUAL_STATUSES = [
  'DRAFT',
  'READY_TO_COPY',
  'AWAITING_MANUAL_CONFIRMATION',
  'MANUALLY_CONFIRMED',
  'CANCELLED',
  'RECOVERY_REQUIRED',
] as const;

export const ManualStatusSchema = z.enum(MANUAL_STATUSES);
export type ManualStatus = z.infer<typeof ManualStatusSchema>;

const MANUAL_TRANSITIONS: Readonly<Record<ManualStatus, readonly ManualStatus[]>> = {
  DRAFT: ['READY_TO_COPY', 'CANCELLED', 'RECOVERY_REQUIRED'],
  READY_TO_COPY: [
    'READY_TO_COPY',
    'AWAITING_MANUAL_CONFIRMATION',
    'MANUALLY_CONFIRMED',
    'CANCELLED',
    'RECOVERY_REQUIRED',
  ],
  AWAITING_MANUAL_CONFIRMATION: [
    'AWAITING_MANUAL_CONFIRMATION',
    'READY_TO_COPY',
    'MANUALLY_CONFIRMED',
    'CANCELLED',
    'RECOVERY_REQUIRED',
  ],
  // Only a user-requested revocation reopens a confirmed report.
  MANUALLY_CONFIRMED: ['AWAITING_MANUAL_CONFIRMATION'],
  CANCELLED: [],
  RECOVERY_REQUIRED: [
    'RECOVERY_REQUIRED',
    'DRAFT',
    'READY_TO_COPY',
    'AWAITING_MANUAL_CONFIRMATION',
    'MANUALLY_CONFIRMED',
    'CANCELLED',
  ],
};

export const OPEN_MANUAL_STATUSES: readonly ManualStatus[] = [
  'DRAFT',
  'READY_TO_COPY',
  'AWAITING_MANUAL_CONFIRMATION',
  'RECOVERY_REQUIRED',
];

/** MCP drafts use the Phase 2 publication states, plus CANCELLED. */
export type McpStatus = PublicationStatus | 'CANCELLED';
const McpStatusSchema = z.union([PublicationStatusSchema, z.literal('CANCELLED')]);

export const OPEN_MCP_STATUSES: readonly McpStatus[] = [
  'DRAFT',
  'READY_FOR_REVIEW',
  'APPROVED',
  'PUBLISHING',
  'FAILED',
  'UNCERTAIN',
];

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Everything a report draft carries, whatever the delivery mode. */
const DraftCore = {
  schemaVersion: z.literal(1),
  reportId: z.uuid(),
  site: JiraSiteSchema,
  /** True when no Jira site was configured; the lineage uses a placeholder site. */
  siteIsPlaceholder: z.boolean(),
  issueKey: IssueKeySchema,
  repositoryId: z.uuid(),
  branch: BranchIdentitySchema,
  baseline: BaselineSchema,
  snapshot: SnapshotSchema,
  snapshotRef: z.string().startsWith('refs/git2jira/'),
  sequence: z.int().positive(),
  language: LanguageSchema,
  files: z.array(ReportFileSchema),
  changesDigest: DigestSchema,
  /** Optional context typed by the user. Passed to the report writer as data. */
  userContext: z.string().max(4000).optional(),
  report: StructuredReportSchema.optional(),
  rendered: z
    .strictObject({ markdown: z.string(), text: z.string(), adf: AdfDocumentSchema })
    .optional(),
  reportDigest: DigestSchema.optional(),
  /** Status changes with time, for `report show` and audits. */
  events: z.array(
    z.strictObject({
      at: z.iso.datetime(),
      status: z.string().max(40),
      note: z.string().max(500).optional(),
    }),
  ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

export const ManualDraftSchema = z.strictObject({
  ...DraftCore,
  mode: z.literal('manual'),
  status: ManualStatusSchema,
  /** Status to return to when RECOVERY_REQUIRED is resolved. */
  resumeStatus: ManualStatusSchema.optional(),
  recovery: z.strictObject({ reason: z.string().max(1000) }).optional(),
  exports: z.array(
    z.strictObject({
      at: z.iso.datetime(),
      via: z.enum(['clipboard', 'file']),
      path: z.string().optional(),
    }),
  ),
  /** The user's statement that this exact report is in Jira. Never model-generated. */
  attestation: z
    .strictObject({
      reportDigest: DigestSchema,
      attestedAt: z.iso.datetime(),
      method: z.literal('user-attested'),
      interactive: z.boolean(),
    })
    .optional(),
});

export const McpDraftSchema = z.strictObject({
  ...DraftCore,
  mode: z.literal('mcp'),
  status: McpStatusSchema,
  /** Claude Code MCP server that will publish. */
  server: McpServerNameSchema,
  /** Atlassian cloud id of the site, from `getAccessibleAtlassianResources`. */
  cloudId: z.string().min(1).max(100),
  /** Issue as returned by the MCP issue lookup when the draft was prepared. */
  issue: z.strictObject({ id: z.string().min(1).max(50), summary: z.string().max(2000) }),
  approval: z.strictObject({ reportDigest: DigestSchema, approvedAt: z.iso.datetime() }).optional(),
  attempts: z.array(PublicationAttemptSchema),
  failure: z.strictObject({ retryable: z.boolean(), reason: z.string().max(2000) }).optional(),
  publication: z
    .strictObject({
      commentId: z.string().regex(/^[0-9]{1,30}$/),
      commentUrl: z.url(),
      publishedAt: z.iso.datetime(),
      /** `tool-result`: from the create call's result; `read-back`: found in a comment listing. */
      evidence: z.enum(['tool-result', 'read-back']),
    })
    .optional(),
  duplicateCommentIds: z.array(z.string()).optional(),
});

export const DraftSchema = z.discriminatedUnion('mode', [ManualDraftSchema, McpDraftSchema]);

export type ManualDraft = z.infer<typeof ManualDraftSchema>;
export type McpDraft = z.infer<typeof McpDraftSchema>;
export type Draft = z.infer<typeof DraftSchema>;

export function isOpen(draft: Draft): boolean {
  return draft.mode === 'manual'
    ? OPEN_MANUAL_STATUSES.includes(draft.status)
    : OPEN_MCP_STATUSES.includes(draft.status);
}

export function canTransitionDraft(draft: Draft, to: string): boolean {
  if (draft.mode === 'manual') {
    const target = ManualStatusSchema.safeParse(to);
    return target.success && MANUAL_TRANSITIONS[draft.status].includes(target.data);
  }
  if (to === 'CANCELLED')
    return ['DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'FAILED'].includes(draft.status);
  if (draft.status === 'CANCELLED') return false;
  const target = PublicationStatusSchema.safeParse(to);
  return target.success && canTransition(draft.status, target.data);
}

export class DraftNotFoundError extends Git2JiraError {
  constructor(reportId: string) {
    super(`No report draft ${reportId} exists in this repository. See "git2jira report pending".`);
  }
}

/** Drafts live in `<git common dir>/git2jira/drafts/<reportId>.json`, never in the working tree. */
export class DraftStore {
  dir(repository: RepositoryInfo): string {
    return path.join(stateDir(repository), 'drafts');
  }

  /** Where `report export` writes by default: next to the drafts, outside the working tree. */
  exportDir(repository: RepositoryInfo): string {
    return path.join(stateDir(repository), 'exports');
  }

  private file(repository: RepositoryInfo, reportId: string): string {
    return path.join(this.dir(repository), `${z.uuid().parse(reportId)}.json`);
  }

  async read(repository: RepositoryInfo, reportId: string): Promise<Draft> {
    const draft = await this.readOptional(repository, reportId);
    if (!draft) throw new DraftNotFoundError(reportId);
    return draft;
  }

  async readOptional(repository: RepositoryInfo, reportId: string): Promise<Draft | undefined> {
    if (!z.uuid().safeParse(reportId).success) return undefined;
    const file = this.file(repository, reportId);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new CheckpointCorruptedError(file, 'invalid JSON');
    }
    const parsed = DraftSchema.safeParse(json);
    if (!parsed.success || parsed.data.reportId !== reportId) {
      throw new CheckpointCorruptedError(file, 'invalid report draft');
    }
    return parsed.data;
  }

  async write(repository: RepositoryInfo, draft: Draft): Promise<void> {
    const file = this.file(repository, draft.reportId);
    const validated = DraftSchema.parse(draft);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  }

  /** Writes `next` if the draft's state machine allows it, recording the change. */
  async transition<D extends Draft>(
    repository: RepositoryInfo,
    current: D,
    next: D,
    now: Date,
    note?: string,
  ): Promise<D> {
    if (current.status !== next.status && !canTransitionDraft(current, next.status)) {
      throw new Git2JiraError(
        `Report ${current.reportId} cannot go from ${current.status} to ${next.status}.`,
      );
    }
    const at = now.toISOString();
    const event = {
      at,
      status: next.status,
      ...(note ? { note: note.slice(0, 500) } : {}),
    };
    const updated = {
      ...next,
      events: current.status === next.status && !note ? next.events : [...next.events, event],
      updatedAt: at,
    } as D;
    await this.write(repository, updated);
    return updated;
  }

  async list(repository: RepositoryInfo): Promise<Draft[]> {
    let names: string[];
    try {
      names = await readdir(this.dir(repository));
    } catch {
      return [];
    }
    const drafts: Draft[] = [];
    for (const name of names) {
      const id = /^([0-9a-f-]{36})\.json$/.exec(name)?.[1];
      if (!id) continue;
      const draft = await this.readOptional(repository, id).catch(() => undefined);
      if (draft) drafts.push(draft);
    }
    return drafts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
