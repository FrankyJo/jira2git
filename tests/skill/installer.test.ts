import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSkillInstaller, SkillConflictError } from '../../src/skill/installer';
import { findSkillAssets, loadSkillPackage, type SkillPackage } from '../../src/skill/package';
import { createTempDir, must } from '../helpers';

const assets = must(findSkillAssets(path.dirname(fileURLToPath(import.meta.url))));

describe('Skill installer', () => {
  let home: string;
  let cleanup: () => Promise<void>;
  let version: string;
  let tweak: ((pkg: SkillPackage) => SkillPackage) | undefined;

  beforeEach(async () => {
    ({ dir: home, cleanup } = await createTempDir());
    version = '1.0.0';
    tweak = undefined;
  });
  afterEach(async () => {
    await cleanup();
  });

  function installer() {
    return new FileSkillInstaller({
      claudeHome: home,
      loadPackage: async () => {
        const pkg = await loadSkillPackage(assets, version);
        return tweak ? tweak(pkg) : pkg;
      },
      now: () => new Date('2026-10-08T12:00:00Z'),
    });
  }
  const skillDir = () => path.join(home, 'skills', 'jira-report');
  const agentPath = () => path.join(home, 'agents', 'jira-reporter.md');

  it('installs at user level and is discovered as installed', async () => {
    expect((await installer().status()).state).toBe('not-installed');
    const result = await installer().install();
    expect(result.action).toBe('installed');
    expect(result.state).toMatchObject({ state: 'installed', version: '1.0.0' });
    expect(await readFile(path.join(skillDir(), 'SKILL.md'), 'utf8')).toContain(
      'name: jira-report',
    );
    expect(await readFile(agentPath(), 'utf8')).toContain('name: jira-reporter');
    const manifest = JSON.parse(
      await readFile(path.join(skillDir(), '.git2jira-skill.json'), 'utf8'),
    ) as { version: string; files: Record<string, string> };
    expect(manifest.version).toBe('1.0.0');
    expect(Object.keys(manifest.files)).toContain('reference/mcp.md');
    // No staging leftovers next to the user's other skills.
    expect(await readdir(path.join(home, 'skills'))).toEqual(['jira-report']);

    const verified = await installer().verify();
    expect(verified).toMatchObject({ ok: true, problems: [], warnings: [] });
    expect((await installer().install()).action).toBe('unchanged');
  });

  it('upgrades in place, removes obsolete managed files, and keeps user files', async () => {
    tweak = (pkg) => ({
      ...pkg,
      skillFiles: new Map([...pkg.skillFiles, ['reference/old.md', Buffer.from('old\n')]]),
    });
    await installer().install();
    await writeFile(path.join(skillDir(), 'my-notes.md'), 'mine\n');

    version = '1.1.0';
    tweak = undefined;
    expect(await installer().status()).toMatchObject({
      state: 'outdated',
      installedVersion: '1.0.0',
      currentVersion: '1.1.0',
    });
    const result = await installer().install();
    expect(result.action).toBe('upgraded');
    expect(result.state).toMatchObject({ state: 'installed', version: '1.1.0' });
    expect(result.keptFiles).toEqual(['my-notes.md']);
    const files = await readdir(path.join(skillDir(), 'reference'));
    expect(files).not.toContain('old.md');
    expect(await readFile(path.join(skillDir(), 'my-notes.md'), 'utf8')).toBe('mine\n');
  });

  it('never overwrites a Skill it did not install', async () => {
    await mkdir(skillDir(), { recursive: true });
    await writeFile(
      path.join(skillDir(), 'SKILL.md'),
      '---\nname: jira-report\n---\nsomeone else\n',
    );
    const state = await installer().status();
    expect(state).toMatchObject({ state: 'conflict' });
    await expect(installer().install()).rejects.toThrow(SkillConflictError);
    await expect(installer().install({ force: true })).rejects.toThrow(/does not overwrite/);
    await expect(installer().uninstall({ force: true })).rejects.toThrow(/nothing was removed/);
    expect(await readFile(path.join(skillDir(), 'SKILL.md'), 'utf8')).toContain('someone else');
  });

  it('never overwrites an unrelated agent with the same name', async () => {
    await mkdir(path.dirname(agentPath()), { recursive: true });
    await writeFile(agentPath(), '---\nname: jira-reporter\n---\nmine\n');
    expect(await installer().status()).toMatchObject({
      state: 'conflict',
      paths: [agentPath()],
    });
    await expect(installer().install()).rejects.toThrow(SkillConflictError);
    expect(await readFile(agentPath(), 'utf8')).toContain('mine');
    await expect(readdir(path.join(home, 'skills'))).rejects.toThrow();
  });

  it('replaces files the user changed only with --force', async () => {
    await installer().install();
    const skill = path.join(skillDir(), 'SKILL.md');
    await writeFile(skill, `${await readFile(skill, 'utf8')}\nmy edit\n`);
    expect(await installer().status()).toMatchObject({
      state: 'modified',
      modifiedFiles: ['skills/jira-report/SKILL.md'],
    });
    await expect(installer().install()).rejects.toThrow(/--force/);
    await expect(installer().uninstall()).rejects.toThrow(/--force/);
    expect((await installer().verify()).ok).toBe(false);

    const repaired = await installer().install({ force: true });
    expect(repaired.action).toBe('repaired');
    expect(await readFile(skill, 'utf8')).not.toContain('my edit');
  });

  it('uninstalls only its own files', async () => {
    await installer().install();
    await writeFile(path.join(skillDir(), 'my-notes.md'), 'mine\n');
    const result = await installer().uninstall();
    expect(result).toEqual({ removed: true, keptFiles: ['my-notes.md'] });
    expect(await readdir(skillDir())).toEqual(['my-notes.md']);
    await expect(readFile(agentPath())).rejects.toThrow();

    await cleanup();
    ({ dir: home, cleanup } = await createTempDir());
    await installer().install();
    expect(await installer().uninstall()).toEqual({ removed: true, keptFiles: [] });
    await expect(readdir(skillDir())).rejects.toThrow();
    expect(await installer().uninstall()).toEqual({ removed: false, keptFiles: [] });
  });

  it('refuses to install a package that breaks the approval boundary', async () => {
    tweak = (pkg) => {
      const skill = must(pkg.skillFiles.get('SKILL.md'))
        .toString()
        .replace('  - Bash(git2jira report receipt *)', '  - Bash(git2jira report confirm *)');
      return { ...pkg, skillFiles: new Map([...pkg.skillFiles, ['SKILL.md', Buffer.from(skill)]]) };
    };
    await expect(installer().install()).rejects.toThrow(/pre-approve "report confirm"/);
    expect((await installer().status()).state).toBe('not-installed');
  });

  it('warns when Claude Code settings would pre-approve confirmations or publications', async () => {
    await installer().install();
    await writeFile(
      path.join(home, 'settings.json'),
      JSON.stringify({
        env: { SECRET: 'never-read' },
        permissions: { allow: ['Bash(git2jira *)', 'mcp__atlassian'] },
      }),
    );
    const project = path.join(home, 'project-settings.json');
    await writeFile(project, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
    const result = await installer().verify({ projectSettingsFiles: [project] });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain('never-read');
  });
});
