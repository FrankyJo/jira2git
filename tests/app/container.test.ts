import { describe, expect, it, vi } from 'vitest';
import { SERVICE_PHASES, ServiceContainer } from '../../src/app/container';
import { createDefaultContainer } from '../../src/app/bootstrap';
import { NotImplementedError } from '../../src/core/errors';

describe('ServiceContainer', () => {
  it('creates services lazily and only once', () => {
    const factory = vi.fn(() => ({ env: {}, platform: 'linux' as const, homeDir: '/h' }));
    const container = new ServiceContainer().register('pathEnvironment', factory);
    expect(factory).not.toHaveBeenCalled();
    expect(container.resolve('pathEnvironment')).toBe(container.resolve('pathEnvironment'));
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('lets factories resolve their dependencies', () => {
    const container = new ServiceContainer()
      .register('pathEnvironment', () => ({ env: {}, platform: 'linux' as const, homeDir: '/h' }))
      .register('configStore', (c) => {
        const env = c.resolve('pathEnvironment');
        return { globalPath: `${env.homeDir}/x` } as never;
      });
    expect(container.resolve('configStore').globalPath).toBe('/h/x');
  });

  it('throws NotImplementedError naming the delivering phase for unregistered services', () => {
    const container = new ServiceContainer();
    expect(() => container.resolve('reportGenerator')).toThrow(NotImplementedError);
    expect(() => container.resolve('reportGenerator')).toThrow(/Phase 3/);
    expect(() => container.resolve('jiraConnections')).toThrow(/Phase 2/);
    expect(() => container.resolve('snapshotEngine')).toThrow(/Phase 1/);
  });
});

describe('default container', () => {
  it('registers exactly the services of Phases 0 to 2', () => {
    const container = createDefaultContainer();
    for (const [name, phase] of Object.entries(SERVICE_PHASES)) {
      expect(container.has(name as keyof typeof SERVICE_PHASES), name).toBe(phase <= 2);
    }
  });
});
