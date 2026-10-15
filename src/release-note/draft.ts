import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AdfDocumentSchema } from '../adf/validate';
import { CheckpointCorruptedError } from '../checkpoints/errors';
import { JiraSiteSchema } from '../checkpoints/types';
import { McpServerNameSchema } from '../config/schema';
import { Git2JiraError } from '../core/errors';
import { IssueKeySchema, type RepositoryInfo } from '../git/types';
import { LanguageSchema } from '../localization/languages';
import { PublicationAttemptSchema, ReportFileSchema } from '../publication/plan';
import { stateDir } from '../snapshots/engine';
import { ObjectIdSchema } from '../snapshots/types';
import { ReleaseNoteSchema } from './schema';

/**
 * Release note drafts. A release note never moves a checkpoint and never touches report
 * history; its own state machine only records how far delivery got.
 *
 *   manual: DRAFT ─► READY ─► CONFIRMED (user-attested)
 *   mcp:    DRAFT ─► READY ─► PUBLISHING ─► PUBLISHED
 *                                 │  ├────► FAILED ─► PUBLISHING (retry)
 *                                 │  └────► UNCERTAIN ─► RECOVERED | FAILED
 *   DRAFT, READY, FAILED ─► CANCELLED
 *
 * - READY: validated, rendered, digest computed. A new text keeps it READY.
 * - CONFIRMED: the user stated that they pasted this exact text into Jira.
 * - PUBLISHING: the user approved the digest and the MCP comment call is about to run.
 * - UNCERTAIN: the call's outcome is unknown; only a comment listing settles it.
 */
export const RELEASE_NOTE_STATUSES = [
  'DRAFT',
  'READY',
  'CONFIRMED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'UNCERTAIN',
  'RECOVERED',
  'CANCELLED',
] as const;

export const ReleaseNoteStatusSchema = z.enum(RELEASE_NOTE_STATUSES);
export type ReleaseNoteStatus = z.infer<typeof ReleaseNoteStatusSchema>;

const TRANSITIONS: Readonly<Record<ReleaseNoteStatus, readonly ReleaseNoteStatus[]>> = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['READY', 'CONFIRMED', 'PUBLISHING', 'CANCELLED'],
  CONFIRMED: [],
  PUBLISHING: ['PUBLISHED', 'FAILED', 'UNCERTAIN', 'RECOVERED'],
  PUBLISHED: [],
  FAILED: ['PUBLISHING', 'RECOVERED', 'CANCELLED'],
  UNCERTAIN: ['UNCERTAIN', 'RECOVERED', 'FAILED'],
  RECOVERED: [],
  CANCELLED: [],
};

const MANUAL_ONLY: readonly ReleaseNoteStatus[] = ['CONFIRMED'];
const MCP_ONLY: readonly ReleaseNoteStatus[] = [
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'UNCERTAIN',
  'RECOVERED',
];

export const OPEN_RELEASE_NOTE_STATUSES: readonly ReleaseNoteStatus[] = [
  'DRAFT',
  'READY',
  'PUBLISHING',
  'FAILED',
  'UNCERTAIN',
];

/** States in which the release note is (or is stated to be) in Jira. */
export const DELIVERED_RELEASE_NOTE_STATUSES: readonly ReleaseNoteStatus[] = [
  'CONFIRMED',
  'PUBLISHED',
  'RECOVERED',
];

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const ReleaseNoteDraftSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    noteId: z.uuid(),
    mode: z.enum(['manual', 'mcp']),
    status: ReleaseNoteStatusSchema,
    site: JiraSiteSchema,
    siteIsPlaceholder: z.boolean(),
    issueKey: IssueKeySchema,
    repositoryId: z.uuid(),
    branch: z.string().min(1).max(500),
    /** Where the branch left its base branch: the start of the release note. */
    base: z.strictObject({
      ref: z.string().min(1),
      name: z.string().min(1),
      commit: ObjectIdSchema,
      mergeBase: ObjectIdSchema,
      tree: ObjectIdSchema,
    }),
    /** The last commit the release note covers. Uncommitted work is never included. */
    head: z.strictObject({ commit: ObjectIdSchema, tree: ObjectIdSchema }),
    language: LanguageSchema,
    files: z.array(ReportFileSchema),
    changesDigest: DigestSchema,
    issueContext: z
      .strictObject({
        title: z.string().max(2000).optional(),
        description: z.string().max(20_000).optional(),
        /**
         * The parent issue (usually the epic), read when the issue itself does not state
         * the goal. Untrusted, like the issue text; its key comes from the issue lookup.
         */
        parent: z
          .strictObject({
            key: IssueKeySchema,
            type: z.string().max(100).optional(),
            title: z.string().max(2000).optional(),
            description: z.string().max(20_000).optional(),
          })
          .optional(),
      })
      .optional(),
    /** MCP mode: where and on which issue the comment goes. */
    mcp: z
      .strictObject({
        server: McpServerNameSchema,
        cloudId: z.string().min(1).max(100),
        issue: z.strictObject({
          id: z.string().min(1).max(50),
          summary: z.string().max(2000),
          /** `fields.parent` of the issue lookup: the only parent `release-note parent` accepts. */
          parent: z
            .strictObject({
              key: IssueKeySchema,
              summary: z.string().max(2000).optional(),
              type: z.string().max(100).optional(),
            })
            .optional(),
        }),
      })
      .optional(),
    note: ReleaseNoteSchema.optional(),
    rendered: z
      .strictObject({ markdown: z.string(), text: z.string(), adf: AdfDocumentSchema })
      .optional(),
    noteDigest: DigestSchema.optional(),
    warnings: z.array(z.string().max(1000)).max(50).default([]),
    attestation: z
      .strictObject({ noteDigest: DigestSchema, attestedAt: z.iso.datetime() })
      .optional(),
    attempts: z.array(PublicationAttemptSchema).default([]),
    failure: z.strictObject({ retryable: z.boolean(), reason: z.string().max(2000) }).optional(),
    publication: z
      .strictObject({
        commentId: z.string().regex(/^[0-9]{1,30}$/),
        commentUrl: z.url(),
        publishedAt: z.iso.datetime(),
        evidence: z.enum(['tool-result', 'read-back']),
      })
      .optional(),
    events: z.array(
      z.strictObject({
        at: z.iso.datetime(),
        status: z.string().max(40),
        note: z.string().max(500).optional(),
      }),
    ),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .refine((d) => (d.mode === 'mcp') === (d.mcp !== undefined), {
    message: 'MCP details belong to MCP release notes only',
  })
  .refine((d) => !(d.mode === 'manual' ? MCP_ONLY : MANUAL_ONLY).includes(d.status), {
    message: 'status does not belong to the delivery mode',
  });

