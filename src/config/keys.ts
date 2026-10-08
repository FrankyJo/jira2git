import { z } from 'zod';
import { UsageError } from '../core/errors';
import { LanguageSchema } from '../localization/languages';
import { resolveLanguage } from '../localization/resolve';
import {
  BranchNameSchema,
  ConnectionNameSchema,
  DELIVERY_MODES,
  DeliveryModeSchema,
  McpServerNameSchema,
  TestCommandSchema,
  type ConfigScope,
  type GlobalConfig,
  type RepoConfig,
} from './schema';

export type ConfigValueSource = 'repository' | 'global' | 'default';

export interface ResolvedConfigValue {
  value: unknown;
  source: ConfigValueSource;
}

/**
 * Keys that `git2jira config get|set|unset` can address. Each entry declares
 * which scopes may hold it. Keys are added here as later phases need them.
 */
export interface ConfigKeyDefinition {
  description: string;
  scopes: readonly ConfigScope[];
  parse(raw: string): unknown;
  get(config: GlobalConfig | RepoConfig): unknown;
  /** Effective value across scopes: repository, then global, then default. */
  resolve(repo: RepoConfig | undefined, global: GlobalConfig): ResolvedConfigValue;
  set<C extends GlobalConfig | RepoConfig>(config: C, value: unknown): C;
  unset<C extends GlobalConfig | RepoConfig>(config: C): C;
}

const reportLanguage: ConfigKeyDefinition = {
  description: 'Language of generated Jira reports (en, uk).',
  scopes: ['global', 'repository'],
  parse(raw) {
    const result = LanguageSchema.safeParse(raw.trim().toLowerCase());
    if (!result.success) {
      throw new UsageError(
        `Invalid value "${raw}" for report.language. Supported: ${LanguageSchema.options.join(', ')}.`,
      );
    }
    return result.data;
  },
  get: (config) => config.report?.language,
  resolve(repo, global) {
    const { language, source } = resolveLanguage({ repoConfig: repo, globalConfig: global });
    return { value: language, source: source === 'override' ? 'default' : source };
  },
  set: (config, value) => ({
    ...config,
    report: { ...config.report, language: LanguageSchema.parse(value) },
  }),
  unset: (config) => {
    const { language: _removed, ...rest } = config.report ?? {};
    return { ...config, report: rest };
  },
};

const baseBranch: ConfigKeyDefinition = {
  description: 'Branch the first report of an issue is compared against (repository only).',
  scopes: ['repository'],
  parse(raw) {
    const result = BranchNameSchema.safeParse(raw);
    if (!result.success)
      throw new UsageError(`Invalid value "${raw}" for base.branch: not a valid branch name.`);
    return result.data;
  },
  get: (config) => ('base' in config ? config.base?.branch : undefined),
  resolve: (repo) =>
    repo?.base?.branch !== undefined
      ? { value: repo.base.branch, source: 'repository' }
      : { value: undefined, source: 'default' },
  set: (config, value) => ({ ...config, base: { branch: BranchNameSchema.parse(value) } }),
  unset: (config) => {
    const { base: _removed, ...rest } = config as RepoConfig;
    return rest as typeof config;
  },
};

const SiteUrlSchema = z.url({ protocol: /^https$/ });

const jiraSite: ConfigKeyDefinition = {
  description:
    'Jira Cloud site for reports (repository, or global default for manual and MCP modes).',
  scopes: ['global', 'repository'],
  parse(raw) {
    const result = SiteUrlSchema.safeParse(raw.trim());
    if (!result.success)
      throw new UsageError(`Invalid value "${raw}" for jira.site: expected an https:// URL.`);
    return new URL(result.data).origin;
  },
  get: (config) => config.jira?.site,
  resolve: (repo, global) =>
    repo?.jira?.site !== undefined
      ? { value: repo.jira.site, source: 'repository' }
      : global.jira?.site !== undefined
        ? { value: global.jira.site, source: 'global' }
        : { value: undefined, source: 'default' },
  set: (config, value) => ({
    ...config,
    jira: { ...config.jira, site: SiteUrlSchema.parse(value) },
  }),
  unset: (config) => withJira(config, 'site'),
};

const jiraMode: ConfigKeyDefinition = {
  description: `How reports reach Jira (${DELIVERY_MODES.join(', ')}; default manual).`,
  scopes: ['global', 'repository'],
  parse(raw) {
    const result = DeliveryModeSchema.safeParse(raw.trim().toLowerCase());
    if (!result.success) {
      throw new UsageError(
        `Invalid value "${raw}" for jira.mode. Supported: ${DELIVERY_MODES.join(', ')}.`,
      );
    }
    return result.data;
  },
  get: (config) => config.jira?.mode,
  resolve: (repo, global) =>
    repo?.jira?.mode !== undefined
      ? { value: repo.jira.mode, source: 'repository' }
      : global.jira?.mode !== undefined
        ? { value: global.jira.mode, source: 'global' }
        : { value: 'manual', source: 'default' },
  set: (config, value) => ({
    ...config,
    jira: { ...config.jira, mode: DeliveryModeSchema.parse(value) },
  }),
  unset: (config) => withJira(config, 'mode'),
};

/** Removes one field of `jira`, and `jira` itself when nothing is left. */
function withJira<C extends GlobalConfig | RepoConfig>(config: C, field: 'site' | 'mode'): C {
  const { [field]: _removed, ...rest } = (config.jira ?? {}) as Record<string, unknown>;
  const { jira: _jira, ...others } = config;
  return (Object.keys(rest).length > 0 ? { ...others, jira: rest } : others) as C;
}

