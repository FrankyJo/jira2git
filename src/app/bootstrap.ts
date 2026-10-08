import path from 'node:path';
import { GitRefs } from '../checkpoints/refs';
import { LineageStore } from '../checkpoints/store';
import {
  currentPathEnvironment,
  globalConfigDir,
  globalConfigPath,
  repoConfigPath,
} from '../config/paths';
import { FileConfigStore } from '../config/store';
import { BaseBranchResolver } from '../git/base';
import { BranchIssueKeyDetector } from '../git/issue-key';
import { GitRepositoryLocatorImpl } from '../git/repository';
import { SpawnGitRunner } from '../git/runner';
import { StructuredReportRenderer } from '../adf/render';
import { createPlatformCredentialStore } from '../credentials/platform';
import { createClackPrompter } from '../installer/clack-prompter';
import { JiraConnectionManager } from '../jira/connections';
import { StaticLabelCatalog } from '../localization/catalog';
import { PublicationLifecycle } from '../publication/lifecycle';
import { PlanStore } from '../publication/plan';
import { JiraPublicationService } from '../publication/service';
import { GitIncrementalDiffEngine } from '../snapshots/diff';
import { GitSnapshotEngine } from '../snapshots/engine';
import { SpawnProcessRunner } from '../core/process';
import { DraftStore } from '../delivery/draft';
import { ReportDeliveryService, openDraftRefs } from '../delivery/service';
import { ClaudeCliRegistry } from '../mcp/claude-code';
import { McpVerificationStore } from '../mcp/setup';
import { ServiceContainer } from './container';

/** Composition root for the production CLI. Later phases register their services here. */
export function createDefaultContainer(): ServiceContainer {
  return new ServiceContainer()
    .register('pathEnvironment', () => currentPathEnvironment())
    .register(
      'configStore',
      (c) =>
        new FileConfigStore({
          globalPath: globalConfigPath(c.resolve('pathEnvironment')),
          repoPath: repoConfigPath,
        }),
    )
    .register('gitRunner', () => new SpawnGitRunner())
    .register('repositoryLocator', (c) => new GitRepositoryLocatorImpl(c.resolve('gitRunner')))
    .register('issueKeyDetector', () => new BranchIssueKeyDetector())
    .register('baseResolver', (c) => new BaseBranchResolver(c.resolve('gitRunner')))
    .register('snapshotEngine', (c) => new GitSnapshotEngine(c.resolve('gitRunner')))
    .register('diffEngine', (c) => new GitIncrementalDiffEngine(c.resolve('gitRunner')))
    .register('lineageStore', () => new LineageStore())
    .register('gitRefs', (c) => new GitRefs(c.resolve('gitRunner')))
    .register(
      'publicationLifecycle',
      (c) =>
        new PublicationLifecycle({
          git: c.resolve('gitRunner'),
          locator: c.resolve('repositoryLocator'),
          issueKeys: c.resolve('issueKeyDetector'),
          baseResolver: c.resolve('baseResolver'),
          snapshots: c.resolve('snapshotEngine'),
          diff: c.resolve('diffEngine'),
          store: c.resolve('lineageStore'),
          refs: c.resolve('gitRefs'),
          openCandidates: async (repository) => {
            const plans = await c.resolve('planStore').list(repository);
            return [
              ...plans
                .filter((p) => !['PUBLISHED', 'RECOVERED'].includes(p.status))
                .map((p) => p.snapshotRef),
              ...(await openDraftRefs(c.resolve('draftStore'), repository)),
            ];
          },
        }),
    )
    .register('prompter', () => createClackPrompter())
    .register('credentialStore', () => createPlatformCredentialStore())
    .register(
      'jiraConnections',
      (c) =>
        new JiraConnectionManager({
          configStore: c.resolve('configStore'),
          credentialStore: c.resolve('credentialStore'),
        }),
    )
    .register('planStore', () => new PlanStore())
    .register('adfRenderer', () => new StructuredReportRenderer())
    .register('labelCatalog', () => new StaticLabelCatalog())
    .register(
      'publicationService',
      (c) =>
        new JiraPublicationService({
          lifecycle: c.resolve('publicationLifecycle'),
          plans: c.resolve('planStore'),
          connections: c.resolve('jiraConnections'),
          locator: c.resolve('repositoryLocator'),
          diff: c.resolve('diffEngine'),
          refs: c.resolve('gitRefs'),
          store: c.resolve('lineageStore'),
          renderer: c.resolve('adfRenderer'),
          labels: c.resolve('labelCatalog'),
        }),
    )
    .register('processRunner', () => new SpawnProcessRunner())
    .register('draftStore', () => new DraftStore())
    .register(
      'deliveryService',
      (c) =>
        new ReportDeliveryService({
          lifecycle: c.resolve('publicationLifecycle'),
          drafts: c.resolve('draftStore'),
          locator: c.resolve('repositoryLocator'),
          diff: c.resolve('diffEngine'),
          refs: c.resolve('gitRefs'),
          store: c.resolve('lineageStore'),
          renderer: c.resolve('adfRenderer'),
          labels: c.resolve('labelCatalog'),
        }),
    )
    .register('claudeMcpRegistry', (c) => new ClaudeCliRegistry(c.resolve('processRunner')))
    .register(
      'mcpVerificationStore',
      (c) =>
        new McpVerificationStore(
          path.join(globalConfigDir(c.resolve('pathEnvironment')), 'mcp-verification.json'),
        ),
    );
}
