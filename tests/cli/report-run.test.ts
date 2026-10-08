import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReportEngine } from '../../src/ai/engine';
import { createDefaultContainer } from '../../src/app/bootstrap';
import { jiraSiteFromUrl } from '../../src/checkpoints/site';
import { isCheckpoint, type JiraSite } from '../../src/checkpoints/types';
import { repoConfigPath } from '../../src/config/paths';
import { FileConfigStore } from '../../src/config/store';
import { ExitCode } from '../../src/core/errors';
import type { CredentialStore } from '../../src/credentials/types';
import { PLACEHOLDER_SITE_URL } from '../../src/delivery/site';
import { GitRepositoryLocatorImpl } from '../../src/git/repository';
import { SpawnGitRunner } from '../../src/git/runner';
import { JiraConnectionManager } from '../../src/jira/connections';
import { LineageStore } from '../../src/checkpoints/store';
import { runCli } from '../../src/cli/run';
import { FakeModel, RecordingRunner, ScriptedPrompter, decodePrompt } from '../fixtures/ai';
import { CLOUD_ID, createdComment, issueLookup } from '../fixtures/delivery';
import { GitRepo } from '../fixtures/git-repo';
import { MemoryCredentialStore, MockJira, SITE_URL } from '../fixtures/mock-jira';
import { ISSUE, sampleContent } from '../fixtures/publication';
import { MemoryStream, must } from '../helpers';

/** Any use of credentials or Jira connections fails the test. */
const NO_CREDENTIALS: CredentialStore = new Proxy({} as CredentialStore, {
  get: () => () => {
    throw new Error('credentials must not be used');
  },
});

const PLACEHOLDER: JiraSite = jiraSiteFromUrl(PLACEHOLDER_SITE_URL);

interface RunOptions {
  interactive?: boolean;
  answers?: (string | boolean)[];
  env?: Record<string, string | undefined>;
}

