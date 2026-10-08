import { z } from 'zod';
import { UsageError } from '../core/errors';
import { LanguageSchema } from '../localization/languages';
import { resolveLanguage } from '../localization/resolve';
import { BranchNameSchema, type ConfigScope, type GlobalConfig, type RepoConfig } from './schema';

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

export const CONFIG_KEYS = {
  'report.language': reportLanguage,
  'base.branch': baseBranch,
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
