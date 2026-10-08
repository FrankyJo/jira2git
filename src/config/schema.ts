import { z } from 'zod';
import { LanguageSchema } from '../localization/languages';

/**
 * Configuration files hold preferences only. Objects are strict so that an
 * unknown key — including any attempt to store a token, password, or secret —
 * is rejected instead of silently persisted. Credentials live in the OS
 * credential store (see docs/authentication.md).
 */

export const CONFIG_SCHEMA_VERSION = 1;

const ReportSettingsSchema = z.strictObject({
  language: LanguageSchema.optional(),
});

/** Jira project key, e.g. `LSND`. Matches Jira's default project key rules. */
export const ProjectKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,9}$/, {
  message: 'Project keys start with an uppercase letter and contain 2-10 of A-Z, 0-9, or _.',
});

const JiraSettingsSchema = z.strictObject({
  /** Jira Cloud site, e.g. https://example.atlassian.net. Used from Phase 2. */
  siteUrl: z.url({ protocol: /^https$/ }).optional(),
  /** Selected JiraAuthProvider. Used from Phase 2. */
  authMethod: z.enum(['api-token', 'oauth']).optional(),
});

export const GlobalConfigSchema = z.strictObject({
  version: z.literal(CONFIG_SCHEMA_VERSION).optional(),
  report: ReportSettingsSchema.optional(),
  jira: JiraSettingsSchema.optional(),
});

const IssueSettingsSchema = z.strictObject({
  /** Restricts issue key detection to these projects. Used from Phase 1. */
  projectKeys: z.array(ProjectKeySchema).min(1).optional(),
});

/** A branch or ref name as typed by a user; existence is checked against Git at use. */
export const BranchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((v) => !v.startsWith('-') && !/[\s~^:?*[\\]|\.\.|@\{/.test(v), {
    message: 'Not a valid Git branch name.',
  });

const BaseSettingsSchema = z.strictObject({
  /** Branch the first report of an issue is compared against, e.g. `develop` or `origin/main`. */
  branch: BranchNameSchema.optional(),
});

/** Repository config is safe to commit: it must never contain secrets. */
export const RepoConfigSchema = z.strictObject({
  version: z.literal(CONFIG_SCHEMA_VERSION).optional(),
  report: ReportSettingsSchema.optional(),
  issue: IssueSettingsSchema.optional(),
  base: BaseSettingsSchema.optional(),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export type ConfigScope = 'global' | 'repository';
