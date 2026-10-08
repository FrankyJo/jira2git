import { z } from 'zod';

/** Report languages supported by Git2Jira AI (ISO 639-1 codes). */
export const SUPPORTED_LANGUAGES = ['en', 'uk'] as const;

export const LanguageSchema = z.enum(SUPPORTED_LANGUAGES);

export type Language = z.infer<typeof LanguageSchema>;

export const DEFAULT_LANGUAGE: Language = 'en';

export const LANGUAGE_NAMES: Readonly<Record<Language, { english: string; native: string }>> = {
  en: { english: 'English', native: 'English' },
  uk: { english: 'Ukrainian', native: 'Українська' },
};

export function isLanguage(value: unknown): value is Language {
  return LanguageSchema.safeParse(value).success;
}
