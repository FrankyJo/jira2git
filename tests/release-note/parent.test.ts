import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BaseBranchResolver } from '../../src/git/base';
import { IssueKeyMismatchError } from '../../src/jira/client/errors';
import { parseIssueLookup } from '../../src/mcp/results';
import { ReleaseNoteStore } from '../../src/release-note/draft';
import { buildReleaseNoteRequest } from '../../src/release-note/prompt';
import { ReleaseNoteService } from '../../src/release-note/service';
import { GitIncrementalDiffEngine } from '../../src/snapshots/diff';
import {
  CLOUD_ID,
  MCP_SITE,
  PLACEHOLDER,
  createDeliveryHarness,
  type DeliveryHarness,
} from '../fixtures/delivery';
import { ISSUE } from '../fixtures/publication';

const EPIC = 'LSND-1000';

/** An issue lookup as Jira returns it: summary, description, and `fields.parent`. */
function lookup(
  key: string,
  fields: { summary?: string; description?: string; parent?: unknown } = {},
) {
  return [
    {
      type: 'text',
      text: JSON.stringify({ id: key === EPIC ? '10000' : '10001', key, fields }),
    },
  ];
}

const withEpic = lookup(ISSUE, {
  summary: 'Booking form',
  parent: { key: EPIC, fields: { summary: 'Room booking', issuetype: { name: 'Epic' } } },
});

describe('parent issue (epic) as the source of the goal', () => {
  let h: DeliveryHarness;
  let notes: ReleaseNoteService;

  beforeEach(async () => {
    h = await createDeliveryHarness();
    notes = new ReleaseNoteService({
      lifecycle: h.engine.lifecycle,
      locator: h.locator,
      baseResolver: new BaseBranchResolver(h.engine.runner),
      diff: new GitIncrementalDiffEngine(h.engine.runner),
      refs: h.engine.refs,
      store: h.engine.store,
      notes: new ReleaseNoteStore(),
      reports: h.drafts,
      toolVersion: '0.0.0-test',
      lockOptions: { timeoutMs: 20_000 },
    });
    await h.repo.write('src/booking.ts', 'export const MAX_DAYS = 14;\n');
    h.repo.commitAll(`${ISSUE} booking`);
  });
  afterEach(async () => {
    await h.cleanup();
  });

  async function prepare(issueLookup: unknown = withEpic) {
    const prepared = await notes.prepare({
      mode: 'mcp',
      cwd: h.repo.root,
      language: 'uk',
      site: MCP_SITE,
      siteIsPlaceholder: false,
      mcp: { server: 'atlassian', cloudId: CLOUD_ID, issueLookup },
    });
    if (prepared.status !== 'prepared')
      throw new Error(`expected prepared, got ${prepared.status}`);
    return prepared;
  }

  it('reads fields.parent from an issue lookup', () => {
    expect(parseIssueLookup(withEpic)?.parent).toEqual({
      key: EPIC,
      summary: 'Room booking',
      type: 'Epic',
    });
    expect(parseIssueLookup(lookup(ISSUE, { parent: { key: 'not a key' } }))?.parent).toBe(
      undefined,
    );
  });

  it('tells the writer about an unread parent, then gives it the parent as data', async () => {
    const prepared = await prepare();
    expect(prepared.draft.mcp?.issue.parent).toEqual({
      key: EPIC,
      summary: 'Room booking',
      type: 'Epic',
    });
    const before = buildReleaseNoteRequest(prepared.analysis, prepared.context);
    expect(before.instructions).toContain(`The issue has a parent (${EPIC}, Epic)`);
    expect(before.parts[0]).not.toContain('parentIssue');

    await notes.addParent(
      h.repo.root,
      prepared.draft.noteId,
      lookup(EPIC, {
        summary: 'Room booking',
        description:
          'Мета: прибрати конфлікти бронювань. Token: ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
      }),
    );
    const { analysis, context, draft } = await notes.analysis(h.repo.root, prepared.draft.noteId);
    expect(draft.issueContext?.parent).toMatchObject({ key: EPIC, type: 'Epic' });
    const after = buildReleaseNoteRequest(analysis, context);
    expect(after.instructions).not.toContain('has not been read yet');
    expect(after.instructions).toContain('the parent issue, usually the epic');
    const [part = ''] = after.parts;
    // Inside the fenced data block, redacted like the issue itself.
    const fenced = part.slice(part.indexOf('<repository-data'));
    expect(fenced).toContain('"parentIssue"');
    expect(fenced).toContain('прибрати конфлікти бронювань');
    expect(part).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB');
  });

  it('accepts only the parent named by the issue lookup', async () => {
    const prepared = await prepare();
    await expect(
      notes.addParent(h.repo.root, prepared.draft.noteId, lookup('LSND-9999', { summary: 'x' })),
    ).rejects.toThrow(IssueKeyMismatchError);
    await expect(
      notes.addParent(h.repo.root, prepared.draft.noteId, 'Issue not found'),
    ).rejects.toThrow(/could not be read/);
    expect((await notes.get(h.repo.root, prepared.draft.noteId)).issueContext?.parent).toBe(
      undefined,
    );
  });

  it('refuses when there is no parent, and in manual mode', async () => {
    const orphan = await prepare(lookup(ISSUE, { summary: 'Booking form' }));
    await expect(notes.addParent(h.repo.root, orphan.draft.noteId, lookup(EPIC))).rejects.toThrow(
      /names no parent issue/,
    );
    await notes.cancel(h.repo.root, orphan.draft.noteId);

    const manual = await notes.prepare({
      mode: 'manual',
      cwd: h.repo.root,
      language: 'uk',
      site: PLACEHOLDER,
      siteIsPlaceholder: true,
    });
    if (manual.status !== 'prepared') throw new Error('expected prepared');
    await expect(notes.addParent(h.repo.root, manual.draft.noteId, lookup(EPIC))).rejects.toThrow(
      /no Jira access/,
    );
  });
});
