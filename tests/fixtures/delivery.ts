import { StructuredReportRenderer } from '../../src/adf/render';
import { jiraSiteFromUrl } from '../../src/checkpoints/site';
import type { JiraSite } from '../../src/checkpoints/types';
import { DraftStore, type Draft, type ManualDraft, type McpDraft } from '../../src/delivery/draft';
import { ReportDeliveryService, openDraftRefs } from '../../src/delivery/service';
import { PLACEHOLDER_SITE_URL } from '../../src/delivery/site';
import { GitRepositoryLocatorImpl } from '../../src/git/repository';
import { StaticLabelCatalog } from '../../src/localization/catalog';
import type { Language } from '../../src/localization/languages';
import { GitIncrementalDiffEngine } from '../../src/snapshots/diff';
import { GitRepo, createEngine, type Engine } from './git-repo';
import { ISSUE, sampleReport } from './publication';

export const MCP_SITE: JiraSite = jiraSiteFromUrl('https://example.atlassian.net');
export const PLACEHOLDER: JiraSite = jiraSiteFromUrl(PLACEHOLDER_SITE_URL);
export const CLOUD_ID = '11111111-2222-3333-4444-555555555555';
export const SETTLE = 60_000;

/**
 * A Git repository and the delivery service, with no Jira, no credentials, and no
 * network. Optionally shares an engine (and so a lineage store) with other services.
 */
export async function createDeliveryHarness(options: { repo?: GitRepo; engine?: Engine } = {}) {
  const repo = options.repo ?? (await GitRepo.create({ branch: `feature/${ISSUE}-profile` }));
  let offset = 0;
  const now = () => new Date(Date.now() + offset);
  const drafts = new DraftStore();
  const engine =
    options.engine ??
    createEngine(repo, undefined, now, (repository) => openDraftRefs(drafts, repository));
  const locator = new GitRepositoryLocatorImpl(engine.runner);
  const service = new ReportDeliveryService({
    lifecycle: engine.lifecycle,
    drafts,
    locator,
    diff: new GitIncrementalDiffEngine(engine.runner),
    refs: engine.refs,
    store: engine.store,
    renderer: new StructuredReportRenderer(),
    labels: new StaticLabelCatalog(),
    now,
    toolVersion: '0.0.0-test',
    settleWindowMs: SETTLE,
    lockOptions: { timeoutMs: 20_000 },
  });
  let counter = 0;

  const harness = {
    repo,
    engine,
    drafts,
    service,
    locator,
    advance(ms: number) {
      offset += ms;
    },
    async change(name?: string) {
      counter += 1;
      await repo.write(
        name ?? `src/change${String(counter)}.ts`,
        `export const v = ${String(counter)};\n`,
      );
    },
    /** prepare → submit for a manual report on `site` (default: placeholder). */
    async manual(
      language: Language = 'en',
      site: JiraSite = PLACEHOLDER,
    ): Promise<ManualDraft & { reportDigest: string }> {
      const prepared = await service.prepare({
        mode: 'manual',
        cwd: repo.root,
        language,
        site,
        siteIsPlaceholder: site.id === PLACEHOLDER.id,
      });
      if (prepared.status !== 'prepared')
        throw new Error(`expected a new draft, got ${prepared.status}`);
      const submitted = await service.submit(
        repo.root,
        prepared.draft.reportId,
        sampleReport(language),
      );
      if (submitted.mode !== 'manual' || !submitted.reportDigest)
        throw new Error('expected manual');
      return submitted as ManualDraft & { reportDigest: string };
    },
    async mcp(language: Language = 'en'): Promise<McpDraft & { reportDigest: string }> {
      const prepared = await service.prepare({
        mode: 'mcp',
        cwd: repo.root,
        language,
        site: MCP_SITE,
        siteIsPlaceholder: false,
        mcp: { server: 'atlassian', cloudId: CLOUD_ID, issueLookup: issueLookup() },
      });
      if (prepared.status !== 'prepared')
        throw new Error(`expected a new draft, got ${prepared.status}`);
      const submitted = await service.submit(
        repo.root,
        prepared.draft.reportId,
        sampleReport(language),
      );
      if (submitted.mode !== 'mcp' || !submitted.reportDigest) throw new Error('expected mcp');
      return submitted as McpDraft & { reportDigest: string };
    },
    async confirm(draft: { reportId: string; reportDigest: string }) {
      return service.confirmManual(repo.root, draft.reportId, draft.reportDigest, {
        interactive: false,
      });
    },
    async draft(reportId: string): Promise<Draft> {
      return service.get(repo.root, reportId);
    },
    async journal(site: JiraSite = PLACEHOLDER) {
      return engine.store.read(await locator.locate(repo.root), site.id, ISSUE as never);
    },
    async cleanup() {
      await repo.cleanup();
    },
  };
  return harness;
}

export type DeliveryHarness = Awaited<ReturnType<typeof createDeliveryHarness>>;

// --- Simulated Atlassian MCP tool results (shapes follow Jira REST; unverified) ---

export function issueLookup(key = ISSUE, id = '10001', summary = 'User profile') {
  return [{ type: 'text', text: JSON.stringify({ id, key, fields: { summary } }) }];
}

export function createdComment(id: string, markdown: string, accountId = 'acc-dev') {
  return {
    id,
    created: '2026-10-08T10:00:00.000+0000',
    author: { accountId },
    body: {
      type: 'doc',
      version: 1,
      content: markdown
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
    },
  };
}

export function listing(comments: unknown[], total = comments.length) {
  return { startAt: 0, maxResults: 100, total, comments };
}

export const ACCOUNT = { account_id: 'acc-dev', name: 'Dev' };