const mcpServer: ConfigKeyDefinition = {
  description: 'Claude Code MCP server that provides Atlassian access (global only).',
  scopes: ['global'],
  parse(raw) {
    const result = McpServerNameSchema.safeParse(raw.trim());
    if (!result.success) throw new UsageError(`Invalid value "${raw}" for mcp.server.`);
    return result.data;
  },
  get: (config) => (config as GlobalConfig).mcp?.server,
  resolve: (_repo, global) =>
    global.mcp?.server !== undefined
      ? { value: global.mcp.server, source: 'global' }
      : { value: undefined, source: 'default' },
  set: (config, value) => ({ ...config, mcp: { server: McpServerNameSchema.parse(value) } }),
  unset: (config) => {
    const { mcp: _removed, ...rest } = config as GlobalConfig;
    return rest as typeof config;
  },
};

const defaultConnection: ConfigKeyDefinition = {
  description: 'Jira connection used when nothing else selects one (global only).',
  scopes: ['global'],
  parse(raw) {
    const result = ConnectionNameSchema.safeParse(raw.trim());
    if (!result.success) throw new UsageError(`Invalid value "${raw}" for jira.defaultConnection.`);
    return result.data;
  },
  get: (config) => (config as GlobalConfig).jira?.defaultConnection,
  resolve: (_repo, global) =>
    global.jira?.defaultConnection !== undefined
      ? { value: global.jira.defaultConnection, source: 'global' }
      : { value: undefined, source: 'default' },
  set: (config, value) => {
    const global = config as GlobalConfig;
    const name = ConnectionNameSchema.parse(value);
    if (!global.jira?.connections?.[name]) {
      throw new UsageError(`No Jira connection named "${name}". Run "git2jira login" first.`);
    }
    return { ...config, jira: { ...global.jira, defaultConnection: name } };
  },
  unset: (config) => {
    const { defaultConnection: _removed, ...rest } = (config as GlobalConfig).jira ?? {};
    return { ...config, jira: rest };
  },
};

function parseBoolean(key: string, raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(value)) return true;
  if (['false', 'no', 'off', '0'].includes(value)) return false;
  throw new UsageError(`Invalid value "${raw}" for ${key}: expected true or false.`);
}

const includeUncommitted: ConfigKeyDefinition = {
  description: 'Include uncommitted working-tree changes in reports (true or false; default true).',
  scopes: ['global', 'repository'],
  parse: (raw) => parseBoolean('report.includeUncommitted', raw),
  get: (config) => config.report?.includeUncommitted,
  resolve: (repo, global) =>
    repo?.report?.includeUncommitted !== undefined
      ? { value: repo.report.includeUncommitted, source: 'repository' }
      : global.report?.includeUncommitted !== undefined
        ? { value: global.report.includeUncommitted, source: 'global' }
        : { value: true, source: 'default' },
  set: (config, value) => ({
    ...config,
    report: { ...config.report, includeUncommitted: z.boolean().parse(value) },
  }),
  unset: (config) => {
    const { includeUncommitted: _removed, ...rest } = config.report ?? {};
    return { ...config, report: rest };
  },
};

const testCommand: ConfigKeyDefinition = {
  description:
    'Test command "git2jira report" runs (no shell) when --test-command is not given (global only).',
  scopes: ['global'],
  parse(raw) {
    const result = TestCommandSchema.safeParse(raw);
    if (!result.success) {
      throw new UsageError(
        `Invalid value for report.testCommand: ${result.error.issues[0]?.message ?? 'invalid'}`,
      );
    }
    return result.data;
  },
  get: (config) => (config as GlobalConfig).report?.testCommand,
  resolve: (_repo, global) =>
    global.report?.testCommand !== undefined
      ? { value: global.report.testCommand, source: 'global' }
      : { value: undefined, source: 'default' },
  set: (config, value) => ({
    ...config,
    report: { ...config.report, testCommand: TestCommandSchema.parse(value) },
  }),
  unset: (config) => {
    const { testCommand: _removed, ...rest } = (config as GlobalConfig).report ?? {};
    return { ...config, report: rest };
  },
};

const openAfterPublish: ConfigKeyDefinition = {
  description:
    'Open the Jira comment in the browser after publication (true or false; global only).',
  scopes: ['global'],
  parse: (raw) => parseBoolean('jira.openAfterPublish', raw),
  get: (config) => (config as GlobalConfig).jira?.openAfterPublish,
  resolve: (_repo, global) =>
    global.jira?.openAfterPublish !== undefined
      ? { value: global.jira.openAfterPublish, source: 'global' }
      : { value: false, source: 'default' },
  set: (config, value) => ({
    ...config,
    jira: { ...config.jira, openAfterPublish: z.boolean().parse(value) },
  }),
  unset: (config) => {
    const { openAfterPublish: _removed, ...rest } = (config as GlobalConfig).jira ?? {};
    return { ...config, jira: rest };
  },
};

export const CONFIG_KEYS = {
  'report.language': reportLanguage,
  'report.includeUncommitted': includeUncommitted,
  'report.testCommand': testCommand,
  'jira.openAfterPublish': openAfterPublish,
  'base.branch': baseBranch,
  'jira.mode': jiraMode,
  'jira.site': jiraSite,
  'jira.defaultConnection': defaultConnection,
  'mcp.server': mcpServer,
} as const satisfies Record<string, ConfigKeyDefinition>;

export type ConfigKey = keyof typeof CONFIG_KEYS;

const ConfigKeySchema = z.enum(Object.keys(CONFIG_KEYS) as [ConfigKey, ...ConfigKey[]]);

export function parseConfigKey(raw: string): ConfigKey {
  const result = ConfigKeySchema.safeParse(raw);
  if (!result.success) {
    throw new UsageError(
      `Unknown configuration key "${raw}". Available keys: ${ConfigKeySchema.options.join(', ')}.`,
    );
  }
  return result.data;
}
