import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repoConfigPath } from '../../src/config/paths';
import { FileConfigStore } from '../../src/config/store';
import { ConfigError } from '../../src/core/errors';
import { createTempDir } from '../helpers';

describe('FileConfigStore', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let store: FileConfigStore;

  beforeEach(async () => {
    ({ dir, cleanup } = await createTempDir());
    store = new FileConfigStore({
      globalPath: path.join(dir, 'cfg', 'config.json'),
      repoPath: repoConfigPath,
    });
  });
  afterEach(() => cleanup());

  it('treats missing files as empty configuration', async () => {
    expect(await store.readGlobal()).toEqual({});
    expect(await store.readRepo(dir)).toEqual({});
  });

  it('round-trips global config, stamps the schema version, and creates the directory', async () => {
    await store.writeGlobal({ report: { language: 'uk' } });
    expect(await store.readGlobal()).toEqual({ version: 1, report: { language: 'uk' } });
  });

  it.skipIf(process.platform === 'win32')(
    'writes the global config readable only by the user',
    async () => {
      await store.writeGlobal({ report: { language: 'en' } });
      expect((await stat(store.globalPath)).mode & 0o777).toBe(0o600);
    },
  );

  it('writes repository config to .git2jira.json', async () => {
    await store.writeRepo(dir, { report: { language: 'en' } });
    const raw = JSON.parse(await readFile(path.join(dir, '.git2jira.json'), 'utf8')) as unknown;
    expect(raw).toEqual({ version: 1, report: { language: 'en' } });
  });

  it('reports invalid JSON with the file path', async () => {
    await mkdir(path.dirname(store.globalPath), { recursive: true });
    await writeFile(store.globalPath, '{ not json');
    await expect(store.readGlobal()).rejects.toThrow(ConfigError);
    await expect(store.readGlobal()).rejects.toThrow(store.globalPath);
  });

  it('reports schema violations instead of ignoring them', async () => {
    await writeFile(repoConfigPath(dir), JSON.stringify({ report: { language: 'fr' } }));
    await expect(store.readRepo(dir)).rejects.toThrow(/Invalid configuration/);
  });

  it('refuses to write invalid configuration', async () => {
    // @ts-expect-error -- deliberately invalid input
    await expect(store.writeGlobal({ report: { language: 'xx' } })).rejects.toThrow(ConfigError);
  });
});