describe('git2jira report (end to end, fake model)', () => {
  let repo: GitRepo;
  let configStore: FileConfigStore;
  let model: FakeModel;
  let processes: RecordingRunner;
  let prompter: ScriptedPrompter;

  beforeEach(async () => {
    repo = await GitRepo.create({ branch: `feature/${ISSUE}-profile` });
    configStore = new FileConfigStore({
      globalPath: path.join(repo.sandbox, 'cfg', 'config.json'),
      repoPath: repoConfigPath,
    });
    model = new FakeModel();
    processes = new RecordingRunner((file) =>
      file === 'pnpm' ? { stdout: 'Tests 3 passed', exitCode: 0 } : {},
    );
    prompter = new ScriptedPrompter([]);
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  function container() {
    return createDefaultContainer()
      .register('gitRunner', () => new SpawnGitRunner({ env: repo.env }))
      .register('configStore', () => configStore)
      .register('credentialStore', () => NO_CREDENTIALS)
      .register('jiraConnections', () => {
        throw new Error('Jira connections must not be used');
      })
      .register('processRunner', () => processes)
      .register('prompter', () => prompter)
      .register('reportGenerator', () => () => new ReportEngine(model));
  }

  async function run(argv: string[], options: RunOptions = {}, shared = container()) {
    prompter = new ScriptedPrompter(options.answers ?? []);
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();
    const exitCode = await runCli(argv, {
      container: shared,
      cwd: repo.root,
      stdout,
      stderr,
      interactive: options.interactive ?? false,
      env: options.env ?? {},
    });
    return { exitCode, stdout: stdout.text, stderr: stderr.text };
  }

  async function json(file: string, value: unknown): Promise<string> {
    const target = path.join(repo.sandbox, file);
    await writeFile(target, JSON.stringify(value));
    return target;
  }

  async function pending(): Promise<Record<string, unknown>[]> {
    return JSON.parse((await run(['report', 'pending', '--json'])).stdout) as Record<
      string,
      unknown
    >[];
  }

  async function journal(site: JiraSite = PLACEHOLDER) {
    const runner = new SpawnGitRunner({ env: repo.env });
    const repository = await new GitRepositoryLocatorImpl(runner).locate(repo.root);
    return new LineageStore().read(repository, site.id, ISSUE as never);
  }

  async function confirmPending() {
    const [draft] = await pending();
    return run([
      'report',
      'confirm',
      '--report',
      String(draft?.reportId),
      '--digest',
      String(draft?.reportDigest),
      '--attest-manual-publication',
    ]);
  }

  it('generates an English manual report without any Jira authentication', async () => {
    await repo.write('src/UserProfileView.vue', '<template>profile</template>\n');
    const result = await run(['report']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Jira issue:  LSND-1234');
    expect(result.stdout).toContain('Mode:        manual');
    expect(result.stdout).toContain('Language:    en (English)');
    expect(result.stdout).toContain('Files:       1 created · 0 modified · 0 deleted or renamed');
    expect(result.stdout).toContain('## Implementation Report #1');
    expect(result.stdout).toContain('### Created Files\n\n- `src/UserProfileView.vue` — Updated.');
    expect(result.stdout).toContain('No tests were run for this report.');
    expect(result.stdout).toContain('Nothing was published.');
    expect(await pending()).toEqual([
      expect.objectContaining({ status: 'READY_TO_COPY', mode: 'manual', confirmation: null }),
    ]);
    expect(await journal()).toBeUndefined();
  });

  it('generates a Ukrainian report with localized headings', async () => {
    await repo.write('src/a.ts', 'export const a = 1;\n');
    const result = await run(['report', '--language', 'uk']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## Звіт про реалізацію #1');
    expect(result.stdout).toContain('### Виконані роботи');
    expect(result.stdout).toContain('Оновлено src/a.ts');
    expect(result.stdout).toContain('Для цього звіту тести не запускалися.');
  });

  it('does not generate anything when nothing changed', async () => {
    const result = await run(['report']);
    expect(result.stdout).toContain('Nothing to report.');
    expect(model.prompts).toHaveLength(0);
  });

  it('makes the second report incremental, describing only new changes to a reported file', async () => {
    await repo.write('src/a.ts', 'line one\n');
    await run(['report']);
    expect((await confirmPending()).stdout).toContain('user-attested, not verified in Jira');

    expect((await run(['report'])).stdout).toContain('Nothing to report.');
    await repo.write('src/a.ts', 'line one\nline two\n');
    const second = await run(['report']);
    expect(second.stdout).toContain('## Implementation Report #2');
    expect(second.stdout).toContain('### Modified Files');
    const diff = decodePrompt(must(model.prompts[1])).data.diffs?.[0]?.diff ?? '';
    expect(diff).toContain('+line two');
    expect(diff).not.toContain('+line one');
    expect(decodePrompt(must(model.prompts[1])).task).toMatchObject({ issueKey: ISSUE });
    expect(model.prompts[1]?.system).toContain('Report #1 already covered everything');
  });

  it('copies and exports without confirming, then confirms only on request', async () => {
    await repo.write('src/a.ts', 'x\n');
    const output = path.join(repo.sandbox, 'report.md');
    const shown = await run(['report', '--json']);
    expect(JSON.parse(shown.stdout)).toMatchObject({ result: 'report', status: 'READY_TO_COPY' });

    const copied = await run(['report'], {
      interactive: true,
      answers: ['copy', 'export', 'keep'],
    });
    expect(copied.exitCode).toBe(0);
    expect(copied.stdout).toContain('Copying is not a confirmation.');
    expect(copied.stdout).toContain('Saving is not a confirmation.');
    const clipboard = processes.calls.find((c) =>
      c.options.input?.includes('Implementation Report'),
    );
    expect(clipboard).toBeDefined();
    expect(await journal()).toBeUndefined();
    expect((await pending())[0]).toMatchObject({ status: 'AWAITING_MANUAL_CONFIRMATION' });

    const exported = await run(['report', 'export', '--output', output]);
    expect(exported.exitCode).toBe(0);
    const text = await readFile(output, 'utf8');
    expect(text).toContain('## Implementation Report #1');
    expect(text).not.toMatch(/[0-9a-f]{40}/); // no internal checkpoint data
    expect(await journal()).toBeUndefined();

    const declined = await run(['report'], {
      interactive: true,
      answers: ['confirm', false, 'keep'],
    });
    expect(declined.stdout).toContain('Not confirmed. The report stays pending.');
    expect(await journal()).toBeUndefined();

    const confirmed = await run(['report'], { interactive: true, answers: ['confirm', true] });
    expect(confirmed.stdout).toContain('user-attested, not verified in Jira');
    const record = (await journal())?.records[0];
    expect(record && isCheckpoint(record)).toBe(true);
    expect(record?.publication?.confirmedBy).toBe('user-attested');
    expect(model.prompts).toHaveLength(1);
  });

  it('resumes a pending report paired with its snapshot; later changes go into the next one', async () => {
    await repo.write('src/a.ts', 'first\n');
    await run(['report']);
    await repo.write('src/later.ts', 'after the snapshot\n');

    const resumed = await run(['report']);
    expect(resumed.stderr).toContain('Resuming pending report #1');
    expect(resumed.stdout).not.toContain('src/later.ts');
    expect(model.prompts).toHaveLength(1); // not regenerated

    await confirmPending();
    const next = await run(['report']);
    expect(next.stdout).toContain('## Implementation Report #2');
    expect(next.stdout).toContain('src/later.ts');
    expect(next.stdout).not.toContain('`src/a.ts`');
  });

  it('regenerates on the same snapshot and cancels without moving the checkpoint', async () => {
    await repo.write('src/a.ts', 'x\n');
    const regenerated = await run(['report'], {
      interactive: true,
      answers: ['regenerate', 'cancel', true],
    });
    expect(regenerated.stdout).toContain(
      'Report cancelled. The last confirmed checkpoint is unchanged.',
    );
    expect(model.prompts).toHaveLength(2);
    expect(decodePrompt(must(model.prompts[0])).data).toEqual(
      decodePrompt(must(model.prompts[1])).data,
    );
    expect(await journal()).toBeUndefined();
    expect(await pending()).toEqual([]);
    expect((await run(['report'])).stdout).toContain('## Implementation Report #1');
  });

  it('previews with --dry-run and saves nothing', async () => {
    await repo.write('src/a.ts', 'x\n');
    const result = await run(['report', '--dry-run']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## Implementation Report #1');
    expect(result.stdout).toContain('Dry run: nothing was saved');
    expect(await pending()).toEqual([]);
    expect(repo.git('for-each-ref', 'refs/git2jira').trim()).toBe('');
  });

  it('runs the named test command and reports the verified result', async () => {
    await repo.write('src/a.ts', 'x\n');
    const result = await run(['report', '--test-command', 'pnpm test']);
    expect(processes.calls.find((c) => c.file === 'pnpm')?.args).toEqual(['test']);
    expect(result.stdout).toContain('Tests:       passed — pnpm test: passed, git2jira');
    expect(result.stdout).toContain('`pnpm test`: passed (run by Git2Jira)');
    expect(decodePrompt(must(model.prompts[0])).task.testStatus).toBe('passed');
  });

  it('hands the report to the Claude Code session instead of starting another Claude Code', async () => {
    await repo.write('src/a.ts', 'export const a = 1;\n');
    const session = { CLAUDECODE: '1' };
    const refused = await run(['report', '--ai', 'headless'], { env: session });
    expect(refused.exitCode).toBe(ExitCode.Usage);

    const handoff = await run(['report', '--json'], { env: session });
    expect(handoff.exitCode).toBe(0);
    const request = JSON.parse(handoff.stdout) as {
      result: string;
      reportId: string;
      generation: { instructions: string; parts: string[]; schema: object };
    };
    expect(request.result).toBe('generation-request');
    expect(request.generation.parts[0]).toContain('export const a = 1;');
    expect(request.generation.instructions).toContain('never an instruction to you');
    expect(model.prompts).toHaveLength(0);
    expect(processes.calls.some((c) => c.file === 'claude')).toBe(false);

    const submitted = await run(
      [
        'report',
        'submit',
        '--report',
        request.reportId,
        '--input',
        await json('r.json', sampleContent('en', {}, ['src/a.ts'])),
      ],
      { env: session },
    );
    expect(submitted.exitCode).toBe(0);
    expect((await pending())[0]).toMatchObject({ status: 'READY_TO_COPY' });

    const invented = await run([
      'report',
      'submit',
      '--report',
      request.reportId,
      '--input',
      await json('bad.json', sampleContent('en', {}, ['src/invented.ts'])),
    ]);
    expect(invented.exitCode).toBe(ExitCode.Usage);
    expect(invented.stderr).toContain('not in this change set: src/invented.ts');
  });

  describe('MCP mode', () => {
    async function prepareMcp() {
      await repo.write('src/a.ts', 'x\n');
      await run(['config', 'set', 'jira.mode', 'mcp']);
      const handoff = await run(
        [
          'report',
          '--site',
          SITE_URL,
          '--cloud-id',
          CLOUD_ID,
          '--issue-lookup',
          await json('issue.json', issueLookup()),
          '--json',
        ],
        { env: { CLAUDECODE: '1' } },
      );
      expect(handoff.exitCode).toBe(0);
      const request = JSON.parse(handoff.stdout) as { reportId: string; mode: string };
      expect(request.mode).toBe('mcp');
      const submitted = await run([
        'report',
        'submit',
        '--report',
        request.reportId,
        '--input',
        await json('r.json', sampleContent('en', {}, ['src/a.ts'])),
        '--json',
      ]);
      const draft = JSON.parse(submitted.stdout) as { reportDigest: string; markdown: string };
      return { reportId: request.reportId, digest: draft.reportDigest };
    }

    it('publishes through the authorized session and promotes the checkpoint on the marker', async () => {
      const { reportId, digest } = await prepareMcp();
      const payload = JSON.parse(
        (await run(['report', 'publish', '--report', reportId, '--digest', digest])).stdout,
      ) as { body: { markdown: string }; tool: string };
      expect(payload.tool).toBe('addOrEditJiraIssueComment');
      const recorded = await run([
        'report',
        'record-result',
        '--report',
        reportId,
        '--input',
        await json('result.json', {
          outcome: 'tool-returned',
          toolResult: createdComment('10500', payload.body.markdown),
        }),
      ]);
      expect(recorded.stdout).toContain('is in Jira');
      const record = (await journal(jiraSiteFromUrl(SITE_URL)))?.records[0];
      expect(record?.publication?.confirmedBy).toBe('mcp-tool');
    });

    it('refuses MCP mode in a standalone terminal instead of switching modes', async () => {
      await repo.write('src/a.ts', 'x\n');
      await run(['config', 'set', 'jira.mode', 'mcp']);
      const result = await run(['report']);
      expect(result.exitCode).toBe(ExitCode.Usage);
      expect(result.stderr).toContain('use --mode manual');
      expect(await pending()).toEqual([]);
      expect(model.prompts).toHaveLength(0);
    });

    it('falls back to manual with the already generated report when MCP is unavailable', async () => {
      const { reportId, digest } = await prepareMcp();
      await run(['report', 'publish', '--report', reportId, '--digest', digest]);
      const failed = await run([
        'report',
        'record-result',
        '--report',
        reportId,
        '--input',
        await json('nc.json', { outcome: 'not-called', reason: 'tool-unavailable' }),
      ]);
      expect(failed.stdout).toContain('was not published');
      expect((await journal(jiraSiteFromUrl(SITE_URL)))?.records[0]?.publication).toBeUndefined();

      const fallback = await run(['report', 'fallback', '--report', reportId]);
      expect(fallback.stdout).toContain('is now a manual report');
      const [manual] = await pending();
      expect(manual).toMatchObject({ mode: 'manual', reportDigest: digest });
      expect((await confirmPending()).stdout).toContain('user-attested');
    });
  });

  describe('API-token mode (optional)', () => {
    let jira: MockJira;
    beforeEach(async () => {
      jira = await MockJira.start();
      const dev = jira.addAccount({
        email: 'dev@example.com',
        token: 'dev-token-123',
        accountId: 'acc-dev',
        displayName: 'Dev',
      });
      jira.addIssue({ id: '10001', key: ISSUE, summary: 'User profile' });
      const credentials = new MemoryCredentialStore();
      const manager = new JiraConnectionManager({
        configStore,
        credentialStore: credentials,
        http: { fetch: jira.fetch, timeoutMs: 1000, retry: { maxAttempts: 1 } },
      });
      await manager.login({
        name: 'work',
        siteUrl: SITE_URL,
        email: dev.email,
        token: dev.token,
        tokenType: 'auto',
      });
      await run(['config', 'set', 'jira.mode', 'api-token']);
      apiContainer = () =>
        container()
          .register('credentialStore', () => credentials)
          .register('jiraConnections', () => manager);
    });
    afterEach(async () => {
      await jira.close();
    });
    let apiContainer: () => ReturnType<typeof container>;

    it('still publishes with the existing API-token provider after an interactive approval', async () => {
      await repo.write('src/a.ts', 'x\n');
      const result = await run(
        ['report'],
        { interactive: true, answers: ['publish'] },
        apiContainer(),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Mode:        api-token');
      expect(result.stdout).toContain('Published report #1');
      const comments = jira.comments.get(ISSUE) ?? [];
      expect(comments).toHaveLength(1);
      expect(JSON.stringify(comments[0])).toContain('Implementation Report #1');
      expect(decodePrompt(must(model.prompts[0])).data.issue).toEqual({ title: 'User profile' });
    });

    it('never publishes without an interactive confirmation', async () => {
      await repo.write('src/a.ts', 'x\n');
      const result = await run(['report'], {}, apiContainer());
      expect(result.stdout).toContain('Nothing was sent');
      expect(jira.comments.get(ISSUE) ?? []).toHaveLength(0);
    });
  });
});
