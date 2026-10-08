import path from 'node:path';
import { StructuredReportRenderer } from '../../src/adf/render';
import { repoConfigPath } from '../../src/config/paths';
import { FileConfigStore } from '../../src/config/store';
import { GitRepositoryLocatorImpl } from '../../src/git/repository';
import { JiraConnectionManager } from '../../src/jira/connections';
import { StaticLabelCatalog } from '../../src/localization/catalog';
import type { Language } from '../../src/localization/languages';
import type { PublicationCandidate } from '../../src/publication/lifecycle';
import { PlanStore, type StoredPlan } from '../../src/publication/plan';
import { JiraPublicationService } from '../../src/publication/service';
import { GitIncrementalDiffEngine } from '../../src/snapshots/diff';
import { GitRepo, createEngine } from './git-repo';
import { MemoryCredentialStore, MockJira, SITE_URL, type MockAccount } from './mock-jira';

export const ISSUE = 'LSND-1234';
export const SETTLE_MS = 60_000;

export function sampleReport(language: Language = 'en', overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    issueKey: ISSUE,
    language,
    summary: language === 'uk' ? 'Додано сторінку профілю.' : 'Added the profile page.',
    changes: [
      {
        kind: 'added',
        subject: 'UserProfileView',
        description: language === 'uk' ? 'Новий компонент.' : 'New component.',
        files: ['src/UserProfileView.vue'],
      },
    ],
    testing: ['pnpm test'],
    ...overrides,
  };
}

/** A Git repository, a mocked Jira, a signed-in connection, and the publication service. */
export async function createPublicationHarness() {
  const repo = await GitRepo.create({ branch: `feature/${ISSUE}-profile` });
  const jira = await MockJira.start();
  const dev: MockAccount = jira.addAccount({
    email: 'dev@example.com',
    token: 'dev-secret-token-123',
    accountId: 'acc-dev',
    displayName: 'Dev',
  });
  jira.addIssue({ id: '10001', key: ISSUE, summary: 'User profile' });

  const configStore = new FileConfigStore({
    globalPath: path.join(repo.sandbox, 'cfg', 'config.json'),
    repoPath: repoConfigPath,
  });
  const credentials = new MemoryCredentialStore();
  const manager = new JiraConnectionManager({
    configStore,
    credentialStore: credentials,
    http: {
      fetch: jira.fetch,
      timeoutMs: 300,
      retry: { baseDelayMs: 1, maxDelayMs: 2 },
      sleep: () => Promise.resolve(),
    },
  });
  await manager.login({
    name: 'work',
    siteUrl: SITE_URL,
    email: dev.email,
    token: dev.token,
    tokenType: 'auto',
  });
  jira.requests.length = 0;

  const engine = createEngine(repo);
  const locator = new GitRepositoryLocatorImpl(engine.runner);
  const plans = new PlanStore();
  let offset = 0;
  const service = new JiraPublicationService({
    lifecycle: engine.lifecycle,
    plans,
    connections: manager,
    locator,
    diff: new GitIncrementalDiffEngine(engine.runner),
    refs: engine.refs,
    store: engine.store,
    renderer: new StructuredReportRenderer(),
    labels: new StaticLabelCatalog(),
    now: () => new Date(Date.now() + offset),
    toolVersion: '0.0.0-test',
    settleWindowMs: SETTLE_MS,
    lockOptions: { timeoutMs: 20_000 },
  });

  let fileCounter = 0;
  const harness = {
    repo,
    jira,
    dev,
    configStore,
    credentials,
    manager,
    engine,
    plans,
    service,
    locator,
    advance(ms: number) {
      offset += ms;
    },
    async change() {
      await repo.write(
        `src/file${String(fileCounter++)}.ts`,
        `export const v = ${String(fileCounter)};\n`,
      );
    },
    /** prepare → review → approve, with a fresh change. */
    async ready(language: Language = 'en'): Promise<{ plan: StoredPlan; digest: string }> {
      await harness.change();
      const prepared = await service.prepare({ cwd: repo.root, language });
      if (prepared.status !== 'prepared') throw new Error('expected changes');
      const reviewed = await service.review(
        repo.root,
        prepared.plan.reportId,
        sampleReport(language),
      );
      const plan = await service.approve(repo.root, prepared.plan.reportId, reviewed.reportDigest);
      return { plan, digest: reviewed.reportDigest };
    },
    async candidate(plan: StoredPlan): Promise<PublicationCandidate> {
      return {
        reportId: plan.reportId,
        site: plan.site,
        snapshotRef: plan.snapshotRef,
        snapshot: plan.snapshot,
        baseline: plan.baseline,
        context: {
          repository: await locator.locate(repo.root),
          issueKey: plan.issueKey,
          branch: plan.branch,
        },
      };
    },
    comments() {
      return jira.comments.get(ISSUE) ?? [];
    },
    posts() {
      return jira.count('POST', /\/comment$/);
    },
    async plan(reportId: string) {
      return plans.read(await locator.locate(repo.root), reportId);
    },
    async journal() {
      const repository = await locator.locate(repo.root);
      const site = (await manager.get('work')).site;
      return engine.store.read(repository, site.id, ISSUE as never);
    },
    async cleanup() {
      await jira.close();
      await repo.cleanup();
    },
  };
  return harness;
}

export type PublicationHarness = Awaited<ReturnType<typeof createPublicationHarness>>;
