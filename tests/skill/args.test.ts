import { describe, expect, it } from 'vitest';
import { UsageError } from '../../src/core/errors';
import { parseSkillArguments } from '../../src/skill/args';

describe('/jira-report argument parsing', () => {
  it('accepts no arguments, including an unsubstituted placeholder', () => {
    expect(parseSkillArguments('')).toEqual({});
    expect(parseSkillArguments('   ')).toEqual({});
    expect(parseSkillArguments(undefined)).toEqual({});
    expect(parseSkillArguments('$ARGUMENTS')).toEqual({});
  });

  it.each([
    ['--language en', { language: 'en' }],
    ['--language uk', { language: 'uk' }],
    ['--language=UK', { language: 'uk' }],
    ['-l uk', { language: 'uk' }],
    ['--issue LSND-1234', { issue: 'LSND-1234' }],
    ['--issue lsnd-1234', { issue: 'LSND-1234' }],
    ['--mode manual', { mode: 'manual' }],
    ['--mode mcp', { mode: 'mcp' }],
    ['--mode mcp --language uk --issue ABC-7', { mode: 'mcp', language: 'uk', issue: 'ABC-7' }],
  ])('parses %s', (raw, expected) => {
    expect(parseSkillArguments(raw)).toEqual(expected);
  });

  it.each([
    ['--language ua', /Unsupported language "ua"/],
    ['--language', /needs a value/],
    ['--language --mode manual', /needs a value/],
    ['--mode telepathy', /Unknown mode/],
    ['--mode api-token', /standalone CLI/],
    ['--issue 1234', /not a Jira issue key/],
    ['--issue LSND-0', /not a Jira issue key/],
    ['--publish', /Unknown option "--publish"/],
    ['LSND-1234', /Unexpected argument/],
    ['--language en --language uk', /more than once/],
    ["--language 'uk'", /not allowed/],
    ['--issue LSND-1;rm', /not allowed/],
    ['--issue $(whoami)', /not allowed/],
    [`--language ${'x'.repeat(500)}`, /too long/],
  ])('rejects %s', (raw, message) => {
    expect(() => parseSkillArguments(raw)).toThrow(UsageError);
    expect(() => parseSkillArguments(raw)).toThrow(message);
  });

  it('includes the usage line in every error', () => {
    expect(() => parseSkillArguments('--nope x')).toThrow(/Usage: \/jira-report/);
  });
});
