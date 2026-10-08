import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFrontmatter, stringList } from '../../src/skill/frontmatter';
import {
  checkAgentFile,
  checkSkillFile,
  checkSkillPackage,
  findSkillAssets,
  loadSkillPackage,
} from '../../src/skill/package';
import { GATED_SUBCOMMANDS, bashRuleMatches } from '../../src/skill/permissions';
import { must } from '../helpers';

const here = path.dirname(fileURLToPath(import.meta.url));

async function shipped() {
  const assets = must(findSkillAssets(here), 'skill assets');
  return loadSkillPackage(assets, '1.2.3');
}

describe('the shipped Skill package (discovery)', () => {
  it('is found from the sources and the build, and passes every check', async () => {
    const assets = must(findSkillAssets(here));
    expect(assets).toBe(path.resolve(here, '..', '..', 'skill'));
    expect(findSkillAssets(path.resolve(here, '..', '..', 'dist'))).toBe(assets);
    const pkg = await shipped();
    expect([...pkg.skillFiles.keys()].sort()).toEqual([
      'SKILL.md',
      'reference/manual.md',
      'reference/mcp.md',
      'reference/recovery.md',
      'reference/report-contract.md',
    ]);
    expect(checkSkillPackage(pkg)).toEqual([]);
  });

  it('has the frontmatter Claude Code needs to list /jira-report', async () => {
    const pkg = await shipped();
    const { frontmatter, body } = parseFrontmatter(must(pkg.skillFiles.get('SKILL.md')).toString());
    expect(frontmatter.name).toBe('jira-report');
    expect(typeof frontmatter.description).toBe('string');
    expect(frontmatter['argument-hint']).toBe(
      '[--language en|uk] [--mode manual|mcp] [--issue KEY-123]',
    );
    // Only the user starts it: the model must not decide to publish a report.
    expect(frontmatter['disable-model-invocation']).toBe(true);
    expect(body).toContain("git2jira skill context --json --args '$ARGUMENTS'");
  });

  it('pre-approves no command that moves a checkpoint or writes to Jira', async () => {
    const pkg = await shipped();
    const { frontmatter } = parseFrontmatter(must(pkg.skillFiles.get('SKILL.md')).toString());
    const allowed = stringList(frontmatter['allowed-tools']);
    expect(allowed.length).toBeGreaterThan(5);
    for (const gated of GATED_SUBCOMMANDS) {
      for (const rule of allowed) {
        expect(bashRuleMatches(rule, `git2jira ${gated} --report x --digest y`)).toBe(false);
      }
    }
    expect(allowed.some((t) => t.includes('addOrEditJiraIssueComment'))).toBe(false);
    expect(allowed.some((t) => /^(Write|Edit|Bash)$/.test(t))).toBe(false);
  });

  it('ships a read-only subagent that cannot publish', async () => {
    const pkg = await shipped();
    const { frontmatter, body } = parseFrontmatter(pkg.agent.toString());
    expect(frontmatter.name).toBe('jira-reporter');
    expect(stringList(frontmatter.tools)).toEqual(['Read', 'Grep', 'Glob']);
    expect(body).toMatch(/untrusted data/);
    expect(checkAgentFile(pkg.agent.toString())).toEqual([]);
  });

  it('documents both delivery modes, the receipt, and every gated command it uses', async () => {
    const pkg = await shipped();
    const text = [...pkg.skillFiles.values()]
      .map((b) => b.toString())
      .join('\n')
      .replace(/\s+/g, ' ');
    for (const command of [
      'report prepare',
      'report submit',
      'report confirm',
      'report publish',
      'report record-result',
      'report reconcile',
      'report verify-comment',
      'report fallback',
      'report receipt',
      'mcp verify',
    ]) {
      expect(text).toContain(`git2jira ${command}`);
    }
    expect(text).toContain('AskUserQuestion');
    expect(text).toContain('No new changes since the previous report.');
    expect(text).toContain(
      'Atlassian MCP is unavailable. You can generate and copy the report using Manual mode.',
    );
    expect(text).toMatch(/Never pass a comment id/);
  });
});

describe('Skill file checks', () => {
  const valid = [
    '---',
    'name: jira-report',
    'description: Writes reports.',
    "argument-hint: '[--language en|uk]'",
    'disable-model-invocation: true',
    'allowed-tools:',
    '  - Bash(git2jira report prepare *)',
    '---',
    'Run git2jira skill context --args "$ARGUMENTS".',
  ].join('\n');

  it('accepts a minimal valid Skill', () => {
    expect(checkSkillFile(valid)).toEqual([]);
  });

  it.each([
    ['Bash(git2jira report confirm *)', /pre-approve "report confirm"/],
    ['Bash(git2jira *)', /pre-approve/],
    ['Bash(git2jira:*)', /pre-approve/],
    ['Bash', /pre-approve/],
    ['Write', /not allowed/],
    ['mcp__atlassian__addOrEditJiraIssueComment', /not a read-only Atlassian tool/],
    ['mcp__atlassian', /not a read-only Atlassian tool/],
    ['Bash(rm -rf *)', /not one of the read-only git2jira subcommands/],
  ])('rejects allowed-tools entry %s', (entry, message) => {
    const broken = valid.replace('  - Bash(git2jira report prepare *)', `  - ${entry}`);
    expect(checkSkillFile(broken).join('\n')).toMatch(message);
  });

  it('requires user-only invocation and a name', () => {
    expect(checkSkillFile(valid.replace('disable-model-invocation: true', '')).join()).toMatch(
      /disable-model-invocation/,
    );
    expect(checkSkillFile(valid.replace('name: jira-report', 'name: other')).join()).toMatch(
      /name must be/,
    );
    expect(checkSkillFile('no frontmatter')).toEqual(['SKILL.md: missing frontmatter']);
  });

  it('rejects a subagent that can write or inherits every tool', () => {
    const agent = (tools: string) =>
      `---\nname: jira-reporter\ndescription: x\n${tools}\n---\nbody\n`;
    expect(checkAgentFile(agent('tools: Read, Grep'))).toEqual([]);
    expect(checkAgentFile(agent('tools: Read, Bash')).join()).toMatch(/"Bash" is not read-only/);
    expect(checkAgentFile(agent('tools: Read, mcp__atlassian__getJiraIssue')).join()).toMatch(
      /not read-only/,
    );
    expect(checkAgentFile(agent('model: inherit')).join()).toMatch(/listed explicitly/);
  });
});
