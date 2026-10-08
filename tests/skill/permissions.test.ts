import { describe, expect, it } from 'vitest';
import {
  bashRuleMatches,
  scanPermissionSettings,
  toolRuleMatches,
} from '../../src/skill/permissions';

describe('permission rule matching', () => {
  it.each([
    ['Bash', 'git2jira report confirm', true],
    ['Bash(*)', 'anything', true],
    ['Bash(git2jira:*)', 'git2jira report confirm --report x', true],
    ['Bash(git2jira *)', 'git2jira report publish --report x', true],
    ['Bash(git2jira report prepare *)', 'git2jira report prepare --json', true],
    ['Bash(git2jira report prepare *)', 'git2jira report prepare', true],
    ['Bash(git2jira report prepare *)', 'git2jira report confirm --report x', false],
    ['Bash(git2jira report show *)', 'git2jira report showx', false],
    ['Read', 'git2jira report confirm', false],
  ])('%s covers "%s": %s', (rule, command, expected) => {
    expect(bashRuleMatches(rule, command)).toBe(expected);
  });

  it.each([
    ['mcp__atlassian', 'mcp__atlassian__addOrEditJiraIssueComment', true],
    ['mcp__atlassian__*', 'mcp__atlassian__addOrEditJiraIssueComment', true],
    ['mcp__atlassian__getJiraIssue', 'mcp__atlassian__addOrEditJiraIssueComment', false],
    ['mcp__other', 'mcp__atlassian__addOrEditJiraIssueComment', false],
  ])('%s covers %s: %s', (rule, tool, expected) => {
    expect(toolRuleMatches(rule, tool)).toBe(expected);
  });
});

describe('permission settings scan', () => {
  it('warns about rules and modes that would skip approvals', () => {
    const warnings = scanPermissionSettings(
      [
        {
          source: 'user',
          allow: ['Bash(git2jira:*)', 'Bash(git status *)', 'mcp__rovo'],
          defaultMode: 'bypassPermissions',
        },
        { source: 'project', allow: ['Bash(git2jira report show *)'] },
      ],
      ['rovo'],
    );
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toMatch(/bypassPermissions/);
    expect(warnings.join('\n')).toMatch(/"Bash\(git2jira:\*\)" pre-approves .*report confirm/);
    expect(warnings.join('\n')).toMatch(/"mcp__rovo" pre-approves the Jira comment tool/);
  });

  it('is quiet for the shipped read-only rules', () => {
    expect(
      scanPermissionSettings(
        [{ source: 'user', allow: ['Bash(git2jira report prepare *)', 'Read'] }],
        ['atlassian'],
      ),
    ).toEqual([]);
  });
});
