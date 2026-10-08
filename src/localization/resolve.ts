import { DEFAULT_LANGUAGE, LanguageSchema, type Language } from './languages';
import { UsageError } from '../core/errors';
import type { GlobalConfig, RepoConfig } from '../config/schema';

/** Where the effective language came from, in precedence order. */
export type LanguageSource = 'override' | 'repository' | 'global' | 'default';

export interface LanguageResolutionInput {
  /** Raw runtime value, e.g. from `--language`. Validated here. */
  override?: string | undefined;
  repoConfig?: RepoConfig | undefined;
  globalConfig?: GlobalConfig | undefined;
}

export interface ResolvedLanguage {
  language: Language;
  source: LanguageSource;
}

/**
 * Resolves the report language. Precedence:
 * 1. explicit runtime override, 2. repository config, 3. global config, 4. English.
 *
 * An invalid override is a usage error rather than a silent fallback, so a typo
 * such as `--language ua` never produces a report in an unexpected language.
 */
export function resolveLanguage(input: LanguageResolutionInput): ResolvedLanguage {
  if (input.override !== undefined) {
    const parsed = LanguageSchema.safeParse(input.override.trim().toLowerCase());
    if (!parsed.success) {
      throw new UsageError(
        `Unsupported language "${input.override}". Supported languages: ${LanguageSchema.options.join(', ')}.`,
      );
    }
    return { language: parsed.data, source: 'override' };
  }

  const repoLanguage = input.repoConfig?.report?.language;
  if (repoLanguage !== undefined) return { language: repoLanguage, source: 'repository' };

  const globalLanguage = input.globalConfig?.report?.language;
  if (globalLanguage !== undefined) return { language: globalLanguage, source: 'global' };

  return { language: DEFAULT_LANGUAGE, source: 'default' };
}
