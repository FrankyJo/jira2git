import { describe, expect, it } from 'vitest';
import { UsageError } from '../../src/core/errors';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_NAMES,
  SUPPORTED_LANGUAGES,
  isLanguage,
  resolveLanguage,
} from '../../src/localization';

describe('supported languages', () => {
  it('supports English and Ukrainian with English as default', () => {
    expect(SUPPORTED_LANGUAGES).toEqual(['en', 'uk']);
    expect(DEFAULT_LANGUAGE).toBe('en');
    expect(LANGUAGE_NAMES.uk.native).toBe('Українська');
  });

  it.each([
    ['en', true],
    ['uk', true],
    ['ua', false],
    ['EN', false],
    ['', false],
    [undefined, false],
  ])('isLanguage(%j) is %s', (value, expected) => {
    expect(isLanguage(value)).toBe(expected);
  });
});

describe('resolveLanguage precedence', () => {
  const repoConfig = { report: { language: 'uk' as const } };
  const globalConfig = { report: { language: 'en' as const } };

  it('1. explicit override wins over every config', () => {
    expect(
      resolveLanguage({ override: 'en', repoConfig, globalConfig: { report: { language: 'uk' } } }),
    ).toEqual({
      language: 'en',
      source: 'override',
    });
  });

  it('2. repository config wins over global config', () => {
    expect(resolveLanguage({ repoConfig, globalConfig })).toEqual({
      language: 'uk',
      source: 'repository',
    });
  });

  it('3. global config applies when the repository does not set a language', () => {
    expect(
      resolveLanguage({ repoConfig: { report: {} }, globalConfig: { report: { language: 'uk' } } }),
    ).toEqual({ language: 'uk', source: 'global' });
  });

  it('4. falls back to English when nothing is configured', () => {
    expect(resolveLanguage({})).toEqual({ language: 'en', source: 'default' });
    expect(resolveLanguage({ repoConfig: {}, globalConfig: {} })).toEqual({
      language: 'en',
      source: 'default',
    });
  });

  it('normalizes override case and whitespace', () => {
    expect(resolveLanguage({ override: ' UK ' })).toEqual({ language: 'uk', source: 'override' });
  });

  it.each(['ua', 'de', '', 'english'])(
    'rejects unsupported override %j instead of falling back',
    (override) => {
      expect(() => resolveLanguage({ override, globalConfig })).toThrow(UsageError);
    },
  );
});
