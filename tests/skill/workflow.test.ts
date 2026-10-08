import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/core/errors';
import { CLOUD_ID, createdComment, issueLookup, listing } from '../fixtures/delivery';
import { GitRepo } from '../fixtures/git-repo';
import { sampleContent } from '../fixtures/publication';
import { createSkillSession, type SkillSession } from '../fixtures/skill-session';

const SITE = 'https://example.atlassian.net';
const ACCOUNT = { account_id: 'acc-dev', name: 'Dev' };
const RESOURCES = [{ id: CLOUD_ID, url: SITE, name: 'example', scopes: ['read:jira-work'] }];

interface Context {
  skill: { state: string; matchesCli: boolean };
  repository: { root: string };
  issue: { key: string; source: string };
  mode: { value: string; source: string };
  language: { value: string; source: string };
  site: { url: string | null; placeholder: boolean };
  checkpoint: { sequence: number; confirmedBy: string } | null;
  pending: { reportId: string; status: string; mode: string }[];
  mcp: { server: string; tools: Record<string, string> };
  heredocDelimiter: string;
  nextStep: string;
  warnings: string[];
}

interface Prepared {
  result: 'prepared' | 'no-changes' | 'pending';
  reportId: string;
  sequence: number;
  language: string;
  mode: string;
  snapshotTree: string;
  files: { path: string; status: string }[];
}

interface Submitted {
  reportId: string;
  status: string;
  reportDigest: string;
  markdown: string;
}

interface Receipt {
  operation: string;
  status: string;
  mode: string;
  snapshot: { id: string; tree: string };
  comment: { id: string; url: string } | null;
  evidence: string | null;
  verifiedInJira: boolean;
  checkpoint: { advanced: boolean; confirmedBy: string | null };
  marker: string;
}

/** The report the session would write: facts from the prepare output only. */
function writeReport(prepared: Prepared) {
  return sampleContent(
    prepared.language as 'en' | 'uk',
    {},
    prepared.files.map((f) => f.path),
  );
}

