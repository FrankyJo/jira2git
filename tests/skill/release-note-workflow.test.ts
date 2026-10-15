import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLOUD_ID, createdComment, issueLookup } from '../fixtures/delivery';
import { createSkillSession, type SkillSession } from '../fixtures/skill-session';
import { sampleNote } from '../release-note/fixtures';

const SITE = 'https://example.atlassian.net';
const ACCOUNT = { account_id: 'acc-dev', name: 'Dev' };
const RESOURCES = [{ id: CLOUD_ID, url: SITE, name: 'example', scopes: ['read:jira-work'] }];
const ALL_TOOLS = [
  'mcp__atlassian__getAccessibleAtlassianResources',
  'mcp__atlassian__atlassianUserInfo',
  'mcp__atlassian__getJiraIssue',
  'mcp__atlassian__listJiraIssueComments',
  'mcp__atlassian__addOrEditJiraIssueComment',
];

interface Prepared {
  result: string;
  noteId: string;
  language: string;
  files: { path: string }[];
  generation: { instructions: string; parts: string[]; schema: unknown };
}

interface Submitted {
  noteId: string;
  status: string;
  noteDigest: string;
  markdown: string;
  toVerify: string[];
}

/**
 * /jira-release-note in a simulated Claude Code session: real Git and CLI, the shipped
 * allowed-tools of the Skill, and a permission prompt the test answers.
 */
describe('/jira-release-note session', () => {
  let s: SkillSession;
  beforeEach(async () => {
    s = await createSkillSession({ skill: 'jira-release-note' });
    await s.repo.write('src/booking/limits.ts', 'export const MAX_DAYS = 14;\n');
    await s.repo.write('src/i18n/uk.json', '{"noAccess":"Немає доступу"}\n');
    s.repo.commitAll('LSND-1234 booking');
  });
  afterEach(async () => {
    await s.cleanup();
  });

  const submit = (noteId: string) =>
    s.json<Submitted>(
      ['release-note', 'submit', '--note', noteId, '--json', '--input', '-'],
      sampleNote(),
    );

  it('manual: prepares and renders without prompts; confirmation needs the user', async () => {
    const context = await s.json<{
      skillName: string;
      language: { value: string };
      nextStep: string;
    }>(['skill', 'context', '--json', '--skill', 'jira-release-note', '--args', '']);
    expect(context).toMatchObject({
      skillName: 'jira-release-note',
      language: { value: 'uk' },
      nextStep: 'prepare',
    });
    await s.repo.write('src/wip.ts', 'export const wip = 1;\n');
    const prepared = await s.json<Prepared>([
      'release-note',
      'prepare',
      '--json',
      '--mode',
      'manual',
    ]);
    expect(prepared).toMatchObject({ result: 'prepared', language: 'uk' });
    expect(prepared.files.map((f) => f.path)).not.toContain('src/wip.ts');
    expect(prepared.generation.parts[0]).toContain('repository-data');

    const submitted = await submit(prepared.noteId);
    expect(submitted.status).toBe('READY');
    expect(submitted.markdown).toContain('В рамках цієї задачі було реалізовано');
    expect(submitted.toVerify.length).toBeGreaterThan(0);
    expect((await s.bash(['release-note', 'copy', '--note', prepared.noteId])).exitCode).toBe(0);
    expect(s.clipboard[0]).toContain('Release note: LSND-1234');
    const exported = await s.bash(['release-note', 'export', '--note', prepared.noteId]);
    expect(exported.stdout).toContain('.git/git2jira/exports/');
    expect(s.prompts).toEqual([]);

    const confirm = [
      'release-note',
      'confirm',
      '--note',
      prepared.noteId,
      '--digest',
      submitted.noteDigest,
    ];
    s.setApproval(() => false);
    const denied = await s.bash(confirm);
    expect(denied).toMatchObject({ prompted: true, denied: true });
    expect(
      (
        await s.json<{ status: string }>([
          'release-note',
          'show',
          '--note',
          prepared.noteId,
          '--format',
          'json',
        ])
      ).status,
    ).toBe('READY');

    s.setApproval(() => true);
    const confirmed = await s.bash(confirm);
    expect(confirmed.exitCode).toBe(0);
    expect(confirmed.stdout).toContain('user-attested');
  });

  it('MCP: the comment tool and every recording step go through the permission prompt', async () => {
    await s.configStore.writeGlobal({ jira: { mode: 'mcp', site: SITE } });
    const access = await s.json<{ state: string }>(['mcp', 'verify', '--json', '--input', '-'], {
      schemaVersion: 1,
      server: 'atlassian',
      tools: ALL_TOOLS,
      probes: {
        resources: { ok: true, result: RESOURCES },
        userInfo: { ok: true, result: ACCOUNT },
        issue: { ok: true, result: issueLookup() },
      },
    });
    expect(access.state).toBe('ready');
    const issue = s.mcpTool('mcp__atlassian__getJiraIssue', () => issueLookup());
    const prepared = await s.json<Prepared>(
      [
        'release-note',
        'prepare',
        '--json',
        '--mode',
        'mcp',
        '--site',
        SITE,
        '--cloud-id',
        CLOUD_ID,
        '--issue-lookup',
        '-',
      ],
      issue,
    );
    const submitted = await submit(prepared.noteId);
    expect(s.prompts).toEqual([]);

    const payload = await s.json<{ body: { markdown: string }; marker: string }>([
      'release-note',
      'publish',
      '--note',
      prepared.noteId,
      '--digest',
      submitted.noteDigest,
    ]);
    const result = s.mcpTool('mcp__atlassian__addOrEditJiraIssueComment', () =>
      createdComment('20001', payload.body.markdown),
    );
    const outcome = await s.json<{ state: string; publication: { commentUrl: string } }>(
      ['release-note', 'record-result', '--note', prepared.noteId, '--json', '--input', '-'],
      { outcome: 'tool-returned', toolResult: result },
    );
    expect(outcome.state).toBe('PUBLISHED');
    expect(outcome.publication.commentUrl).toContain('focusedCommentId=20001');
    expect(s.prompts).toEqual([
      `git2jira release-note publish --note ${prepared.noteId} --digest ${submitted.noteDigest}`,
      'mcp__atlassian__addOrEditJiraIssueComment',
      `git2jira release-note record-result --note ${prepared.noteId} --json --input -`,
    ]);
  });
});
