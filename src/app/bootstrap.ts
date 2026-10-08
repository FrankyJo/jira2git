import { GitRefs } from '../checkpoints/refs';
import { LineageStore } from '../checkpoints/store';
import { currentPathEnvironment, globalConfigPath, repoConfigPath } from '../config/paths';
import { FileConfigStore } from '../config/store';
import { BaseBranchResolver } from '../git/base';
import { BranchIssueKeyDetector } from '../git/issue-key';
import { GitRepositoryLocatorImpl } from '../git/repository';
import { SpawnGitRunner } from '../git/runner';
import { PublicationLifecycle } from '../publication/lifecycle';
import { GitIncrementalDiffEngine } from '../snapshots/diff';
import { GitSnapshotEngine } from '../snapshots/engine';
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
        }),
    );
}
