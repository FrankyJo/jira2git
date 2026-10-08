import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adfToPlainText } from '../../src/adf/text';
import { StaleReportError } from '../../src/checkpoints/errors';
import { IssueKeyMismatchError, JiraAuthenticationError } from '../../src/jira/client/errors';
import {
  ApprovalMismatchError,
  IssueNotFoundError,
  NotApprovedError,
  PublicationInProgressError,
  PublicationMismatchError,
  ReportValidationError,
} from '../../src/publication/errors';
import { REPORT_PROPERTY_KEY } from '../../src/publication/metadata';
import { MockJira, SITE_URL } from '../fixtures/mock-jira';
import {
  ISSUE,
  SETTLE_MS,
  createPublicationHarness,
  sampleReport,
  type PublicationHarness,
} from '../fixtures/publication';
import { must } from '../helpers';

describe('JiraPublicationService', () => {
  let h: PublicationHarness;

  beforeEach(async () => {
    h = await createPublicationHarness();
  });
  afterEach(() => h.cleanup());

  describe('preparation and approval', () => {
    it('verifies the issue in Jira and records a DRAFT plan', async () => {
      await h.change();
      const result = await h.service.prepare({ cwd: h.repo.root, language: 'en' });
      expect(result.status).toBe('prepared');
      if (result.status !== 'prepared') return;
      expect(result.plan).toMatchObject({
        status: 'DRAFT',
        issueKey: ISSUE,
        connection: 'work',
        sequence: 1,
      });
      expect(result.issue.summary).toBe('User profile');
      expect(result.connectionReason).toBe('default');
      expect(h.jira.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'GET /rest/api/3/issue/LSND-1234',
      ]);
    });

    it('does not switch issues: missing, hidden, or moved issues stop preparation', async () => {
      await h.change();
      h.jira.issues.delete(ISSUE);
      await expect(h.service.prepare({ cwd: h.repo.root, language: 'en' })).rejects.toThrow(
        IssueNotFoundError,
      );
      h.jira.addIssue({ id: '20002', key: 'LSND-9999', summary: 'Elsewhere' });
      h.jira.moved.set(ISSUE, 'LSND-9999');
      await expect(h.service.prepare({ cwd: h.repo.root, language: 'en' })).rejects.toThrow(
        IssueKeyMismatchError,
      );
      expect(h.repo.git('for-each-ref', 'refs/git2jira')).toBe('');
    });

    it('reports nothing when there are no changes', async () => {
      await h.ready();
      const { plan, digest } = await h.ready();
      await h.service.publish(h.repo.root, plan.reportId, digest);
      expect((await h.service.prepare({ cwd: h.repo.root, language: 'en' })).status).toBe(
        'no-changes',
      );
    });

    it('validates the structured report against the prepared issue and language', async () => {
      await h.change();
      const prepared = await h.service.prepare({ cwd: h.repo.root, language: 'en' });
      if (prepared.status !== 'prepared') throw new Error('expected changes');
      const id = prepared.plan.reportId;
      await expect(
        h.service.review(h.repo.root, id, sampleReport('en', { issueKey: 'OTHER-1' })),
      ).rejects.toThrow(/prepared for LSND-1234/);
      await expect(h.service.review(h.repo.root, id, sampleReport('uk'))).rejects.toThrow(
        /expected "en"/,
      );
      await expect(
        h.service.review(h.repo.root, id, { ...sampleReport(), extra: 1 }),
      ).rejects.toThrow(ReportValidationError);
      const huge = sampleReport('en', {
        changes: Array.from({ length: 20 }, (_, i) => ({
          kind: 'added',
          subject: `S${String(i)}`,
          description: 'x'.repeat(2000),
          files: [],
        })),
      });
      await expect(h.service.review(h.repo.root, id, huge)).rejects.toThrow(/limited to about/);
      expect((await h.plan(id)).status).toBe('DRAFT');
    });

    it('never publishes without an approval of the exact previewed digest', async () => {
      await h.change();
      const prepared = await h.service.prepare({ cwd: h.repo.root, language: 'en' });
      if (prepared.status !== 'prepared') throw new Error('expected changes');
      const id = prepared.plan.reportId;
      await expect(h.service.publish(h.repo.root, id, 'f'.repeat(64))).rejects.toThrow(
        NotApprovedError,
      );

      const first = await h.service.review(h.repo.root, id, sampleReport());
      await expect(h.service.publish(h.repo.root, id, first.reportDigest)).rejects.toThrow(
        NotApprovedError,
      );
      await expect(h.service.approve(h.repo.root, id, 'f'.repeat(64))).rejects.toThrow(
        ApprovalMismatchError,
      );
      await h.service.approve(h.repo.root, id, first.reportDigest);

      // Changing the report after approval clears the approval.
      const second = await h.service.review(
        h.repo.root,
        id,
        sampleReport('en', { summary: 'Different text.' }),
      );
      expect(second.reportDigest).not.toBe(first.reportDigest);
      expect((await h.plan(id)).status).toBe('READY_FOR_REVIEW');
      await expect(h.service.publish(h.repo.root, id, first.reportDigest)).rejects.toThrow(
        NotApprovedError,
      );
      await h.service.approve(h.repo.root, id, second.reportDigest);
      await expect(h.service.publish(h.repo.root, id, first.reportDigest)).rejects.toThrow(
        ApprovalMismatchError,
      );
      expect(h.posts()).toBe(0);
    });

    it('cancels an approved report without moving the baseline', async () => {
      const { plan } = await h.ready();
      await h.service.cancel(h.repo.root, plan.reportId);
      await expect(h.plan(plan.reportId)).rejects.toThrow(/No prepared report/);
      expect(h.repo.git('for-each-ref', 'refs/git2jira')).toBe('');
    });
  });

  describe('publishing', () => {
    it('publishes once, verifies the comment, stores metadata, and promotes the checkpoint', async () => {
      const { plan, digest } = await h.ready();
      const outcome = await h.service.publish(h.repo.root, plan.reportId, digest);
      expect(outcome.state).toBe('PUBLISHED');
      if (outcome.state !== 'PUBLISHED') return;
      const [comment] = h.comments();
      expect(h.comments()).toHaveLength(1);
      expect(outcome.commentId).toBe(comment?.id);
      expect(outcome.commentUrl).toBe(
        `${SITE_URL}/browse/${ISSUE}?focusedCommentId=${comment?.id ?? ''}`,
      );
      expect(outcome.propertyStored).toBe(true);
      expect(outcome.checkpoint?.state).toBe('published');
      expect(adfToPlainText(comment?.body)).toContain(`Git2Jira report ${plan.reportId} · #1`);
      expect(h.jira.properties.get(comment?.id ?? '')?.get(REPORT_PROPERTY_KEY)).toMatchObject({
        reportId: plan.reportId,
        sequence: 1,
        issueKey: ISSUE,
        targetTree: plan.snapshot.tree,
        reportDigest: digest,
      });
      expect((await h.plan(plan.reportId)).status).toBe('PUBLISHED');
      expect((await h.journal())?.records[0]).toMatchObject({
        state: 'published',
        publication: { commentId: comment?.id },
      });

      // Publishing the same plan again reports the existing comment instead of posting.
      const again = await h.service.publish(h.repo.root, plan.reportId, digest);
      expect(again).toMatchObject({ state: 'PUBLISHED', commentId: comment?.id });
      expect(h.posts()).toBe(1);

      // The next report starts from this checkpoint.
      const next = await h.ready();
      expect(next.plan).toMatchObject({
        sequence: 2,
        baseline: { kind: 'checkpoint', reportId: plan.reportId },
      });
    });

    it('publishes a Ukrainian report with Ukrainian headings', async () => {
      const { plan, digest } = await h.ready('uk');
      await h.service.publish(h.repo.root, plan.reportId, digest);
      const text = adfToPlainText(h.comments()[0]?.body);
      expect(text).toContain('Звіт про реалізацію #1');
      expect(text).toContain('Створені файли');
      expect(text).toMatch(/src\/file\d+\.ts/);
    });

    it('lets only one of two concurrent publishes post', async () => {
      const { plan, digest } = await h.ready();
      const results = await Promise.all([
        h.service.publish(h.repo.root, plan.reportId, digest),
        h.service.publish(h.repo.root, plan.reportId, digest),
      ]);
      expect(results.map((r) => r.state)).toEqual(['PUBLISHED', 'PUBLISHED']);
      expect(h.posts()).toBe(1);
    });

    it('refuses a report whose baseline was superseded', async () => {
      const a = await h.ready();
      const b = await h.ready();
      await h.service.publish(h.repo.root, a.plan.reportId, a.digest);
      await expect(h.service.publish(h.repo.root, b.plan.reportId, b.digest)).rejects.toThrow(
        StaleReportError,
      );
      expect(h.posts()).toBe(1);
    });

    it('checks site, issue, snapshot, and changes before sending anything', async () => {
      const { plan, digest } = await h.ready();
      const repository = await h.locator.locate(h.repo.root);

      // Tampered change list.
      await h.plans.write(repository, {
        ...plan,
        files: [...plan.files, { status: 'added', path: 'ghost.ts' }],
      });
      await expect(h.service.publish(h.repo.root, plan.reportId, digest)).rejects.toThrow(
        /changed files differ/,
      );
      // Tampered comment body.
      await h.plans.write(repository, {
        ...plan,
        document: { type: 'doc', version: 1, content: [{ type: 'rule' }] },
      });
      await expect(h.service.publish(h.repo.root, plan.reportId, digest)).rejects.toThrow(
        ApprovalMismatchError,
      );
      await h.plans.write(repository, plan);

      // The issue key now resolves to a different issue.
      h.jira.issues.set(ISSUE, { id: '99999', key: ISSUE, summary: 'Recreated' });
      await expect(h.service.publish(h.repo.root, plan.reportId, digest)).rejects.toThrow(
        /no longer the issue/,
      );
      h.jira.issues.set(ISSUE, { id: '10001', key: ISSUE, summary: 'User profile' });

      // The connection was re-pointed to another site.
      const config = await h.configStore.readGlobal();
      const work = config.jira?.connections?.work;
      await h.configStore.writeGlobal({
        jira: {
          ...config.jira,
          connections: { work: { ...must(work), siteUrl: 'https://other.atlassian.net' } },
        },
      });
      await expect(h.service.publish(h.repo.root, plan.reportId, digest)).rejects.toThrow(
        PublicationMismatchError,
      );
      await h.configStore.writeGlobal(config);

      // The snapshot ref disappeared.
      h.repo.git('update-ref', '-d', plan.snapshotRef);
      await expect(h.service.publish(h.repo.root, plan.reportId, digest)).rejects.toThrow(
        /no longer recorded/,
      );
      expect(h.posts()).toBe(0);
      expect(await h.journal()).toBeUndefined();
    });
  });

  describe('failures', () => {
    it('keeps a prepared report when authentication fails, and publishes it after a new login', async () => {
      const { plan, digest } = await h.ready();
      h.dev.token = 'rotated-token';
      await expect(h.service.publish(h.repo.root, plan.reportId, digest)).rejects.toThrow(
        JiraAuthenticationError,
      );
      expect((await h.plan(plan.reportId)).status).toBe('APPROVED');
      expect(await h.journal()).toBeUndefined();

      await h.manager.login({
        name: 'work',
        siteUrl: SITE_URL,
        email: h.dev.email,
        token: 'rotated-token',
        tokenType: 'auto',
      });
      expect((await h.service.publish(h.repo.root, plan.reportId, digest)).state).toBe('PUBLISHED');
      expect(h.posts()).toBe(1);
    });

    it('marks a definite rejection FAILED and retries the same report safely', async () => {
      const { plan, digest } = await h.ready();
      h.jira.issue(ISSUE).commenters = ['someone-else'];
      const failed = await h.service.publish(h.repo.root, plan.reportId, digest);
      expect(failed).toMatchObject({ state: 'FAILED', retryable: true });
      expect((await h.journal())?.records[0]?.state).toBe('failed');
      expect(h.repo.git('rev-parse', plan.snapshotRef).trim()).toBe(plan.snapshot.commit);

      delete h.jira.issue(ISSUE).commenters;
      const retried = await h.service.publish(h.repo.root, plan.reportId, digest);
      expect(retried.state).toBe('PUBLISHED');
      expect(h.posts()).toBe(2);
      expect(h.comments()).toHaveLength(1);
      expect((await h.plan(plan.reportId)).attempts.map((a) => a.result)).toEqual([
        'failed',
        'published',
      ]);
    });

    it('does not retry comment creation automatically on rate limiting', async () => {
      const { plan, digest } = await h.ready();
      h.jira.fault('POST', /\/comment$/, { status: 429, headers: { 'Retry-After': '1' } });
      expect(await h.service.publish(h.repo.root, plan.reportId, digest)).toMatchObject({
        state: 'FAILED',
        retryable: true,
      });
      expect(h.posts()).toBe(1);
      expect((await h.service.publish(h.repo.root, plan.reportId, digest)).state).toBe('PUBLISHED');
    });

    it('does not offer a retry for a comment Jira rejects as invalid', async () => {
      const { plan, digest } = await h.ready();
      h.jira.fault('POST', /\/comment$/, { status: 400, body: { errors: { comment: 'invalid' } } });
      expect(await h.service.publish(h.repo.root, plan.reportId, digest)).toMatchObject({
        state: 'FAILED',
        retryable: false,
      });
      await expect(h.service.publish(h.repo.root, plan.reportId, digest)).rejects.toThrow(
        /failed permanently/,
      );
      expect(h.repo.git('for-each-ref', 'refs/git2jira')).toBe('');
    });

    it('recovers when Jira created the comment but the response was lost', async () => {
      const { plan, digest } = await h.ready();
      h.jira.fault('POST', /\/comment$/, { kind: 'process-then-drop' });
      const outcome = await h.service.publish(h.repo.root, plan.reportId, digest);
      expect(outcome.state).toBe('RECOVERED');
      expect(h.posts()).toBe(1);
      expect(h.comments()).toHaveLength(1);
      expect((await h.journal())?.records[0]?.state).toBe('published');
    });

    it('recovers after a timeout and after a gateway error once the comment exists', async () => {
      const { plan, digest } = await h.ready();
      h.jira.fault('POST', /\/comment$/, { kind: 'process-then-hang' });
      expect((await h.service.publish(h.repo.root, plan.reportId, digest)).state).toBe('RECOVERED');

      const second = await h.ready();
      h.jira.fault('POST', /\/comment$/, { kind: 'process-then-status', status: 504 });
      expect(
        (await h.service.publish(h.repo.root, second.plan.reportId, second.digest)).state,
      ).toBe('RECOVERED');
      expect(h.posts()).toBe(2);
      expect(h.comments()).toHaveLength(2);
    });

    it('stays UNCERTAIN instead of re-posting, and settles only after the settle window', async () => {
      const { plan, digest } = await h.ready();
      h.jira.fault('POST', /\/comment$/, { kind: 'hang' });
      const outcome = await h.service.publish(h.repo.root, plan.reportId, digest);
      expect(outcome.state).toBe('UNCERTAIN');
      await expect(h.service.publish(h.repo.root, plan.reportId, digest)).rejects.toThrow(
        PublicationInProgressError,
      );
      await expect(h.service.prepare({ cwd: h.repo.root, language: 'en' })).rejects.toThrow(
        /recover/,
      );

      const early = await h.service.recover({ cwd: h.repo.root });
      expect(early.actions).toContainEqual(expect.objectContaining({ kind: 'still-uncertain' }));
      expect((await h.plan(plan.reportId)).status).toBe('UNCERTAIN');

      h.advance(SETTLE_MS + 1000);
      const settled = await h.service.recover({ cwd: h.repo.root });
      expect(settled.actions).toContainEqual({
        kind: 'not-published',
        reportId: plan.reportId,
        sequence: 1,
      });
      expect((await h.plan(plan.reportId)).status).toBe('FAILED');

      expect((await h.service.publish(h.repo.root, plan.reportId, digest)).state).toBe('PUBLISHED');
      expect(h.posts()).toBe(2);
      expect(h.comments()).toHaveLength(1);
    });

    it('does not conclude "not published" when Jira comments cannot all be read', async () => {
      const { plan, digest } = await h.ready();
      for (let i = 0; i < 4; i++)
        h.jira.insertComment(ISSUE, h.dev, { type: 'doc', version: 1, content: [] });
      h.jira.fault('POST', /\/comment$/, { kind: 'hang' });
      await h.service.publish(h.repo.root, plan.reportId, digest);
      h.advance(SETTLE_MS + 1000);
      h.jira.fault('GET', /\/comment$/, { status: 500 }, 100);
      const summary = await h.service.recover({ cwd: h.repo.root });
      expect(summary.actions).toContainEqual(expect.objectContaining({ kind: 'still-uncertain' }));
      expect(summary.remoteError).toBeDefined();
      expect((await h.journal())?.records[0]?.state).toBe('publishing');
    });

    it('ignores report markers in comments written by other accounts', async () => {
      const { plan, digest } = await h.ready();
      h.jira.fault('POST', /\/comment$/, { kind: 'hang' });
      await h.service.publish(h.repo.root, plan.reportId, digest);
      const mallory = h.jira.addAccount({
        email: 'm@example.com',
        token: 't',
        accountId: 'acc-m',
        displayName: 'M',
      });
      h.jira.insertComment(ISSUE, mallory, (await h.plan(plan.reportId)).document);
      h.advance(SETTLE_MS + 1000);
      const summary = await h.service.recover({ cwd: h.repo.root });
      expect(summary.actions).toContainEqual({
        kind: 'not-published',
        reportId: plan.reportId,
        sequence: 1,
      });
    });
  });

  describe('recovery', () => {
    async function crashDuringPublish(createComment: boolean) {
      const { plan, digest } = await h.ready();
      const repository = await h.locator.locate(h.repo.root);
      await h.engine.lifecycle.beginPublication(await h.candidate(plan), digest);
      await h.plans.write(repository, {
        ...plan,
        status: 'PUBLISHING',
        attempts: [{ startedAt: new Date().toISOString() }],
      });
      // Pad the issue so the lookup needs several pages.
      for (let i = 0; i < 5; i++)
        h.jira.insertComment(ISSUE, h.dev, { type: 'doc', version: 1, content: [] });
      if (createComment) h.jira.insertComment(ISSUE, h.dev, plan.document);
      return { plan, digest };
    }

    it('finds a comment created before a crash, records it, and restores its metadata', async () => {
      const { plan } = await crashDuringPublish(true);
      const summary = await h.service.recover({ cwd: h.repo.root });
      const commentId = h.comments().at(-1)?.id ?? '';
      expect(summary.actions).toContainEqual(
        expect.objectContaining({ kind: 'recovered', reportId: plan.reportId, commentId }),
      );
      expect((await h.plan(plan.reportId)).status).toBe('RECOVERED');
      expect((await h.journal())?.records[0]?.state).toBe('published');
      expect(h.jira.properties.get(commentId)?.get(REPORT_PROPERTY_KEY)).toMatchObject({
        reportId: plan.reportId,
      });
      expect(h.posts()).toBe(0);
    });

    it('marks a crash before the request FAILED once settled, then publishes it', async () => {
      const { plan, digest } = await crashDuringPublish(false);
      h.advance(SETTLE_MS + 1000);
      await h.service.recover({ cwd: h.repo.root });
      expect((await h.plan(plan.reportId)).status).toBe('FAILED');
      expect((await h.service.publish(h.repo.root, plan.reportId, digest)).state).toBe('PUBLISHED');
      expect(h.posts()).toBe(1);
    });

    it('restores the comment property when storing it failed', async () => {
      const { plan, digest } = await h.ready();
      h.jira.ignorePropertiesOnCreate = true;
      h.jira.failPropertyWrites = true;
      const outcome = await h.service.publish(h.repo.root, plan.reportId, digest);
      expect(outcome).toMatchObject({ state: 'PUBLISHED', propertyStored: false });

      h.jira.failPropertyWrites = false;
      const summary = await h.service.recover({ cwd: h.repo.root });
      expect(summary.actions).toContainEqual(
        expect.objectContaining({ kind: 'property-restored', reportId: plan.reportId }),
      );
      expect((await h.plan(plan.reportId)).publication?.propertyStored).toBe(true);
      expect((await h.service.recover({ cwd: h.repo.root })).actions).toEqual([]);
    });

    it('promotes a checkpoint that was not written before a crash', async () => {
      const { plan, digest } = await h.ready();
      await h.service.publish(h.repo.root, plan.reportId, digest);
      const repository = await h.locator.locate(h.repo.root);
      const journal = must(await h.journal());
      const record = must(journal.records[0]);
      h.repo.git('update-ref', '-d', must(record.checkpointRef));
      const { checkpointRef: _r, checkpointCommit: _c, ...unpromoted } = record;
      await h.engine.store.write(repository, {
        ...journal,
        records: [{ ...unpromoted, state: 'confirmed' }],
      });

      const summary = await h.service.recover({ cwd: h.repo.root });
      expect(summary.actions).toContainEqual({ kind: 'promoted', reportId: plan.reportId });
      expect((await h.journal())?.records[0]?.state).toBe('published');
      expect((await h.ready()).plan.baseline).toMatchObject({
        kind: 'checkpoint',
        reportId: plan.reportId,
      });
    });

    it('reports duplicate comments for one report id and comments unknown locally', async () => {
      const { plan, digest } = await h.ready();
      await h.service.publish(h.repo.root, plan.reportId, digest);
      const original = must(h.comments()[0]);
      const copy = h.jira.insertComment(ISSUE, h.dev, original.body);
      const foreignId = '0e0e0e0e-1111-4222-8333-444444444444';
      h.jira.insertComment(ISSUE, h.dev, {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: `Git2Jira report ${foreignId} · #7 · x` }],
          },
        ],
      });
      const summary = await h.service.recover({ cwd: h.repo.root });
      expect(summary.actions).toContainEqual({
        kind: 'duplicate',
        reportId: plan.reportId,
        commentIds: [original.id, copy.id],
      });
      expect(summary.actions).toContainEqual(
        expect.objectContaining({ kind: 'remote-only', reportId: foreignId, sequence: 7 }),
      );
    });

    it('applies local repairs even when Jira cannot be reached', async () => {
      await crashDuringPublish(true);
      await h.jira.close();
      h.jira = await MockJira.start();
      const summary = await h.service.recover({ cwd: h.repo.root });
      expect(summary.remoteError).toBeDefined();
      expect(summary.actions).toContainEqual(expect.objectContaining({ kind: 'still-uncertain' }));
    });
  });

  describe('history', () => {
    it('lists published reports and cross-checks them with Jira', async () => {
      const a = await h.ready();
      await h.service.publish(h.repo.root, a.plan.reportId, a.digest);
      const b = await h.ready();
      await h.service.publish(h.repo.root, b.plan.reportId, b.digest);
      const open = await h.ready();

      const view = await h.service.history({ cwd: h.repo.root }, { remote: true });
      expect(view.entries.map((e) => [e.record.sequence, e.record.state, e.inJira])).toEqual([
        [1, 'published', true],
        [2, 'published', true],
      ]);
      expect(view.openPlans.map((p) => p.reportId)).toEqual([open.plan.reportId]);
      expect(view.remote?.reports.map((r) => r.source)).toEqual(['both', 'both']);

      h.jira.comments.get(ISSUE)?.shift();
      const after = await h.service.history({ cwd: h.repo.root }, { remote: true });
      expect(after.entries[0]?.inJira).toBe(false);
      const offline = await h.service.history({ cwd: h.repo.root }, { remote: false });
      expect(offline.entries[0]?.inJira).toBeUndefined();
    });
  });

  it('never writes the API token to plans, journals, refs, or configuration', async () => {
    const { plan, digest } = await h.ready();
    await h.service.publish(h.repo.root, plan.reportId, digest);
    const files = [
      h.configStore.globalPath,
      ...(await listFiles(path.join(h.repo.root, '.git', 'git2jira'))),
    ];
    for (const file of files) expect(await readFile(file, 'utf8'), file).not.toContain(h.dev.token);
    expect(h.repo.git('log', '--all', '--format=%B')).not.toContain(h.dev.token);
    for (const request of h.jira.requests)
      expect(JSON.stringify(request.body ?? '')).not.toContain(h.dev.token);
  });
});

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name);
    if ((await stat(full)).isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}
