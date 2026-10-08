import { z } from 'zod';
import { LanguageSchema } from '../localization/languages';

/** How reports reach Jira; see src/delivery/mode.ts. */
export const DELIVERY_MODES = ['manual', 'mcp', 'api-token'] as const;
export const DeliveryModeSchema = z.enum(DELIVERY_MODES);

/**
 * Configuration files hold preferences only. Objects are strict so that an
 * unknown key — including any attempt to store a token, password, or secret —
 * is rejected instead of silently persisted. Credentials live in the OS
 * credential store (see docs/authentication.md).
 */

export const CONFIG_SCHEMA_VERSION = 1;

/** A test command run without a shell, e.g. `pnpm test`. Arguments are split on spaces. */
export const TestCommandSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((v) => !/[;&|`$<>\n\r]/.test(v), {
    message: 'Test commands run without a shell: no ; & | ` $ < > or line breaks.',
  });

const ReportSettingsSchema = z.strictObject({
  language: LanguageSchema.optional(),
  /** Include uncommitted working-tree changes in the snapshot (default true). */
  includeUncommitted: z.boolean().optional(),
  /**
   * Test command `git2jira report` runs and cites when none is given. Global only: a
   * repository file must never be able to choose a command that Git2Jira executes.
   */
  testCommand: TestCommandSchema.optional(),
});

const RepoReportSettingsSchema = ReportSettingsSchema.omit({ testCommand: true });

/** Jira project key, e.g. `LSND`. Matches Jira's default project key rules. */
export const ProjectKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,9}$/, {
  message: 'Project keys start with an uppercase letter and contain 2-10 of A-Z, 0-9, or _.',
});

/** Name of a Jira connection, e.g. `work`. Used in credential account names. */
export const ConnectionNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, {
  message: 'Connection names use 1-32 lowercase letters, digits, "-" or "_".',
});

/**
 * One Jira Cloud site the user has signed in to. Holds no secret: the API
 * token lives in the OS credential store under `jira-api-token:<name>`.
 */
export const JiraConnectionSchema = z.strictObject({
  siteUrl: z.url({ protocol: /^https$/ }),
  authMethod: z.enum(['api-token', 'oauth']),
  /** Atlassian account email used for Basic authentication (not a secret). */
  email: z.email().optional(),
  /** Classic tokens call the site directly; scoped tokens go through api.atlassian.com. */
  tokenType: z.enum(['classic', 'scoped']).optional(),
  cloudId: z.uuid().optional(),
  /** Issues of these projects are routed to this connection when several exist. */
  projectKeys: z.array(ProjectKeySchema).min(1).optional(),
});

const JiraSettingsSchema = z.strictObject({
  /** How reports reach Jira: manual (default), mcp, or api-token. */
  mode: DeliveryModeSchema.optional(),
  /** Default Jira site for manual and MCP reports; repository `jira.site` wins. */
  site: z.url({ protocol: /^https$/ }).optional(),
  defaultConnection: ConnectionNameSchema.optional(),
  connections: z.record(ConnectionNameSchema, JiraConnectionSchema).optional(),
  /** Open the Jira comment in the browser after a publication (default false). */
  openAfterPublish: z.boolean().optional(),
});

/** Repository-level Jira preference; safe to commit because it names a site, not an account. */
const RepoJiraSettingsSchema = z.strictObject({
  site: z.url({ protocol: /^https$/ }).optional(),
  mode: DeliveryModeSchema.optional(),
});

/** Name of a Claude Code MCP server, as shown by `claude mcp list`. */
export const McpServerNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/, {
  message: 'MCP server names use 1-64 letters, digits, spaces, ".", "_" or "-".',
});

/** Which Claude Code MCP server provides Atlassian access. No secrets: OAuth stays in Claude Code. */
const McpSettingsSchema = z.strictObject({
  server: McpServerNameSchema.optional(),
});

export const GlobalConfigSchema = z.strictObject({
  version: z.literal(CONFIG_SCHEMA_VERSION).optional(),
  report: ReportSettingsSchema.optional(),
  jira: JiraSettingsSchema.optional(),
  mcp: McpSettingsSchema.optional(),
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
  report: RepoReportSettingsSchema.optional(),
  issue: IssueSettingsSchema.optional(),
  base: BaseSettingsSchema.optional(),
  jira: RepoJiraSettingsSchema.optional(),
});

export type JiraConnectionConfig = z.infer<typeof JiraConnectionSchema>;
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export type ConfigScope = 'global' | 'repository';
