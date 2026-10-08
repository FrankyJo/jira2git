import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCheckpoint } from '../../src/checkpoints/types';
import type { ManualDraft } from '../../src/delivery/draft';
import { draftDigest } from '../../src/delivery/service';
import { createPublicationHarness, ISSUE, sampleReport } from '../fixtures/publication';
import { PLACEHOLDER, createDeliveryHarness, type DeliveryHarness } from '../fixtures/delivery';
import { must } from '../helpers';

describe('manual reports', () => {
  let h: DeliveryHarness;
  beforeEach(async () => {
    h = await createDeliveryHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('works without any Jira authentication, connection, or network', async () => {
    // The harness has no Jira client, no credential store, and no MCP: only Git.
    await h.change();
    const draft = await h.manual();
    expect(draft.status).toBe('READY_TO_COPY');
    expect(draft.site.id).toBe(PLACEHOLDER.id);
    expect(draft.siteIsPlaceholder).toBe(true);
    const outcome = await h.confirm(draft);
    expect(outcome.state).toBe('MANUALLY_CONFIRMED');
  });

  it('creates the first report from the merge base and confirms it as user-attested', async () => {
    await h.change('src/first.ts');
    const draft = await h.manual();
    expect(draft.sequence).toBe(1);
    expect(draft.baseline.kind).toBe('merge-base');
    expect(draft.files.map((f) => f.path)).toEqual(['src/first.ts']);

    const outcome = await h.confirm(draft);
    expect(outcome.state).toBe('MANUALLY_CONFIRMED');
    const record = must((await h.journal())?.records[0]);
    expect(isCheckpoint(record)).toBe(true);
    expect(record.publication?.confirmedBy).toBe('user-attested');
    expect(record.publication?.commentId).toBeUndefined();
    const confirmed = (await h.draft(draft.reportId)) as ManualDraft;
    expect(confirmed.attestation).toMatchObject({
      method: 'user-attested',
      reportDigest: draft.reportDigest,
    });
  });

  it('makes the second report incremental: only changes since the confirmed one', async () => {
    await h.change('src/first.ts');
    await h.confirm(await h.manual());
    await h.change('src/second.ts');
    const second = await h.manual();
    expect(second.sequence).toBe(2);
    expect(second.baseline).toMatchObject({ kind: 'checkpoint', sequence: 1 });
    expect(second.files.map((f) => f.path)).toEqual(['src/second.ts']);
    expect(second.rendered?.markdown).toContain('Implementation Report #2');
  });

  it('does not move the checkpoint when the report is only copied or exported', async () => {
    await h.change();
    const draft = await h.manual();
    const presented = await h.service.markPresented(h.repo.root, draft.reportId, 'clipboard');
    expect(presented.status).toBe('AWAITING_MANUAL_CONFIRMATION');
    await h.service.markPresented(h.repo.root, draft.reportId, 'file', '/tmp/x.md');
    expect(await h.journal()).toBeUndefined();

    // The next run offers the pending report instead of creating another one.
    await h.change();
    const again = await h.service.prepare({
      mode: 'manual',
      cwd: h.repo.root,
      language: 'en',
      site: PLACEHOLDER,
      siteIsPlaceholder: true,
    });
    expect(again.status).toBe('pending');
    if (again.status === 'pending') expect(again.draft.reportId).toBe(draft.reportId);
  });

  it('requires the exact digest that was displayed', async () => {
    await h.change();
    const draft = await h.manual();
    await expect(
      h.service.confirmManual(h.repo.root, draft.reportId, 'f'.repeat(64), { interactive: false }),
    ).rejects.toThrow(/digest differs/);
    expect(await h.journal()).toBeUndefined();

    // Changing the text after copying invalidates the old digest and returns to READY_TO_COPY.
    await h.service.markPresented(h.repo.root, draft.reportId, 'clipboard');
    const edited = await h.service.submit(
      h.repo.root,
      draft.reportId,
      sampleReport('en', { summary: 'Something else.' }),
    );
    expect(edited.status).toBe('READY_TO_COPY');
    await expect(h.confirm(draft)).rejects.toThrow(/digest differs/);
  });

  it('keeps the snapshot of a report that waits for days through recovery', async () => {
    await h.change();
    const draft = await h.manual();
    h.advance(3 * 24 * 60 * 60 * 1000);
    const repository = await h.locator.locate(h.repo.root);
    const report = await h.engine.lifecycle.recover({
      repository,
      site: PLACEHOLDER,
      issueKey: draft.issueKey,
    });
    expect(report.removedCandidates).toEqual([]);
    expect(await h.engine.refs.resolve(repository, draft.snapshotRef)).toBe(draft.snapshot.commit);
    expect((await h.confirm(draft)).state).toBe('MANUALLY_CONFIRMED');
  });

  it('cancels a pending report without moving the checkpoint', async () => {
    await h.change('src/a.ts');
    const draft = await h.manual();
    const cancelled = await h.service.cancel(h.repo.root, draft.reportId);
    expect(cancelled.status).toBe('CANCELLED');
    const repository = await h.locator.locate(h.repo.root);
    expect(await h.engine.refs.resolve(repository, draft.snapshotRef)).toBeUndefined();
    await expect(h.confirm(draft)).rejects.toThrow(/cannot be confirmed/);

    const next = await h.manual();
    expect(next.sequence).toBe(1);
    expect(next.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('keeps changes made after generation for the next report', async () => {
    await h.change('src/before.ts');
    const draft = await h.manual();
    await h.change('src/after.ts');
    await h.change('src/before.ts');
    await h.confirm(draft);

    const checkpoint = must((await h.journal())?.records[0]);
    expect(checkpoint.snapshot.tree).toBe(draft.snapshot.tree);
    const next = await h.manual();
    expect(next.files.map((f) => `${f.status}:${f.path}`).sort()).toEqual([
      'added:src/after.ts',
      'modified:src/before.ts',
    ]);
  });

  it('finishes an interrupted confirmation during recovery (pending report recovery)', async () => {
    await h.change();
    const draft = await h.manual();
    // Simulate a crash right after the journal entry: attestation + begin, no promotion.
    const repository = await h.locator.locate(h.repo.root);
    await h.drafts.write(repository, {
      ...draft,
      attestation: {
        reportDigest: draft.reportDigest,
        attestedAt: new Date().toISOString(),
        method: 'user-attested',
        interactive: false,
      },
    });
    await h.engine.lifecycle.beginPublication(
      {
        reportId: draft.reportId,
        site: draft.site,
        snapshotRef: draft.snapshotRef,
        snapshot: draft.snapshot,
        baseline: draft.baseline,
        context: { repository, issueKey: draft.issueKey, branch: draft.branch },
      },
      draft.reportDigest,
    );

    const actions = await h.service.recover(h.repo.root);
    expect(actions).toEqual([
      expect.objectContaining({ reportId: draft.reportId, action: 'confirmed' }),
    ]);
    expect((await h.draft(draft.reportId)).status).toBe('MANUALLY_CONFIRMED');
    expect(isCheckpoint(must((await h.journal())?.records[0]))).toBe(true);
  });

  it('does not treat a journal entry without the user attestation as published', async () => {
    await h.change();
    const draft = await h.manual();
    const repository = await h.locator.locate(h.repo.root);
    await h.engine.lifecycle.beginPublication(
      {
        reportId: draft.reportId,
        site: draft.site,
        snapshotRef: draft.snapshotRef,
        snapshot: draft.snapshot,
        baseline: draft.baseline,
        context: { repository, issueKey: draft.issueKey, branch: draft.branch },
      },
      draft.reportDigest,
    );
    await h.service.recover(h.repo.root);
    expect((await h.journal())?.records[0]?.state).toBe('failed');
    expect((await h.draft(draft.reportId)).status).toBe('READY_TO_COPY');
    // The user can still confirm it afterwards.
    expect((await h.confirm(draft)).state).toBe('MANUALLY_CONFIRMED');
  });

  it('flags a pending report whose baseline moved and lets the user cancel it', async () => {
    await h.change('src/one.ts');
    const first = await h.manual();
    // Another report on the same lineage gets confirmed first (e.g. from another tool).
    const repository = await h.locator.locate(h.repo.root);
    const other = await h.engine.lifecycle.prepare({ cwd: h.repo.root, site: PLACEHOLDER });
    expect(other.status).toBe('prepared');
    if (other.status !== 'prepared') return;
    await h.engine.lifecycle.beginPublication(other.report, 'b'.repeat(64));
    await h.engine.lifecycle.confirmPublication(
      { repository, site: PLACEHOLDER, issueKey: other.report.context.issueKey },
      other.report.reportId,
      { publishedAt: new Date().toISOString(), confirmedBy: 'user-attested' },
    );

    const outcome = await h.confirm(first);
    expect(outcome.state).toBe('RECOVERY_REQUIRED');
    const flagged = (await h.draft(first.reportId)) as ManualDraft;
    expect(flagged.attestation).toBeUndefined();
    expect(flagged.recovery?.reason).toMatch(/another report/);
    expect((await h.service.cancel(h.repo.root, first.reportId)).status).toBe('CANCELLED');
  });

  it('withdraws an accidental confirmation and restores the previous checkpoint', async () => {
    await h.change('src/one.ts');
    await h.confirm(await h.manual());
    await h.change('src/two.ts');
    const second = await h.manual();
    await h.confirm(second);
    const repository = await h.locator.locate(h.repo.root);
    const checkpoint = must((await h.journal())?.records[1]?.checkpointRef);

    const reopened = await h.service.revokeManual(h.repo.root, second.reportId, 'not pasted');
    expect(reopened.status).toBe('AWAITING_MANUAL_CONFIRMATION');
    expect(reopened.attestation).toBeUndefined();
    const journal = must(await h.journal());
    expect(journal.records[1]).toMatchObject({
      state: 'revoked',
      revocation: { reason: 'not pasted' },
    });
    expect(await h.engine.refs.resolve(repository, checkpoint)).toBeUndefined();
    expect(await h.engine.refs.resolve(repository, second.snapshotRef)).toBe(
      second.snapshot.commit,
    );

    // The next analysis starts from report #1 again; the withdrawn report can be confirmed later.
    const analysis = await h.engine.lifecycle.analyze({ cwd: h.repo.root, site: PLACEHOLDER });
    expect(analysis.baseline).toMatchObject({ kind: 'checkpoint', sequence: 1 });
    expect((await h.confirm(second)).state).toBe('MANUALLY_CONFIRMED');
    expect(must(await h.journal()).records[1]?.state).toBe('published');
  });

  it('only withdraws the latest, user-attested checkpoint', async () => {
    await h.change('src/one.ts');
    const first = await h.manual();
    await h.confirm(first);
    await h.change('src/two.ts');
    await h.confirm(await h.manual());
    await expect(h.service.revokeManual(h.repo.root, first.reportId, 'x')).rejects.toThrow(
      /latest checkpoint/,
    );
  });

  it('renders the report in English', async () => {
    await h.change('src/UserProfileView.vue');
    const draft = await h.manual('en');
    const markdown = must(draft.rendered?.markdown);
    for (const heading of [
      'Summary',
      'Completed Work',
      'Created Files',
      'Testing and Validation',
    ]) {
      expect(markdown).toContain(`### ${heading}`);
    }
    expect(markdown).toContain('- `src/UserProfileView.vue`');
    expect(markdown).toContain(`Git2Jira report ${draft.reportId} · #1`);
    expect(draft.rendered?.text).toContain('Implementation Report #1');
    expect(draftDigest(draft, must(draft.rendered))).toBe(draft.reportDigest);
  });

  it('renders the report in Ukrainian and rejects a report in another language', async () => {
    await h.change();
    const draft = await h.manual('uk');
    const markdown = must(draft.rendered?.markdown);
    expect(markdown).toContain('## Звіт про реалізацію #1');
    expect(markdown).toContain('### Підсумок');
    expect(markdown).toContain('### Створені файли');
    expect(markdown).toContain('Додано сторінку профілю.');

    await expect(h.service.submit(h.repo.root, draft.reportId, sampleReport('en'))).rejects.toThrow(
      /expected "uk"/,
    );
  });
});

describe('manual and API-token modes on one site', () => {
  it('lets the API-token publisher continue from a manual checkpoint', async () => {
    const api = await createPublicationHarness();
    try {
      const site = (await api.manager.get('work')).site;
      const h = await createDeliveryHarness({ repo: api.repo, engine: api.engine });
      await api.change();
      const manual = await h.manual('en', site);
      expect(manual.siteIsPlaceholder).toBe(false);
      await h.confirm(manual);

      const { plan, digest } = await api.ready();
      expect(plan.sequence).toBe(2);
      expect(plan.baseline).toMatchObject({ kind: 'checkpoint', reportId: manual.reportId });
      const outcome = await api.service.publish(api.repo.root, plan.reportId, digest);
      expect(outcome.state).toBe('PUBLISHED');
      expect(api.posts()).toBe(1);

      // Recovery and history understand a checkpoint without a comment id.
      const summary = await api.service.recover({ cwd: api.repo.root });
      expect(summary.actions.filter((a) => a.kind === 'missing-in-jira')).toEqual([]);
      const history = await api.service.history({ cwd: api.repo.root }, { remote: true });
      expect(history.entries.map((e) => e.record.publication?.confirmedBy)).toEqual([
        'user-attested',
        'jira-api',
      ]);
      expect(history.entries[0]?.commentUrl).toBeUndefined();
    } finally {
      await api.cleanup();
    }
  });

  it('cannot withdraw an API-confirmed checkpoint', async () => {
    const api = await createPublicationHarness();
    try {
      const { plan, digest } = await api.ready();
      await api.service.publish(api.repo.root, plan.reportId, digest);
      const repository = await api.locator.locate(api.repo.root);
      await expect(
        api.engine.lifecycle.revokeCheckpoint(
          { repository, site: plan.site, issueKey: ISSUE as never },
          plan.reportId,
          'x',
        ),
      ).rejects.toThrow(/user-attested/);
    } finally {
      await api.cleanup();
    }
  });
});