describe('/jira-report in a controlled Claude Code session', () => {
  let s: SkillSession;
  beforeEach(async () => {
    s = await createSkillSession();
    await s.installer.install();
  });
  afterEach(async () => {
    await s.cleanup();
  });

  const context = (args = '', cwd?: string) =>
    s.json<Context>(['skill', 'context', '--json', '--args', args], undefined, cwd);
  const receipt = (id: string) => s.json<Receipt>(['report', 'receipt', '--report', id, '--json']);

  async function prepareManual(extra: string[] = []): Promise<Prepared> {
    return s.json<Prepared>(['report', 'prepare', '--json', '--mode', 'manual', ...extra]);
  }
  async function submit(prepared: Prepared): Promise<Submitted> {
    return s.json<Submitted>(
      ['report', 'submit', '--report', prepared.reportId, '--json', '--input', '-'],
      writeReport(prepared),
    );
  }
  function confirm(submitted: Submitted) {
    return s.bash([
      'report',
      'confirm',
      '--report',
      submitted.reportId,
      '--digest',
      submitted.reportDigest,
      '--attest-manual-publication',
    ]);
  }

  describe('discovery and repository resolution', () => {
    it('is installed once per user and resolves whichever repository Claude Code runs in', async () => {
      await access(path.join(s.claudeHome, 'skills', 'jira-report', 'SKILL.md'));
      await access(path.join(s.claudeHome, 'agents', 'jira-reporter.md'));

      const a = await context();
      expect(a).toMatchObject({
        skill: { state: 'installed', matchesCli: true },
        repository: { root: s.repo.root },
        issue: { key: 'LSND-1234', source: 'branch' },
        mode: { value: 'manual', source: 'default' },
        language: { value: 'en', source: 'default' },
        site: { url: null, placeholder: true },
        checkpoint: null,
        pending: [],
        nextStep: 'prepare',
        warnings: [],
      });
      expect(a.heredocDelimiter).toMatch(/^GIT2JIRA_JSON_[0-9A-F]{12}$/);

      // An unrelated repository, entered from a subdirectory: no per-project copy needed.
      const other = await s.repo.sibling('other');
      other.git('init', '-q', '-b', 'main');
      await other.write('README.md', '# Other\n');
      other.commitAll('init');
      other.git('switch', '-q', '-c', 'bugfix/ABC-7-crash');
      await other.write('lib/deep/x.ts', 'x\n');
      const b = await context('', path.join(other.root, 'lib', 'deep'));
      expect(b).toMatchObject({ repository: { root: other.root }, issue: { key: 'ABC-7' } });

      const outside = await s.bash(
        ['skill', 'context', '--json', '--args', ''],
        undefined,
        s.repo.sandbox,
      );
      expect(outside.exitCode).not.toBe(0);
      expect(outside.stderr).toMatch(/git2jira: .*(Git|repository)/i);
    });

    it('validates the arguments and lets them override configuration', async () => {
      await s.configStore.writeGlobal({
        report: { language: 'uk' },
        jira: { mode: 'mcp', site: SITE },
      });
      expect(await context()).toMatchObject({
        language: { value: 'uk', source: 'global' },
        mode: { value: 'mcp', source: 'global' },
        site: { url: SITE, placeholder: false },
        nextStep: 'mcp-access-check',
      });
      expect(await context('--language en --mode manual --issue LSND-77')).toMatchObject({
        language: { value: 'en', source: 'override' },
        mode: { value: 'manual', source: 'option' },
        issue: { key: 'LSND-77', source: 'option' },
        nextStep: 'prepare',
      });
      const bad = await s.bash(['skill', 'context', '--json', '--args', '--language ua']);
      expect(bad.exitCode).toBe(ExitCode.Usage);
      expect(bad.stderr).toContain('Unsupported language "ua"');
      expect(s.prompts).toEqual([]);
    });

    it('stops with guidance when the branch has no issue key', async () => {
      s.repo.git('switch', '-q', '-c', 'feature/no-key');
      const result = await s.bash(['skill', 'context', '--json', '--args', '']);
      expect(result.exitCode).not.toBe(0);
      const fixed = await context('--issue LSND-5');
      expect(fixed.issue).toEqual({ key: 'LSND-5', source: 'option' });
    });
  });

  describe('languages', () => {
    it.each([
      ['en', '### Summary', 'Implemented the user profile page.'],
      ['uk', '### Підсумок', 'Реалізовано сторінку профілю користувача.'],
    ])(
      'writes the whole report in %s when asked, whatever is configured',
      async (lang, heading, summary) => {
        await s.configStore.writeGlobal({ report: { language: lang === 'en' ? 'uk' : 'en' } });
        await s.repo.write('src/profile.ts', 'export const profile = 1;\n');
        const ctx = await context(`--language ${lang}`);
        expect(ctx.language).toEqual({ value: lang, source: 'override' });
        const prepared = await prepareManual(['--language', ctx.language.value]);
        expect(prepared.language).toBe(lang);
        const submitted = await submit(prepared);
        expect(submitted.markdown).toContain(heading);
        expect(submitted.markdown).toContain(summary);
        // Identifiers and paths stay as in the code.
        expect(submitted.markdown).toContain('src/profile.ts');
        expect(submitted.markdown).toContain('UserProfileView');

        // A report in the other language is refused: the language is the CLI's decision.
        const wrong = await s.bash(
          ['report', 'submit', '--report', prepared.reportId, '--json', '--input', '-'],
          sampleContent(lang === 'en' ? 'uk' : 'en', {}, ['src/profile.ts']),
        );
        expect(wrong.exitCode).not.toBe(0);
      },
    );
  });

  describe('manual mode', () => {
    it('first report, copy, confirmation, second report, and no changes, without Jira access', async () => {
      await s.repo.write('src/a.ts', 'export const a = 1;\n');
      const first = await prepareManual();
      expect(first).toMatchObject({ result: 'prepared', sequence: 1, mode: 'manual' });
      expect(first.files.map((f) => f.path)).toEqual(['src/a.ts']);
      const submitted = await submit(first);
      expect(submitted.status).toBe('READY_TO_COPY');
      expect(s.prompts).toEqual([]);

      // Copying is pre-approved and moves nothing.
      expect((await s.bash(['report', 'copy', '--report', first.reportId])).exitCode).toBe(0);
      expect(s.clipboard).toEqual([submitted.markdown]);
      let r = await receipt(first.reportId);
      expect(r).toMatchObject({ operation: 'pending', checkpoint: { advanced: false } });
      expect((await context()).pending).toEqual([
        expect.objectContaining({
          reportId: first.reportId,
          status: 'AWAITING_MANUAL_CONFIRMATION',
        }),
      ]);

      // Confirmation needs the user's approval; a denial changes nothing.
      s.setApproval(() => false);
      const denied = await confirm(submitted);
      expect(denied).toMatchObject({ prompted: true, denied: true });
      expect((await receipt(first.reportId)).checkpoint.advanced).toBe(false);

      s.setApproval(() => true);
      const confirmed = await confirm(submitted);
      expect(confirmed.exitCode).toBe(0);
      expect(confirmed.stdout).toContain('user-attested, not verified in Jira');
      r = await receipt(first.reportId);
      expect(r).toMatchObject({
        operation: 'user-attested',
        evidence: 'user-attested',
        verifiedInJira: false,
        checkpoint: { advanced: true, confirmedBy: 'user-attested' },
      });
      expect(s.prompts.every((p) => p.startsWith('git2jira report confirm'))).toBe(true);
      expect((await context()).checkpoint).toMatchObject({
        sequence: 1,
        confirmedBy: 'user-attested',
      });

      // Second report: only what changed since report #1.
      await s.repo.write('src/b.ts', 'export const b = 2;\n');
      const second = await prepareManual();
      expect(second).toMatchObject({ result: 'prepared', sequence: 2 });
      expect(second.files.map((f) => f.path)).toEqual(['src/b.ts']);
      expect((await confirm(await submit(second))).exitCode).toBe(0);

      // Nothing new.
      const none = await s.json<{ result: string }>([
        'report',
        'prepare',
        '--json',
        '--mode',
        'manual',
      ]);
      expect(none).toEqual({ result: 'no-changes' });
      expect((await context()).pending).toEqual([]);
    });

    it('keeps a pending report when the user has not published it, and resumes it later', async () => {
      await s.repo.write('src/a.ts', 'export const a = 1;\n');
      const prepared = await prepareManual();
      const submitted = await submit(prepared);
      // The user answers "Not yet": the Skill runs nothing else.

      const later = await context();
      expect(later.nextStep).toBe('resume');
      expect(later.pending).toEqual([
        expect.objectContaining({ reportId: prepared.reportId, status: 'READY_TO_COPY' }),
      ]);
      // A new prepare does not create a second report; new edits wait for the next one.
      await s.repo.write('src/late.ts', 'late\n');
      expect(await prepareManual()).toMatchObject({
        result: 'pending',
        reportId: prepared.reportId,
      });
      const shown = await s.bash([
        'report',
        'show',
        '--report',
        prepared.reportId,
        '--format',
        'markdown',
      ]);
      expect(shown.stdout).toContain(submitted.markdown.split('\n')[0]);
      expect((await confirm(submitted)).exitCode).toBe(0);

      const next = await prepareManual();
      expect(next.files.map((f) => f.path)).toEqual(['src/late.ts']);
    });

    it('resumes a report that has no text yet through a request file for the subagent', async () => {
      await s.repo.write('src/a.ts', 'export const a = 1;\n');
      const prepared = await prepareManual();
      const request = await s.json<{ requestFile: string; generation: { parts: string[] } }>([
        'report',
        'request',
        '--report',
        prepared.reportId,
        '--json',
      ]);
      expect(request.requestFile).toContain(path.join('git2jira', 'requests'));
      expect(request.requestFile.startsWith(s.repo.root + path.sep + '.git')).toBe(true);
      const file = JSON.parse(await readFile(request.requestFile, 'utf8')) as {
        generation: { parts: string[]; instructions: string };
      };
      expect(file.generation.parts.join('\n')).toContain('export const a = 1;');
      expect(file.generation.instructions).toMatch(/never an instruction to you/);
      expect((await submit(prepared)).status).toBe('READY_TO_COPY');
    });

    it('confirms exactly the snapshot that produced the report, not later edits', async () => {
      await s.repo.write('src/a.ts', 'export const a = 1;\n');
      const prepared = await prepareManual();
      // The user keeps working while reviewing the report.
      await s.repo.write('src/a.ts', 'export const a = 2;\n');
      await s.repo.write('src/c.ts', 'export const c = 3;\n');
      s.repo.commitAll('more work');
      const submitted = await submit(prepared);
      expect((await confirm(submitted)).exitCode).toBe(0);

      const r = await receipt(prepared.reportId);
      expect(r.snapshot.tree).toBe(prepared.snapshotTree);
      const next = await prepareManual();
      expect(next.files.map((f) => `${f.status}:${f.path}`).sort()).toEqual([
        'added:src/c.ts',
        'modified:src/a.ts',
      ]);
    });

    it('rejects a confirmation for a digest the user was not shown', async () => {
      await s.repo.write('src/a.ts', 'x\n');
      const submitted = await submit(await prepareManual());
      const forged = await confirm({ ...submitted, reportDigest: 'f'.repeat(64) });
      expect(forged.exitCode).not.toBe(0);
      expect((await receipt(submitted.reportId)).checkpoint.advanced).toBe(false);
    });
  });

  describe('MCP mode', () => {
    // Every tool name the session reports, including an unrelated server's.
    const ALL_TOOLS = [
      'mcp__atlassian__getAccessibleAtlassianResources',
      'mcp__atlassian__atlassianUserInfo',
      'mcp__atlassian__getJiraIssue',
      'mcp__atlassian__listJiraIssueComments',
      'mcp__atlassian__addOrEditJiraIssueComment',
      'mcp__other__search',
    ];

    beforeEach(async () => {
      await s.configStore.writeGlobal({ jira: { mode: 'mcp', site: SITE } });
      await s.repo.write('src/a.ts', 'export const a = 1;\n');
    });

    async function verify(tools: string[], probes: Record<string, unknown>) {
      return s.json<{ state: string; publicationEnabled: boolean }>(
        ['mcp', 'verify', '--json', '--input', '-'],
        { schemaVersion: 1, server: 'atlassian', tools, probes },
      );
    }

    async function readyAndPrepared(): Promise<{ prepared: Prepared; submitted: Submitted }> {
      const ctx = await context();
      expect(ctx.nextStep).toBe('mcp-access-check');
      const resources = s.mcpTool(ctx.mcp.tools.resources ?? '', () => RESOURCES);
      const user = s.mcpTool(ctx.mcp.tools.userInfo ?? '', () => ACCOUNT);
      const issue = s.mcpTool(ctx.mcp.tools.issue ?? '', () => issueLookup());
      const access = await verify(ALL_TOOLS, {
        resources: { ok: true, result: resources },
        userInfo: { ok: true, result: user },
        issue: { ok: true, result: issue },
      });
      expect(access).toMatchObject({ state: 'ready', publicationEnabled: true });
      const prepared = await s.json<Prepared>(
        [
          'report',
          'prepare',
          '--json',
          '--mode',
          'mcp',
          '--site',
          SITE,
          '--cloud-id',
          CLOUD_ID,
          '--server',
          ctx.mcp.server,
          '--issue-lookup',
          '-',
        ],
        issue,
      );
      expect(prepared).toMatchObject({ result: 'prepared', mode: 'mcp' });
      const submitted = await submit(prepared);
      expect(submitted.status).toBe('READY_FOR_REVIEW');
      // Reads and the steps up to review need no approval.
      expect(s.prompts).toEqual([]);
      return { prepared, submitted };
    }

    async function publish(submitted: Submitted) {
      return s.json<{
        body: { markdown: string };
        marker: string;
        issueKey: string;
        cloudId: string;
      }>(['report', 'publish', '--report', submitted.reportId, '--digest', submitted.reportDigest]);
    }

    const record = (id: string, envelope: unknown) =>
      s.bash(['report', 'record-result', '--report', id, '--json', '--input', '-'], envelope);

    it('reports missing authorization and read-only access instead of publishing', async () => {
      expect((await verify(['Read', 'mcp__other__search'], {})).state).toBe('no-tools');
      expect(
        (
          await verify(ALL_TOOLS, {
            resources: { ok: false, error: { message: 'Unauthorized', status: 401 } },
          })
        ).state,
      ).toBe('not-authenticated');
      const readOnly = await verify(
        ALL_TOOLS.filter((t) => !t.endsWith('addOrEditJiraIssueComment')),
        {
          resources: { ok: true, result: RESOURCES },
          userInfo: { ok: true, result: ACCOUNT },
          issue: { ok: true, result: issueLookup() },
        },
      );
      expect(readOnly).toMatchObject({ state: 'read-only', publicationEnabled: false });
      const status = await s.bash(['mcp', 'status']);
      expect(status.stdout).toContain('Last verification: read-only');

      // The user picks manual mode: no regeneration needed, no Jira access needed.
      const manual = await prepareManual();
      const submitted = await submit(manual);
      expect((await confirm(submitted)).exitCode).toBe(0);
      expect((await receipt(manual.reportId)).checkpoint).toEqual({
        advanced: true,
        confirmedBy: 'user-attested',
      });
    });

    it('publishes through the authorized comment tool only after approval, then verifies it', async () => {
      const { prepared, submitted } = await readyAndPrepared();
      const payload = await publish(submitted);
      expect(payload).toMatchObject({ issueKey: 'LSND-1234', cloudId: CLOUD_ID });
      expect(payload.body.markdown).toContain(payload.marker);
      expect((await receipt(prepared.reportId)).operation).toBe('in-flight');

      const result = s.mcpTool('mcp__atlassian__addOrEditJiraIssueComment', () =>
        createdComment('20001', payload.body.markdown),
      );
      const recorded = await record(prepared.reportId, {
        outcome: 'tool-returned',
        toolResult: result,
      });
      expect(recorded.exitCode).toBe(0);
      expect(JSON.parse(recorded.stdout)).toMatchObject({
        state: 'PUBLISHED',
        commentId: '20001',
        receipt: {
          operation: 'published',
          checkpoint: { advanced: true, confirmedBy: 'mcp-tool' },
        },
      });
      expect((await receipt(prepared.reportId)).verifiedInJira).toBe(false);

      const comments = s.mcpTool('mcp__atlassian__listJiraIssueComments', () =>
        listing([createdComment('20001', payload.body.markdown)]),
      );
      const verified = await s.json<{ result: string; receipt: Receipt }>(
        ['report', 'verify-comment', '--report', prepared.reportId, '--json', '--input', '-'],
        { comments, account: ACCOUNT },
      );
      expect(verified.result).toBe('found');
      expect(verified.receipt).toMatchObject({
        operation: 'published',
        evidence: 'tool-result',
        verifiedInJira: true,
        comment: { id: '20001', url: `${SITE}/browse/LSND-1234?focusedCommentId=20001` },
      });
      expect(s.prompts).toEqual([
        expect.stringMatching(/^git2jira report publish /),
        'mcp__atlassian__addOrEditJiraIssueComment',
        expect.stringMatching(/^git2jira report record-result /),
        expect.stringMatching(/^git2jira report verify-comment /),
      ]);
      expect((await context()).checkpoint).toMatchObject({ sequence: 1, confirmedBy: 'mcp-tool' });
    });

    it('keeps an unclear outcome UNCERTAIN, never re-sends, and settles it from a listing', async () => {
      const { prepared, submitted } = await readyAndPrepared();
      const payload = await publish(submitted);
      const timeout = await record(prepared.reportId, {
        outcome: 'tool-error',
        error: { message: 'upstream timeout', status: 504 },
      });
      expect(JSON.parse(timeout.stdout)).toMatchObject({
        state: 'UNCERTAIN',
        receipt: { operation: 'uncertain', checkpoint: { advanced: false } },
      });

      const again = await s.bash([
        'report',
        'publish',
        '--report',
        prepared.reportId,
        '--digest',
        submitted.reportDigest,
      ]);
      expect(again.exitCode).not.toBe(0);
      expect(again.stderr).toMatch(/not settled/);
      expect(
        (await s.bash(['report', 'fallback', '--report', prepared.reportId])).exitCode,
      ).not.toBe(0);
      expect((await context()).pending).toEqual([
        expect.objectContaining({ reportId: prepared.reportId, status: 'UNCERTAIN' }),
      ]);

      const reconciled = await s.json<{ state: string; receipt: Receipt }>(
        ['report', 'reconcile', '--report', prepared.reportId, '--json', '--input', '-'],
        { comments: listing([createdComment('20002', payload.body.markdown)]), account: ACCOUNT },
      );
      expect(reconciled).toMatchObject({
        state: 'RECOVERED',
        receipt: {
          operation: 'recovered',
          evidence: 'read-back',
          verifiedInJira: true,
          checkpoint: { advanced: true },
        },
      });
    });

    it('does not accept forged or unverifiable evidence of publication', async () => {
      const { prepared, submitted } = await readyAndPrepared();
      await publish(submitted);
      // A bare claim is not an envelope the CLI accepts.
      const claim = await record(prepared.reportId, { published: true, approved: true });
      expect(claim.exitCode).not.toBe(0);
      // A "result" without this report's marker proves nothing.
      const forged = await record(prepared.reportId, {
        outcome: 'tool-returned',
        toolResult: { id: '30001', published: true, body: 'Looks good!' },
      });
      expect(JSON.parse(forged.stdout)).toMatchObject({
        state: 'UNCERTAIN',
        receipt: { operation: 'uncertain', checkpoint: { advanced: false } },
      });
      // The receipt is always derived by the CLI; there is no command that accepts one.
      const r = await receipt(prepared.reportId);
      expect(r.checkpoint.advanced).toBe(false);
      expect((await s.bash(['report', 'receipt', '--input', '-'], r)).exitCode).not.toBe(0);
    });

    it('falls back to manual mode with the same text when publication is denied or fails', async () => {
      const { prepared, submitted } = await readyAndPrepared();
      await publish(submitted);
      // The user denies Claude Code's prompt for the comment tool.
      s.setApproval((what) => !what.includes('addOrEditJiraIssueComment'));
      expect(s.mcpTool('mcp__atlassian__addOrEditJiraIssueComment', () => 'never')).toBeUndefined();
      const notCalled = await record(prepared.reportId, {
        outcome: 'not-called',
        reason: 'permission-denied',
      });
      expect(JSON.parse(notCalled.stdout)).toMatchObject({ state: 'FAILED' });

      const fallback = await s.bash(['report', 'fallback', '--report', prepared.reportId]);
      expect(fallback.exitCode).toBe(0);
      expect(fallback.prompted).toBe(true);
      const shown = await s.json<{ mode: string; status: string; reportDigest: string }>([
        'report',
        'show',
        '--report',
        prepared.reportId,
        '--format',
        'json',
      ]);
      expect(shown).toMatchObject({
        mode: 'manual',
        status: 'READY_TO_COPY',
        reportDigest: submitted.reportDigest,
      });
      expect((await confirm(submitted)).exitCode).toBe(0);
      expect((await receipt(prepared.reportId)).checkpoint).toEqual({
        advanced: true,
        confirmedBy: 'user-attested',
      });
    });

    it('switches to manual before publishing when the comment tool is unavailable', async () => {
      const { prepared, submitted } = await readyAndPrepared();
      expect((await s.bash(['report', 'fallback', '--report', prepared.reportId])).exitCode).toBe(
        0,
      );
      expect((await s.bash(['report', 'export', '--report', prepared.reportId])).exitCode).toBe(0);
      expect((await confirm(submitted)).exitCode).toBe(0);
    });
  });

  describe('installation commands', () => {
    it('installs, upgrades, and reports conflicts through the CLI', async () => {
      const status = await s.json<{ state: string }>(['skill', 'status', '--json']);
      expect(status.state).toBe('installed');
      expect((await s.bash(['skill', 'verify'])).stdout).toContain('All checks passed.');

      await s.installer.uninstall();
      expect((await context()).skill.state).toBe('not-installed');
      const install = await s.bash(['skill', 'install']);
      expect(install).toMatchObject({ exitCode: 0, prompted: true });
      expect(install.stdout).toContain('Installed /jira-report');

      const skillFile = path.join(s.claudeHome, 'skills', 'jira-report', 'SKILL.md');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(skillFile, 'edited\n');
      const ctx = await context();
      expect(ctx.skill.state).toBe('modified');
      expect(ctx.warnings.join()).toMatch(/modified since installation/);
      expect((await s.bash(['skill', 'install'])).exitCode).not.toBe(0);
      expect((await s.bash(['skill', 'install', '--force'])).stdout).toContain('Repaired');
      expect((await s.bash(['skill', 'verify'])).exitCode).toBe(0);
    });
  });
});

describe('/jira-report from a linked worktree', () => {
  it('keeps state in the shared Git directory and resolves the worktree branch', async () => {
    const repo = await GitRepo.create({ branch: 'main-dev' });
    const s = await createSkillSession({ repo });
    try {
      const wt = path.join(repo.sandbox, 'wt');
      repo.git('worktree', 'add', '-q', '-b', 'feature/LSND-42-wt', wt);
      await repo.at(wt).write('src/w.ts', 'w\n');
      const ctx = await s.json<Context>(
        ['skill', 'context', '--json', '--args', ''],
        undefined,
        wt,
      );
      expect(ctx.issue.key).toBe('LSND-42');
      const prepared = await s.json<Prepared>(
        ['report', 'prepare', '--json', '--mode', 'manual'],
        undefined,
        wt,
      );
      expect(prepared.files.map((f) => f.path)).toEqual(['src/w.ts']);
    } finally {
      await s.cleanup();
    }
  });
});
