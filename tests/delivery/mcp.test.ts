import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCheckpoint } from '../../src/checkpoints/types';
import type { McpDraft } from '../../src/delivery/draft';
import { IssueKeyMismatchError } from '../../src/jira/client/errors';
import { ISSUE } from '../fixtures/publication';
import {
  ACCOUNT,
  CLOUD_ID,
  MCP_SITE,
  SETTLE,
  createDeliveryHarness,
  createdComment,
  issueLookup,
  listing,
  type DeliveryHarness,
} from '../fixtures/delivery';
import { must } from '../helpers';

/**
 * The "Claude Code session" here is the test itself: it produces the MCP tool
 * results that a real session would relay. No real Jira or MCP server is contacted.
 */
describe('MCP reports', () => {
  let h: DeliveryHarness;
  beforeEach(async () => {
    h = await createDeliveryHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const publish = (draft: { reportId: string; reportDigest: string }, comments?: unknown) =>
    h.service.publishMcp(h.repo.root, draft.reportId, draft.reportDigest, comments);
  const record = (reportId: string, result: unknown) =>
    h.service.recordMcpResult(h.repo.root, reportId, result);

  it('verifies the exact issue key from the MCP lookup and never switches issues', async () => {
    await h.change();
    await expect(
      h.service.prepare({
        mode: 'mcp',
        cwd: h.repo.root,
        language: 'en',
        site: MCP_SITE,
        siteIsPlaceholder: false,
        mcp: { server: 'atlassian', cloudId: CLOUD_ID, issueLookup: issueLookup('LSND-9999') },
      }),
    ).rejects.toThrow(IssueKeyMismatchError);
    await expect(
      h.service.prepare({
        mode: 'mcp',
        cwd: h.repo.root,
        language: 'en',
        site: MCP_SITE,
        siteIsPlaceholder: false,
        mcp: { server: 'atlassian', cloudId: CLOUD_ID, issueLookup: 'Issue not found' },
      }),
    ).rejects.toThrow(/could not be read/);
  });

  it('publishes after approval: payload, tool result with marker, checkpoint promoted', async () => {
    await h.change();
    const draft = await h.mcp();
    expect(draft.status).toBe('READY_FOR_REVIEW');
    expect(draft.issue).toEqual({ id: '10001', summary: 'User profile' });

    const payload = await publish(draft);
    expect(payload).toMatchObject({
      tool: 'addOrEditJiraIssueComment',
      cloudId: CLOUD_ID,
      issueKey: ISSUE,
      reportDigest: draft.reportDigest,
    });
    expect(payload.body.markdown).toContain(payload.marker);
    expect((await h.draft(draft.reportId)).status).toBe('PUBLISHING');
    expect(must(await h.journal(MCP_SITE)).records[0]?.state).toBe('publishing');

    const outcome = await record(draft.reportId, {
      outcome: 'tool-returned',
      toolResult: [
        { type: 'text', text: JSON.stringify(createdComment('20001', payload.body.markdown)) },
      ],
    });
    expect(outcome.state).toBe('PUBLISHED');
    if (outcome.state !== 'PUBLISHED') return;
    expect(outcome.commentUrl).toBe(`${MCP_SITE.url}/browse/${ISSUE}?focusedCommentId=20001`);
    const checkpoint = must(await h.journal(MCP_SITE)).records[0];
    expect(checkpoint && isCheckpoint(checkpoint)).toBe(true);
    expect(checkpoint?.publication).toMatchObject({ commentId: '20001', confirmedBy: 'mcp-tool' });
    expect(outcome.draft.publication?.evidence).toBe('tool-result');
  });

  it('refuses a digest that was not reviewed, before anything is recorded', async () => {
    await h.change();
    const draft = await h.mcp();
    await expect(h.service.publishMcp(h.repo.root, draft.reportId, '0'.repeat(64))).rejects.toThrow(
      /digest differs/,
    );
    expect(await h.journal(MCP_SITE)).toBeUndefined();
  });

  it('does not accept a tool result without this report marker as proof', async () => {
    await h.change();
    const draft = await h.mcp();
    await publish(draft);
    const outcome = await record(draft.reportId, {
      outcome: 'tool-returned',
      toolResult: { id: '20002', body: 'Some other comment' },
    });
    expect(outcome.state).toBe('UNCERTAIN');
    expect(must(await h.journal(MCP_SITE)).records[0]?.state).toBe('publishing');
  });

  it('treats an ambiguous outcome conservatively and settles it from a comment listing', async () => {
    await h.change();
    const draft = await h.mcp();
    const payload = await publish(draft);
    const outcome = await record(draft.reportId, {
      outcome: 'tool-error',
      error: { message: 'Request timed out after 30s' },
    });
    expect(outcome.state).toBe('UNCERTAIN');

    // No blind retry while uncertain, and no switch to manual (it may be in Jira).
    await expect(publish(draft)).rejects.toThrow(/not settled/);
    await expect(h.service.fallbackToManual(h.repo.root, draft.reportId)).rejects.toThrow(
      /may already be in Jira/,
    );
    await expect(h.service.cancel(h.repo.root, draft.reportId)).rejects.toThrow(/reconcile/);

    // Empty but complete listing right away: too early to conclude absence.
    const early = await h.service.reconcileMcp(h.repo.root, draft.reportId, {
      comments: listing([]),
      account: ACCOUNT,
    });
    expect(early.state).toBe('UNCERTAIN');

    // Incomplete listing (no total): nothing concluded.
    const partial = await h.service.reconcileMcp(h.repo.root, draft.reportId, {
      comments: { comments: [] },
    });
    expect(partial.state).toBe('UNCERTAIN');

    // The comment shows up, written by the signed-in account: recovered.
    const foreign = createdComment('30000', payload.body.markdown, 'someone-else');
    const ours = createdComment('30001', payload.body.markdown);
    const found = await h.service.reconcileMcp(h.repo.root, draft.reportId, {
      comments: listing([foreign, ours]),
      account: ACCOUNT,
    });
    expect(found.state).toBe('RECOVERED');
    if (found.state === 'RECOVERED') expect(found.commentId).toBe('30001');
    expect(must(await h.journal(MCP_SITE)).records[0]?.publication).toMatchObject({
      commentId: '30001',
      confirmedBy: 'mcp-tool',
    });
  });

  it('marks an ambiguous attempt FAILED only after the settle window and a complete listing', async () => {
    await h.change();
    const draft = await h.mcp();
    await publish(draft);
    await record(draft.reportId, {
      outcome: 'tool-error',
      error: { message: 'HTTP 502 Bad Gateway' },
    });
    h.advance(SETTLE + 1000);
    const settled = await h.service.reconcileMcp(h.repo.root, draft.reportId, {
      comments: listing([]),
      account: ACCOUNT,
    });
    expect(settled.state).toBe('FAILED');
    expect(must(await h.journal(MCP_SITE)).records[0]?.state).toBe('failed');

    // A retry needs a fresh listing that proves the report is still absent.
    await expect(publish(draft)).rejects.toThrow(/--comments/);
    await expect(publish(draft, { comments: { comments: [] } })).rejects.toThrow(/incomplete/);
    const retry = await publish(draft, { comments: listing([]), account: ACCOUNT });
    expect(retry.reportId).toBe(draft.reportId);
    expect(((await h.draft(draft.reportId)) as McpDraft).attempts).toHaveLength(2);
  });

  it('reports MCP reading allowed but writing denied as a definite failure, then falls back to manual', async () => {
    await h.change('src/feature.ts');
    const draft = await h.mcp();
    await publish(draft);
    const denied = await record(draft.reportId, {
      outcome: 'tool-error',
      error: { message: 'You do not have permission to add comments', status: 403 },
    });
    expect(denied.state).toBe('FAILED');
    if (denied.state === 'FAILED') expect(denied.retryable).toBe(true);
    expect(must(await h.journal(MCP_SITE)).records[0]?.state).toBe('failed');

    const manual = await h.service.fallbackToManual(h.repo.root, draft.reportId);
    expect(manual).toMatchObject({
      mode: 'manual',
      status: 'READY_TO_COPY',
      reportId: draft.reportId,
    });
    expect(manual.reportDigest).toBe(draft.reportDigest);
    const confirmed = await h.service.confirmManual(
      h.repo.root,
      draft.reportId,
      draft.reportDigest,
      {
        interactive: false,
      },
    );
    expect(confirmed.state).toBe('MANUALLY_CONFIRMED');
    expect(must(await h.journal(MCP_SITE)).records[0]?.publication?.confirmedBy).toBe(
      'user-attested',
    );
  });

  it('records a declined permission prompt as not sent', async () => {
    await h.change();
    const draft = await h.mcp();
    await publish(draft);
    const outcome = await record(draft.reportId, {
      outcome: 'not-called',
      reason: 'permission-denied',
    });
    expect(outcome.state).toBe('FAILED');
    expect(
      await h.engine.refs.resolve(await h.locator.locate(h.repo.root), draft.snapshotRef),
    ).toBe(draft.snapshot.commit);
  });

  it('rejects malformed bridge messages', async () => {
    await h.change();
    const draft = await h.mcp();
    await publish(draft);
    await expect(
      record(draft.reportId, { outcome: 'published', commentId: '1' }),
    ).rejects.toThrow();
    await expect(record(draft.reportId, { ok: true })).rejects.toThrow();
    expect((await h.draft(draft.reportId)).status).toBe('PUBLISHING');
  });

  it('falls back to manual before any attempt, keeping snapshot and text', async () => {
    await h.change();
    const draft = await h.mcp('uk');
    const manual = await h.service.fallbackToManual(h.repo.root, draft.reportId);
    expect(manual.rendered?.markdown).toContain('Звіт про реалізацію #1');
    expect(manual.snapshotRef).toBe(draft.snapshotRef);
    expect(manual.events.at(-1)?.note).toMatch(/switched from MCP/);
  });
});