export type ReleaseNoteDraft = z.infer<typeof ReleaseNoteDraftSchema>;

export function isOpenReleaseNote(draft: ReleaseNoteDraft): boolean {
  return OPEN_RELEASE_NOTE_STATUSES.includes(draft.status);
}

export function canTransitionReleaseNote(draft: ReleaseNoteDraft, to: ReleaseNoteStatus): boolean {
  if ((draft.mode === 'manual' ? MCP_ONLY : MANUAL_ONLY).includes(to)) return false;
  return TRANSITIONS[draft.status].includes(to);
}

export class ReleaseNoteNotFoundError extends Git2JiraError {
  constructor(noteId: string) {
    super(
      `No release note ${noteId} exists in this repository. See "git2jira release-note pending".`,
    );
  }
}

/** `<git common dir>/git2jira/release-notes/<noteId>.json`, never in the working tree. */
export class ReleaseNoteStore {
  dir(repository: RepositoryInfo): string {
    return path.join(stateDir(repository), 'release-notes');
  }

  exportDir(repository: RepositoryInfo): string {
    return path.join(stateDir(repository), 'exports');
  }

  private file(repository: RepositoryInfo, noteId: string): string {
    return path.join(this.dir(repository), `${z.uuid().parse(noteId)}.json`);
  }

  async read(repository: RepositoryInfo, noteId: string): Promise<ReleaseNoteDraft> {
    const draft = await this.readOptional(repository, noteId);
    if (!draft) throw new ReleaseNoteNotFoundError(noteId);
    return draft;
  }

  async readOptional(
    repository: RepositoryInfo,
    noteId: string,
  ): Promise<ReleaseNoteDraft | undefined> {
    if (!z.uuid().safeParse(noteId).success) return undefined;
    const file = this.file(repository, noteId);
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
    const parsed = ReleaseNoteDraftSchema.safeParse(json);
    if (!parsed.success || parsed.data.noteId !== noteId) {
      throw new CheckpointCorruptedError(file, 'invalid release note draft');
    }
    return parsed.data;
  }

  async write(repository: RepositoryInfo, draft: ReleaseNoteDraft): Promise<void> {
    const file = this.file(repository, draft.noteId);
    const validated = ReleaseNoteDraftSchema.parse(draft);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  }

  /** Writes `next` if the state machine allows it, recording the change. */
  async transition(
    repository: RepositoryInfo,
    current: ReleaseNoteDraft,
    next: ReleaseNoteDraft,
    now: Date,
    note?: string,
  ): Promise<ReleaseNoteDraft> {
    if (current.status !== next.status && !canTransitionReleaseNote(current, next.status)) {
      throw new Git2JiraError(
        `Release note ${current.noteId} cannot go from ${current.status} to ${next.status}.`,
      );
    }
    const at = now.toISOString();
    const changed = current.status !== next.status || note !== undefined;
    const updated: ReleaseNoteDraft = {
      ...next,
      events: changed
        ? [
            ...next.events,
            { at, status: next.status, ...(note ? { note: note.slice(0, 500) } : {}) },
          ]
        : next.events,
      updatedAt: at,
    };
    await this.write(repository, updated);
    return updated;
  }

  async list(repository: RepositoryInfo): Promise<ReleaseNoteDraft[]> {
    let names: string[];
    try {
      names = await readdir(this.dir(repository));
    } catch {
      return [];
    }
    const drafts: ReleaseNoteDraft[] = [];
    for (const name of names) {
      const id = /^([0-9a-f-]{36})\.json$/.exec(name)?.[1];
      if (!id) continue;
      const draft = await this.readOptional(repository, id).catch(() => undefined);
      if (draft) drafts.push(draft);
    }
    return drafts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
