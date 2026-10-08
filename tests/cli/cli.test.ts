import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLANNED_COMMANDS } from '../../src/cli/commands/planned';
import { ExitCode } from '../../src/core/errors';
import { createCliHarness } from '../helpers';

describe('git2jira CLI', () => {
  let h: Awaited<ReturnType<typeof createCliHarness>>;

  beforeEach(async () => {
    h = await createCliHarness();
  });
  afterEach(() => h.cleanup());

  it('prints the version', async () => {
    const result = await h.run(['--version']);
    expect(result).toMatchObject({ exitCode: 0, stdout: '0.0.0-test\n' });
  });

  it('lists every planned command in help', async () => {
    const { exitCode, stdout } = await h.run(['--help']);
    expect(exitCode).toBe(0);
    for (const name of [
      'config',
      'init',
      'doctor',
      'login',
      'logout',
      'status',
      'report',
      'history',
      'recover',
      'uninstall',
    ]) {
      expect(stdout).toMatch(new RegExp(`^  ${name}\\b`, 'm'));
    }
  });

  it('rejects unknown commands with a usage error', async () => {
    expect((await h.run(['publish-everything'])).exitCode).toBe(ExitCode.Usage);
  });

  describe.each(PLANNED_COMMANDS)('planned command "$name"', ({ name, phase }) => {
    it(`fails honestly and points to Phase ${phase}`, async () => {
      const { exitCode, stdout, stderr } = await h.run([name]);
      expect(exitCode).toBe(ExitCode.NotImplemented);
      expect(stdout).toBe('');
      expect(stderr).toContain(`Phase ${phase}`);
    });
  });

  it('validates report --language before reporting it is not implemented', async () => {
    expect((await h.run(['report', '--language', 'de'])).exitCode).toBe(ExitCode.Usage);
    expect((await h.run(['report', '--language', 'uk'])).exitCode).toBe(ExitCode.NotImplemented);
  });

  describe('config', () => {
    it('defaults report.language to English', async () => {
      const { stdout } = await h.run(['config', 'get', 'report.language', '--json']);
      expect(JSON.parse(stdout)).toEqual({
        key: 'report.language',
        value: 'en',
        source: 'default',
      });
    });

    it('sets the global language and resolves it', async () => {
      expect((await h.run(['config', 'set', 'report.language', 'uk'])).exitCode).toBe(0);
      expect(JSON.parse(await readFile(h.globalPath, 'utf8'))).toEqual({
        version: 1,
        report: { language: 'uk' },
      });
      const { stdout } = await h.run(['config', 'get', 'report.language']);
      expect(stdout).toBe('uk\n');
    });

    it('prefers repository config over global config, from any subdirectory', async () => {
      await h.run(['config', 'set', 'report.language', 'uk']);
      await h.run(['config', 'set', 'report.language', 'en', '--repo']);
      const nested = path.join(h.repoRoot, 'src', 'nested');
      const { stdout } = await h.run(['config', 'get', 'report.language', '--json'], nested);
      expect(JSON.parse(stdout)).toMatchObject({ value: 'en', source: 'repository' });
      expect((await h.run(['config', 'get', 'report.language', '--global'])).stdout).toBe('uk\n');
    });

    it('unset falls back to the next source', async () => {
      await h.run(['config', 'set', 'report.language', 'uk', '--repo']);
      await h.run(['config', 'unset', 'report.language', '--repo']);
      const { stdout } = await h.run(['config', 'list', '--json']);
      expect(JSON.parse(stdout)).toEqual([
        { key: 'report.language', value: 'en', source: 'default' },
        { key: 'base.branch', value: null, source: 'default' },
      ]);
    });

    it('rejects invalid values and unknown keys without writing', async () => {
      const bad = await h.run(['config', 'set', 'report.language', 'ua']);
      expect(bad.exitCode).toBe(ExitCode.Usage);
      expect(bad.stderr).toContain('Supported: en, uk');
      expect((await h.run(['config', 'set', 'jira.apiToken', 'secret'])).exitCode).toBe(
        ExitCode.Usage,
      );
      await expect(readFile(h.globalPath, 'utf8')).rejects.toThrow();
    });

    it('refuses --repo outside a repository', async () => {
      const { exitCode, stderr } = await h.run(
        ['config', 'set', 'report.language', 'uk', '--repo'],
        h.dir,
      );
      expect(exitCode).toBe(ExitCode.Usage);
      expect(stderr).toContain('Not inside a Git repository');
    });

    it('surfaces an invalid repository config as an error', async () => {
      await writeFile(path.join(h.repoRoot, '.git2jira.json'), '{"report":{"language":"fr"}}');
      const { exitCode, stderr } = await h.run(['config', 'get', 'report.language']);
      expect(exitCode).toBe(ExitCode.Failure);
      expect(stderr).toContain('Invalid configuration');
    });
  });
});
