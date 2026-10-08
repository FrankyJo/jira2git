import { currentPathEnvironment, globalConfigPath, repoConfigPath } from '../config/paths';
import { FileConfigStore } from '../config/store';
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
    );
}
