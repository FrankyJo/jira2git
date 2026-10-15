import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSkillInstaller, SkillConflictError } from '../../src/skill/installer';
import { findSkillAssets, loadSkillPackage } from '../../src/skill/package';
import { SkillSuiteInstaller } from '../../src/skill/suite';
import { REPORT_SKILL, RELEASE_NOTE_SKILL, type SkillSpec } from '../../src/skill/types';
import { createTempDir, must } from '../helpers';

const assets = must(findSkillAssets(path.dirname(fileURLToPath(import.meta.url))));

describe('Skill suite installer', () => {
  let home: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir: home, cleanup } = await createTempDir());
  });
  afterEach(async () => {
    await cleanup();
  });

  const part = (spec: SkillSpec, version = '1.0.0') =>
    new FileSkillInstaller({
      claudeHome: home,
      spec,
      loadPackage: () => loadSkillPackage(assets, version, spec),
      now: () => new Date('2026-10-15T12:00:00Z'),
    });
  const suite = (version = '1.0.0') =>
    new SkillSuiteInstaller([part(REPORT_SKILL, version), part(RELEASE_NOTE_SKILL, version)]);

  it('installs, verifies, and removes both Skills and their subagents', async () => {
    expect((await suite().status()).state).toBe('not-installed');
    expect((await suite().install()).action).toBe('installed');
    expect((await readdir(path.join(home, 'skills'))).sort()).toEqual([
      'jira-release-note',
      'jira-report',
    ]);
    expect((await readdir(path.join(home, 'agents'))).sort()).toEqual([
      'jira-release-writer.md',
      'jira-reporter.md',
    ]);
    expect(
      await readFile(path.join(home, 'skills', 'jira-release-note', 'SKILL.md'), 'utf8'),
    ).toContain('name: jira-release-note');
    expect(await suite().status()).toMatchObject({ state: 'installed', version: '1.0.0' });
    expect(await suite().verify()).toMatchObject({ ok: true, problems: [], warnings: [] });
    expect((await suite().install()).action).toBe('unchanged');

    expect((await suite().uninstall()).removed).toBe(true);
    expect(await readdir(path.join(home, 'skills'))).toEqual([]);
    expect(await readdir(path.join(home, 'agents'))).toEqual([]);
  });

  it('adds /jira-release-note when upgrading an installation that has only /jira-report', async () => {
    await part(REPORT_SKILL, '0.9.2').install();
    expect(await suite('1.0.0').status()).toMatchObject({
      state: 'outdated',
      installedVersion: '0.9.2',
    });
    expect((await suite('1.0.0').install()).action).toBe('upgraded');
    expect(await suite('1.0.0').status()).toMatchObject({ state: 'installed', version: '1.0.0' });
  });

  it('reports an installation missing one Skill as incomplete', async () => {
    await part(REPORT_SKILL).install();
    expect(await suite().status()).toMatchObject({
      state: 'outdated',
      installedVersion: '1.0.0 (incomplete)',
    });
  });

  it('writes nothing when either Skill conflicts with files it did not install', async () => {
    await mkdir(path.join(home, 'skills', 'jira-release-note'), { recursive: true });
    await writeFile(path.join(home, 'skills', 'jira-release-note', 'SKILL.md'), 'mine\n');
    const status = await suite().status();
    expect(status.state).toBe('conflict');
    await expect(suite().install()).rejects.toThrow(SkillConflictError);
    expect(await readdir(path.join(home, 'skills'))).toEqual(['jira-release-note']);
    await expect(suite().uninstall()).rejects.toThrow(SkillConflictError);
    expect(await readFile(path.join(home, 'skills', 'jira-release-note', 'SKILL.md'), 'utf8')).toBe(
      'mine\n',
    );
  });

  it('refuses to replace changed files without --force, in either Skill', async () => {
    await suite().install();
    const file = path.join(home, 'skills', 'jira-release-note', 'reference', 'format.md');
    await writeFile(file, 'changed\n');
    expect(await suite().status()).toMatchObject({
      state: 'modified',
      modifiedFiles: ['skills/jira-release-note/reference/format.md'],
    });
    await expect(suite().install()).rejects.toThrow(/--force/);
    expect((await suite().install({ force: true })).action).toBe('repaired');
    expect(await readFile(file, 'utf8')).not.toBe('changed\n');
  });
});
