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
import {
  GATED_SUBCOMMANDS,
  bashRuleMatches,
  checkAllowedTools,
  scanPermissionSettings,
} from '../../src/skill/permissions';
import { RELEASE_NOTE_SKILL } from '../../src/skill/types';
import { must } from '../helpers';

const assets = must(findSkillAssets(path.dirname(fileURLToPath(import.meta.url))));

async function shipped() {
  return loadSkillPackage(assets, '1.2.3', RELEASE_NOTE_SKILL);
}

describe('the shipped /jira-release-note package', () => {
  it('passes every package check', async () => {
    const pkg = await shipped();
    expect([...pkg.skillFiles.keys()].sort()).toEqual([
      'SKILL.md',
      'reference/format.md',
      'reference/mcp.md',
    ]);
    expect(checkSkillPackage(pkg)).toEqual([]);
    // Checked against its own name, not /jira-report's.
    const skill = must(pkg.skillFiles.get('SKILL.md')).toString();
    expect(checkSkillFile(skill)).toEqual(['SKILL.md: name must be "jira-report"']);
    expect(checkSkillFile(skill, RELEASE_NOTE_SKILL)).toEqual([]);
  });

  it('is started only by the user and resolves its run through the CLI', async () => {
    const pkg = await shipped();
    const { frontmatter, body } = parseFrontmatter(must(pkg.skillFiles.get('SKILL.md')).toString());
    expect(frontmatter.name).toBe('jira-release-note');
    expect(frontmatter['disable-model-invocation']).toBe(true);
    expect(body).toContain(
      "git2jira skill context --json --skill jira-release-note --args '$ARGUMENTS'",
    );
  });

  it('pre-approves only read-only commands; publication and confirmation always prompt', async () => {
    const pkg = await shipped();
    const { frontmatter } = parseFrontmatter(must(pkg.skillFiles.get('SKILL.md')).toString());
    const allowed = stringList(frontmatter['allowed-tools']);
    expect(checkAllowedTools(allowed)).toEqual([]);
    for (const gated of GATED_SUBCOMMANDS) {
      for (const rule of allowed) {
        expect(bashRuleMatches(rule, `git2jira ${gated} --note x --digest y`), rule).toBe(false);
      }
    }
    expect(allowed.some((t) => t.includes('addOrEditJiraIssueComment'))).toBe(false);
    expect(allowed.some((t) => /^(Write|Edit|Bash)$/.test(t))).toBe(false);
  });

  it('documents every gated release-note command it uses', async () => {
    const pkg = await shipped();
    const text = [...pkg.skillFiles.values()].map((b) => b.toString()).join('\n');
    for (const command of ['confirm', 'publish', 'record-result', 'reconcile', 'cancel']) {
      expect(text, command).toContain(`git2jira release-note ${command}`);
    }
    // The example is fictional: the package is published to npm.
    expect(must(pkg.skillFiles.get('reference/format.md')).toString()).toMatch(/fictional/i);
  });

  it('ships a read-only writer subagent', async () => {
    const pkg = await shipped();
    const { frontmatter } = parseFrontmatter(pkg.agent.toString());
    expect(frontmatter.name).toBe('jira-release-writer');
    expect(stringList(frontmatter.tools)).toEqual(['Read', 'Grep', 'Glob']);
    expect(checkAgentFile(pkg.agent.toString(), RELEASE_NOTE_SKILL)).toEqual([]);
  });
});

describe('release-note permission rules', () => {
  it('rejects allowed-tools entries that would pre-approve publication', () => {
    expect(checkAllowedTools(['Bash(git2jira release-note *)']).join()).toMatch(
      /release-note publish/,
    );
    expect(checkAllowedTools(['Bash(git2jira release-note confirm *)']).join()).toMatch(
      /release-note confirm/,
    );
    expect(checkAllowedTools(['Bash(git2jira release-note show *)'])).toEqual([]);
  });

  it('warns about settings that pre-approve release-note publication', () => {
    const warnings = scanPermissionSettings(
      [{ source: 'user', allow: ['Bash(git2jira release-note publish *)'] }],
      ['atlassian'],
    );
    expect(warnings.join()).toMatch(/pre-approves git2jira release-note publish/);
  });
});
