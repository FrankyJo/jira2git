import { z } from 'zod';
import { UsageError } from '../core/errors';
import { IssueKeySchema, type IssueKey } from '../git/types';
import { LanguageSchema, SUPPORTED_LANGUAGES, type Language } from '../localization/languages';

/**
 * Arguments of `/jira-report`, as typed by the user after the command name. Claude Code
 * hands them to the Skill as one string (`$ARGUMENTS`); the Skill passes that string to
 * `git2jira skill context --args`, so the CLI, not the model, decides what they mean.
 *
 * Supported: `--language en|uk`, `--mode manual|mcp`, `--issue KEY-123` (also `-l`,
 * `-m`, `-i`, and the `--name=value` form). Anything else is a usage error: a typo must
 * never turn into a report in the wrong language or for the wrong issue.
 */
export const SKILL_MODES = ['manual', 'mcp'] as const;
export type SkillMode = (typeof SKILL_MODES)[number];

export interface SkillArguments {
  language?: Language;
  mode?: SkillMode;
  issue?: IssueKey;
}

const MAX_RAW_LENGTH = 400;
/** Letters, digits, and the punctuation the options need. No quotes, no shell syntax. */
const SAFE_TOKEN = /^[A-Za-z0-9._=-]+$/;

const OPTIONS: Readonly<Record<string, keyof SkillArguments>> = {
  '--language': 'language',
  '-l': 'language',
  '--mode': 'mode',
  '-m': 'mode',
  '--issue': 'issue',
  '-i': 'issue',
};

export const SKILL_USAGE = '/jira-report [--language en|uk] [--mode manual|mcp] [--issue KEY-123]';

export function parseSkillArguments(raw: string | undefined): SkillArguments {
  const text = (raw ?? '').trim();
  // Claude Code leaves the placeholder in place when it is not substituted.
  if (text === '' || text === '$ARGUMENTS') return {};
  if (text.length > MAX_RAW_LENGTH) throw usage('The arguments are too long.');

  const tokens = text.split(/\s+/);
  const unsafe = tokens.find((token) => !SAFE_TOKEN.test(token));
  if (unsafe !== undefined) {
    throw usage(`"${printable(unsafe)}" contains characters that are not allowed.`);
  }
  const values: Partial<Record<keyof SkillArguments, string>> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    const [name = '', inline] = token.startsWith('--') ? splitOnce(token, '=') : [token];
    const key = OPTIONS[name];
    if (key === undefined) {
      throw usage(
        token.startsWith('-')
          ? `Unknown option "${printable(name)}".`
          : `Unexpected argument "${printable(token)}".`,
      );
    }
    let value = inline;
    if (value === undefined) {
      value = tokens[i + 1];
      i += 1;
    }
    if (value === undefined || value === '' || value.startsWith('-')) {
      throw usage(`${name} needs a value.`);
    }
    if (values[key] !== undefined) throw usage(`${name} was given more than once.`);
    values[key] = value;
  }

  const result: SkillArguments = {};
  if (values.language !== undefined) {
    const language = LanguageSchema.safeParse(values.language.toLowerCase());
    if (!language.success) {
      throw usage(
        `Unsupported language "${printable(values.language)}". Supported: ${SUPPORTED_LANGUAGES.join(', ')}.`,
      );
    }
    result.language = language.data;
  }
  if (values.mode !== undefined) {
    const mode = values.mode.toLowerCase();
    if (mode === 'api-token') {
      throw usage(
        'API-token mode publishes from the standalone CLI ("git2jira report --mode api-token"), not from /jira-report. ' +
          'Use --mode manual or --mode mcp.',
      );
    }
    const parsed = z.enum(SKILL_MODES).safeParse(mode);
    if (!parsed.success) {
      throw usage(
        `Unknown mode "${printable(values.mode)}". Supported: ${SKILL_MODES.join(', ')}.`,
      );
    }
    result.mode = parsed.data;
  }
  if (values.issue !== undefined) {
    const issue = IssueKeySchema.safeParse(values.issue.toUpperCase());
    if (!issue.success) {
      throw usage(`"${printable(values.issue)}" is not a Jira issue key (expected e.g. ABC-123).`);
    }
    result.issue = issue.data;
  }
  return result;
}

function splitOnce(token: string, separator: string): [string, string | undefined] {
  const at = token.indexOf(separator);
  return at < 0 ? [token, undefined] : [token.slice(0, at), token.slice(at + 1)];
}

function printable(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '?').slice(0, 60);
}

function usage(message: string): UsageError {
  return new UsageError(`${message} Usage: ${SKILL_USAGE}`);
}
