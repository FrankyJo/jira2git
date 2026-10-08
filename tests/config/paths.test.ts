import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepositoryRoot, globalConfigDir } from '../../src/config/paths';
import { createTempDir } from '../helpers';

describe('globalConfigDir', () => {
  const homeDir = '/home/dev';

  it('honours GIT2JIRA_CONFIG_DIR first', () => {
    expect(
      globalConfigDir({
        env: { GIT2JIRA_CONFIG_DIR: '/custom', XDG_CONFIG_HOME: '/xdg' },
        platform: 'linux',
        homeDir,
      }),
    ).toBe(path.resolve('/custom'));
  });

  it('uses XDG_CONFIG_HOME on Unix-like systems', () => {
    expect(globalConfigDir({ env: { XDG_CONFIG_HOME: '/xdg' }, platform: 'darwin', homeDir })).toBe(
      path.join('/xdg', 'git2jira'),
    );
  });

  it('defaults to ~/.config/git2jira', () => {
    expect(globalConfigDir({ env: {}, platform: 'linux', homeDir })).toBe(
      path.join(homeDir, '.config', 'git2jira'),
    );
  });

  it('uses APPDATA on Windows', () => {
    expect(globalConfigDir({ env: { APPDATA: 'C:\\Roaming' }, platform: 'win32', homeDir })).toBe(
      path.join('C:\\Roaming', 'git2jira'),
    );
  });
});

describe('findRepositoryRoot', () => {
  it('walks up to the directory containing .git (directory or worktree file)', async () => {
    const { dir, cleanup } = await createTempDir();
    try {
      await mkdir(path.join(dir, 'a', '.git'), { recursive: true });
      await mkdir(path.join(dir, 'a', 'b', 'c'), { recursive: true });
      expect(await findRepositoryRoot(path.join(dir, 'a', 'b', 'c'))).toBe(path.join(dir, 'a'));

      await mkdir(path.join(dir, 'wt'), { recursive: true });
      await writeFile(path.join(dir, 'wt', '.git'), 'gitdir: /elsewhere');
      expect(await findRepositoryRoot(path.join(dir, 'wt'))).toBe(path.join(dir, 'wt'));
    } finally {
      await cleanup();
    }
  });
});
