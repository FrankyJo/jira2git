import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BaseBranchResolver } from '../../src/git/base';
import { IssueKeyMismatchError } from '../../src/jira/client/errors';
import { ReleaseNoteStore } from '../../src/release-note/draft';
import { ReleaseNoteService } from '../../src/release-note/service';
import { GitIncrementalDiffEngine } from '../../src/snapshots/diff';
import {
  ACCOUNT,
  CLOUD_ID,
  MCP_SITE,
  PLACEHOLDER,
  SETTLE,
  createDeliveryHarness,
  createdComment,
  issueLookup,
  listing,
  type DeliveryHarness,
} from '../fixtures/delivery';
import { ISSUE } from '../fixtures/publication';
import { must } from '../helpers';
import { sampleNote } from './fixtures';

/**
 * Release notes against a real Git repository. The "Claude Code session" is the test:
 * it writes the JSON and relays simulated MCP tool results. No Jira, no MCP server.
 */
describe('release notes', () => {
  let h: DeliveryHarness;
  let notes: ReleaseNoteService;
  let offset = 0;

  beforeEach(async () => {
    h = await createDeliveryHarness();
    offset = 0;
    notes = new ReleaseNoteService({
      lifecycle: h.engine.lifecycle,
      locator: h.locator,
      baseResolver: new BaseBranchResolver(h.engine.runner),
      diff: new GitIncrementalDiffEngine(h.engine.runner),
      refs: h.engine.refs,
      store: h.engine.store,
      notes: new ReleaseNoteStore(),
      reports: h.drafts,
      now: () => new Date(Date.now() + offset),
      toolVersion: '0.0.0-test',
      settleWindowMs: SETTLE,
      lockOptions: { timeoutMs: 20_000 },
    });
  });
  afterEach(async () => {
    await h.cleanup();
  });

  /** Commits the files the sample release note cites. */
  async function commitFeature() {
    await h.repo.write('src/booking/limits.ts', 'export const MAX_DAYS = 14;\n');
    await h.repo.write('src/i18n/uk.json', '{"noAccess":"Немає доступу"}\n');
    h.repo.commitAll(`${ISSUE} booking`);
  }

  async function prepare(mode: 'manual' | 'mcp' = 'manual', lookup = issueLookup()) {
    return notes.prepare({
      mode,
      cwd: h.repo.root,
      language: 'uk',
      site: mode === 'mcp' ? MCP_SITE : PLACEHOLDER,
      siteIsPlaceholder: mode !== 'mcp',
      ...(mode === 'mcp'
        ? { mcp: { server: 'atlassian', cloudId: CLOUD_ID, issueLookup: lookup } }
        : {}),
    });
  }

  async function ready(mode: 'manual' | 'mcp' = 'manual') {
    const prepared = await prepare(mode);
    if (prepared.status !== 'prepared')
      throw new Error(`expected prepared, got ${prepared.status}`);
    const draft = await notes.submit(h.repo.root, prepared.draft.noteId, sampleNote());
    return { ...draft, noteDigest: must(draft.noteDigest) };
  }

  it('covers every commit since the merge-base, never uncommitted work or report history', async () => {
    await h.repo.write('src/early.ts', 'export const early = 1;\n');
    h.repo.commitAll('early work');
    // Report #1 covered the early work; a release note still describes the whole issue.
    const report = await h.manual('uk');
    await h.confirm(report);
    const journalBefore = await h.journal();
    await commitFeature();
    await h.repo.write('src/wip.ts', 'export const wip = 1;\n');

    const prepared = await prepare();
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(prepared.changeSet.files.map((f) => f.path).sort()).toEqual([
      'src/booking/limits.ts',
      'src/early.ts',
      'src/i18n/uk.json',
    ]);
    expect(prepared.draft.base.name).toBe('main');
    expect(prepared.draft.head.commit).toBe(h.repo.head());
    expect(prepared.context.earlierReports).toEqual([
      expect.objectContaining({ sequence: 1, summary: 'Додано сторінку профілю.' }),
    ]);
    // Nothing about report checkpoints changed.
    expect(await h.journal()).toEqual(journalBefore);
  });

  it('says so when the branch has no committed work, and resumes an open release note', async () => {
    await h.repo.write('src/wip.ts', 'export const wip = 1;\n');
    expect((await prepare()).status).toBe('no-changes');
    await commitFeature();
    const first = await prepare();
    const again = await prepare();
    expect(again).toMatchObject({ status: 'pending' });
    if (first.status === 'prepared' && again.status === 'pending')
      expect(again.draft.noteId).toBe(first.draft.noteId);
  });

  it('validates against the change set and renders the text with a digest', async () => {
    await commitFeature();
    const prepared = await prepare();
    if (prepared.status !== 'prepared') throw new Error('expected prepared');
    await expect(
      notes.submit(
        h.repo.root,
        prepared.draft.noteId,
        sampleNote({
          sections: [
            {
              title: 'Розділ',
              blocks: [
                {
                  type: 'paragraph',
                  text: 'Додано ліміти.',
                  source: 'code',
                  evidence: ['src/unrelated.ts'],
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toThrow(/not in this change set/);
    const draft = await notes.submit(h.repo.root, prepared.draft.noteId, sampleNote());
    expect(draft.status).toBe('READY');
    expect(draft.rendered?.markdown).toContain(`Git2Jira release note ${draft.noteId}`);
    expect(draft.noteDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('manual: records the user attestation only for the exact digest', async () => {
    await commitFeature();
    const draft = await ready();
    await expect(notes.confirmManual(h.repo.root, draft.noteId, '0'.repeat(64))).rejects.toThrow(
      /digest differs/,
    );
    await expect(notes.publishMcp(h.repo.root, draft.noteId, draft.noteDigest)).rejects.toThrow(
      /manual release note/,
    );
    const confirmed = await notes.confirmManual(h.repo.root, draft.noteId, draft.noteDigest);
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.attestation?.noteDigest).toBe(draft.noteDigest);

    // The next release note is a new one; the delivered one is reported.
    await h.repo.write('src/more.ts', 'export const more = 1;\n');
    h.repo.commitAll('more');
    const next = await prepare();
    expect(next).toMatchObject({ status: 'prepared' });
    if (next.status === 'prepared')
      expect(next.delivered.map((d) => d.noteId)).toEqual([draft.noteId]);
  });

  describe('MCP', () => {
    it('never switches issues', async () => {
      await commitFeature();
      await expect(prepare('mcp', issueLookup('LSND-9999'))).rejects.toThrow(IssueKeyMismatchError);
    });

    it('publishes after approval and records it only from a result carrying its marker', async () => {
      await commitFeature();
      const draft = await ready('mcp');
      await expect(notes.publishMcp(h.repo.root, draft.noteId, '0'.repeat(64))).rejects.toThrow(
        /digest differs/,
      );
      const payload = await notes.publishMcp(h.repo.root, draft.noteId, draft.noteDigest);
      expect(payload).toMatchObject({
        tool: 'addOrEditJiraIssueComment',
        cloudId: CLOUD_ID,
        issueKey: ISSUE,
        marker: `Git2Jira release note ${draft.noteId}`,
      });
      expect(payload.body.markdown).toContain(payload.marker);
      expect((await notes.get(h.repo.root, draft.noteId)).status).toBe('PUBLISHING');
      // A second publish while one is in flight is refused.
      await expect(notes.publishMcp(h.repo.root, draft.noteId, draft.noteDigest)).rejects.toThrow(
        /not settled/,
      );

      const foreign = await notes.recordMcpResult(h.repo.root, draft.noteId, {
        outcome: 'tool-returned',
        toolResult: { id: '20002', body: 'Some other comment' },
      });
      expect(foreign.state).toBe('UNCERTAIN');

      const recovered = await notes.reconcileMcp(h.repo.root, draft.noteId, {
        comments: listing([createdComment('20001', payload.body.markdown)]),
        account: ACCOUNT,
      });
      expect(recovered).toMatchObject({
        state: 'RECOVERED',
        commentUrl: `${MCP_SITE.url}/browse/${ISSUE}?focusedCommentId=20001`,
      });
      // No report checkpoint is ever created for a release note.
      expect(await h.journal(MCP_SITE)).toBeUndefined();
    });

    it('marks it published from the tool result', async () => {
      await commitFeature();
      const draft = await ready('mcp');
      const payload = await notes.publishMcp(h.repo.root, draft.noteId, draft.noteDigest);
      const outcome = await notes.recordMcpResult(h.repo.root, draft.noteId, {
        outcome: 'tool-returned',
        toolResult: [
          { type: 'text', text: JSON.stringify(createdComment('20001', payload.body.markdown)) },
        ],
      });
      expect(outcome.state).toBe('PUBLISHED');
      expect(outcome.draft.publication?.evidence).toBe('tool-result');
    });

    it('does not mistake a report comment for the release note', async () => {
      await commitFeature();
      const report = await h.mcp('uk');
      const reportPayload = await h.service.publishMcp(
        h.repo.root,
        report.reportId,
        report.reportDigest,
      );
      const draft = await ready('mcp');
      await notes.publishMcp(h.repo.root, draft.noteId, draft.noteDigest);
      const outcome = await notes.recordMcpResult(h.repo.root, draft.noteId, {
        outcome: 'tool-returned',
        toolResult: createdComment('20003', reportPayload.body.markdown),
      });
      expect(outcome.state).toBe('UNCERTAIN');
    });

    it('requires a complete listing without the note before a retry, and settles absence', async () => {
      await commitFeature();
      const draft = await ready('mcp');
      await notes.publishMcp(h.repo.root, draft.noteId, draft.noteDigest);
      const unknown = await notes.recordMcpResult(h.repo.root, draft.noteId, {
        outcome: 'tool-error',
        error: { message: 'socket hang up' },
      });
      expect(unknown.state).toBe('UNCERTAIN');
      const early = await notes.reconcileMcp(h.repo.root, draft.noteId, {
        comments: listing([]),
        account: ACCOUNT,
      });
      expect(early.state).toBe('UNCERTAIN');
      offset += SETTLE + 1;
      const failed = await notes.reconcileMcp(h.repo.root, draft.noteId, {
        comments: listing([]),
        account: ACCOUNT,
      });
      expect(failed).toMatchObject({ state: 'FAILED', retryable: true });

      await expect(notes.publishMcp(h.repo.root, draft.noteId, draft.noteDigest)).rejects.toThrow(
        /--comments/,
      );
      await expect(
        notes.publishMcp(h.repo.root, draft.noteId, draft.noteDigest, {
          comments: { comments: [], startAt: 0 },
        }),
      ).rejects.toThrow(/incomplete/);
      const retry = await notes.publishMcp(h.repo.root, draft.noteId, draft.noteDigest, {
        comments: listing([]),
      });
      expect(retry.noteId).toBe(draft.noteId);
    });

    it('refuses to publish once new commits exist: they are not described', async () => {
      await commitFeature();
      const draft = await ready('mcp');
      await h.repo.write('src/later.ts', 'export const later = 1;\n');
      h.repo.commitAll('later');
      await expect(notes.publishMcp(h.repo.root, draft.noteId, draft.noteDigest)).rejects.toThrow(
        /new commits since the release note was prepared/,
      );
      expect((await notes.get(h.repo.root, draft.noteId)).status).toBe('READY');
    });
  });
});
