import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/core/errors';
import { mcpPublicationBlocker } from '../../src/mcp/verification';
import { FileSkillInstaller } from '../../src/skill/installer';
import { loadSkillPackage } from '../../src/skill/package';
import { GitRepo } from '../fixtures/git-repo';
import { ASSETS, verification } from '../fixtures/setup';
import { createSkillSession, type SkillSession } from '../fixtures/skill-session';
import { createTempDir } from '../helpers';

/** Regression tests for the Phase 6 security audit (docs/security.md, "Audit findings"). */
describe('security hardening', () => {
  let s: SkillSession;
  beforeEach(async () => {
    s = await createSkillSession({ repo: await GitRepo.create({ branch: 'feature/LSND-1234' }) });
  });
  afterEach(async () => {
    await s.cleanup();
  });

  async function draft() {
    await s.repo.write('src/a.ts', 'x\n');
    const prepared = await s.json<{ reportId: string; files: { path: string }[] }>([
      'report',
      'prepare',
      '--json',
      '--mode',
      'manual',
    ]);
    await s.json(['report', 'submit', '--report', prepared.reportId, '--json', '--input', '-'], {
      schemaVersion: 2,
      issueKey: 'LSND-1234',
      language: 'en',
      summary: 'Added a.',
      completedWork: [
        {
          kind: 'added',
          category: 'feature',
          subject: 'a',
          description: 'Added a.',
          files: ['src/a.ts'],
        },
      ],
      testing: { status: 'not-run', notes: [] },
    });
    return prepared.reportId;
  }

  describe('F1 (high): the pre-approved "report export" cannot write arbitrary files', () => {
    it('refuses --output inside a Claude Code session', async () => {
      const id = await draft();
      const target = path.join(s.repo.sandbox, 'victim.md');
      const result = await s.bash(['report', 'export', '--report', id, '--output', target]);
      // Pre-approved by the Skill, so it ran without a prompt — and must refuse.
      expect(result.prompted).toBe(false);
      expect(result.exitCode).toBe(ExitCode.Usage);
      await expect(access(target)).rejects.toThrow();
    });

    it('never overwrites an existing file and only writes .md or .txt from a terminal', async () => {
      const id = await draft();
      const { runCli } = await import('../../src/cli/run');
      const { createDefaultContainer } = await import('../../src/app/bootstrap');
      const { SpawnGitRunner } = await import('../../src/git/runner');
      const run = async (argv: string[]) => {
        let err = '';
        const code = await runCli(argv, {
          container: createDefaultContainer().register(
            'gitRunner',
            () => new SpawnGitRunner({ env: s.repo.env }),
          ),
          cwd: s.repo.root,
          stdout: { write: () => true },
          stderr: {
            write: (t: string) => {
              err += t;
              return true;
            },
          },
          env: {},
        });
        return { code, err };
      };
      const rc = path.join(s.repo.sandbox, '.zshrc.md');
      await writeFile(rc, 'original\n');
      expect((await run(['report', 'export', '--report', id, '--output', rc])).err).toContain(
        'does not overwrite',
      );
      expect(await readFile(rc, 'utf8')).toBe('original\n');
      expect(
        (
          await run([
            'report',
            'export',
            '--report',
            id,
            '--output',
            path.join(s.repo.sandbox, '.bashrc'),
          ])
        ).code,
      ).toBe(ExitCode.Usage);
      const fresh = path.join(s.repo.sandbox, 'report.md');
      expect((await run(['report', 'export', '--report', id, '--output', fresh])).code).toBe(0);
      expect(await readFile(fresh, 'utf8')).toContain('Added a.');
    });
  });

  it('F2 (medium): a repository fsmonitor hook is never executed', async () => {
    const marker = path.join(s.repo.sandbox, 'fsmonitor-ran');
    const hook = path.join(s.repo.sandbox, 'hook.sh');
    await writeFile(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    s.repo.git('config', 'core.fsmonitor', hook);
    await s.repo.write('src/a.ts', 'x\n');
    const prepared = await s.bash(['report', 'prepare', '--json', '--mode', 'manual']);
    expect(prepared.stderr).toBe('');
    expect(prepared.exitCode).toBe(0);
    const id = (JSON.parse(prepared.stdout) as { reportId: string }).reportId;
    expect((await s.bash(['report', 'request', '--report', id, '--json'])).exitCode).toBe(0);
    await expect(access(marker)).rejects.toThrow();
  });

  describe('F3 (medium): MCP publication needs a current, successful access check', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    it.each([
      ['no check', undefined, /has not been checked/],
      ['read-only', verification('read-only'), /found "read-only"/],
      ['blocked', verification('blocked-by-policy'), /found "blocked-by-policy"/],
      [
        'another server',
        { ...verification('ready'), server: 'other', tools: { writeComment: 'x' } },
        /not "atlassian"/,
      ],
      [
        'stale',
        {
          ...verification('ready'),
          verifiedAt: '2026-10-06T12:00:00Z',
          tools: { writeComment: 'x' },
        },
        /older than 12 hours/,
      ],
    ])('blocks: %s', (_name, record, message) => {
      expect(mcpPublicationBlocker(record, 'atlassian', now)).toMatch(message);
    });
    it('allows a recent ready check for the same server', () => {
      expect(
        mcpPublicationBlocker(
          {
            ...verification('ready'),
            verifiedAt: '2026-10-08T11:00:00Z',
            tools: { writeComment: 'mcp__atlassian__addOrEditJiraIssueComment' },
          },
          'atlassian',
          now,
        ),
      ).toBeUndefined();
    });
  });

  it('F4 (low): "report open" only opens Jira sites', async () => {
    const id = await (async () => {
      await s.repo.write('src/a.ts', 'x\n');
      return (
        await s.json<{ reportId: string }>([
          'report',
          'prepare',
          '--json',
          '--mode',
          'manual',
          '--site',
          'https://evil.example.com',
        ])
      ).reportId;
    })();
    const result = await s.bash(['report', 'open', '--report', id]);
    expect(result.stdout).toContain('Not opening https://evil.example.com/browse/LSND-1234');
    expect(s.clipboard).toEqual([]); // the recording process runner was never asked to open it
  });

  it('never follows symlinks out of the repository into the analyzed content', async () => {
    const secret = path.join(s.repo.sandbox, 'outside-secret.txt');
    await writeFile(secret, 'TOPSECRET-VALUE-42\n');
    await s.repo.symlink('link-to-secret', secret);
    const result = await s.bash(['report', 'prepare', '--json', '--mode', 'manual']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('TOPSECRET-VALUE-42');
    expect(result.stdout).toContain('link-to-secret');
  });

  it('keeps secret files and values out of the analysis output', async () => {
    await s.repo.write('.env', 'API_TOKEN=sk-live-0123456789abcdef0123456789abcdef\n');
    await s.repo.write('src/config.ts', 'const password = "hunter2-very-secret";\n');
    const result = await s.bash(['report', 'prepare', '--json', '--mode', 'manual']);
    expect(result.stdout).not.toContain('sk-live-0123456789abcdef');
    expect(result.stdout).not.toContain('hunter2-very-secret');
    expect(result.stdout).toContain('.env');
  });

  it.each([
    ['--issue', '$(touch /tmp/x)'],
    ['--issue', 'LSND-1;rm -rf ~'],
    ['--language', '--help'],
  ])('rejects injected option values (%s %s)', async (flag, value) => {
    const result = await s.bash(['skill', 'context', '--json', '--args', `${flag} ${value}`]);
    expect(result.exitCode).toBe(ExitCode.Usage);
  });

  it('refuses report ids that could traverse paths', async () => {
    const result = await s.bash(['report', 'show', '--report', '../../../etc/passwd']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it('never deletes files outside the Skill directory, even with a tampered manifest', async () => {
    const { dir, cleanup } = await createTempDir();
    try {
      const installer = new FileSkillInstaller({
        claudeHome: path.join(dir, 'claude'),
        loadPackage: () => loadSkillPackage(ASSETS, '1.0.0'),
      });
      await installer.install();
      const victim = path.join(dir, 'victim.txt');
      await writeFile(victim, 'keep\n');
      const manifestPath = path.join(
        dir,
        'claude',
        'skills',
        'jira-report',
        '.git2jira-skill.json',
      );
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        files: Record<string, string>;
      };
      manifest.files['../../../victim.txt'] = 'a'.repeat(64);
      await writeFile(manifestPath, JSON.stringify(manifest));
      expect((await installer.status()).state).toBe('conflict');
      await expect(installer.uninstall({ force: true })).rejects.toThrow();
      expect(await readFile(victim, 'utf8')).toBe('keep\n');
    } finally {
      await cleanup();
    }
  });

  it('ships no credentials or private files in the Skill package', async () => {
    const pkg = await loadSkillPackage(ASSETS, '1.0.0');
    const all = [...pkg.skillFiles.values(), pkg.agent].map((b) => b.toString()).join('\n');
    expect(all).not.toMatch(/(sk-|xox[bp]-|ghp_|AKIA)[A-Za-z0-9]{10,}/);
    expect(all).not.toMatch(/ATATT[A-Za-z0-9]/); // Atlassian API token prefix
    await mkdir(path.join(s.repo.sandbox, 'x'), { recursive: true });
  });
});
