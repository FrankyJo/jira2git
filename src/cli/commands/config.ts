import { Command, Option } from 'commander';
import { CONFIG_KEYS, parseConfigKey, type ConfigKey } from '../../config/keys';
import { findRepositoryRoot } from '../../config/paths';
import type { GlobalConfig, RepoConfig } from '../../config/schema';
import { UsageError } from '../../core/errors';
import { println, type CliContext } from '../context';

interface ScopeOptions {
  repo?: boolean;
  global?: boolean;
}

export function createConfigCommand(ctx: CliContext): Command {
  const command = new Command('config').description('Read and change Git2Jira settings.');
  const store = () => ctx.container.resolve('configStore');

  const requireRepoRoot = async (): Promise<string> => {
    const root = await findRepositoryRoot(ctx.cwd);
    if (!root) throw new UsageError('Not inside a Git repository; --repo cannot be used here.');
    return root;
  };

  const readRepoIfPresent = async (): Promise<RepoConfig | undefined> => {
    const root = await findRepositoryRoot(ctx.cwd);
    return root ? store().readRepo(root) : undefined;
  };

  command
    .command('get')
    .description('Print the effective value of a setting.')
    .argument('<key>', `setting name (${Object.keys(CONFIG_KEYS).join(', ')})`)
    .addOption(new Option('--repo', 'read only the repository configuration').conflicts('global'))
    .option('--global', 'read only the global configuration')
    .option('--json', 'print key, value, and source as JSON')
    .action(async (rawKey: string, options: ScopeOptions & { json?: boolean }) => {
      const key = parseConfigKey(rawKey);
      const definition = CONFIG_KEYS[key];
      let value: unknown;
      let source: string;
      if (options.repo) {
        value = definition.get(await store().readRepo(await requireRepoRoot()));
        source = 'repository';
      } else if (options.global) {
        value = definition.get(await store().readGlobal());
        source = 'global';
      } else {
        ({ value, source } = definition.resolve(
          await readRepoIfPresent(),
          await store().readGlobal(),
        ));
      }
      if (options.json) {
        println(ctx.stdout, JSON.stringify({ key, value: value ?? null, source }));
      } else if (value !== undefined) {
        println(ctx.stdout, formatValue(value));
      } else {
        println(ctx.stderr, `${key} is not set in the ${source} configuration.`);
      }
    });

  command
    .command('set')
    .description('Change a setting (global by default).')
    .argument('<key>', 'setting name')
    .argument('<value>', 'new value')
    .option('--repo', 'write to the repository configuration (.git2jira.json)')
    .action(async (rawKey: string, rawValue: string, options: ScopeOptions) => {
      const key = parseConfigKey(rawKey);
      const definition = CONFIG_KEYS[key];
      const value = definition.parse(rawValue);
      const file = await writeScoped(key, options, (config) => definition.set(config, value));
      println(ctx.stdout, `Set ${key} = ${formatValue(value)} in ${file}`);
    });

  command
    .command('unset')
    .description('Remove a setting (global by default).')
    .argument('<key>', 'setting name')
    .option('--repo', 'remove from the repository configuration')
    .action(async (rawKey: string, options: ScopeOptions) => {
      const key = parseConfigKey(rawKey);
      const file = await writeScoped(key, options, (config) => CONFIG_KEYS[key].unset(config));
      println(ctx.stdout, `Removed ${key} from ${file}`);
    });

  command
    .command('list')
    .description('Print all settings with their effective values and sources.')
    .option('--json', 'print as JSON')
    .action(async (options: { json?: boolean }) => {
      const repo = await readRepoIfPresent();
      const global = await store().readGlobal();
      const rows = (Object.keys(CONFIG_KEYS) as ConfigKey[]).map((key) => ({
        key,
        ...CONFIG_KEYS[key].resolve(repo, global),
      }));
      if (options.json) {
        println(ctx.stdout, JSON.stringify(rows));
      } else {
        for (const row of rows)
          println(ctx.stdout, `${row.key} = ${formatValue(row.value)} (${row.source})`);
      }
    });

  command
    .command('path')
    .description('Print the configuration file locations.')
    .action(async () => {
      const root = await findRepositoryRoot(ctx.cwd);
      println(ctx.stdout, `global:     ${store().globalPath}`);
      println(
        ctx.stdout,
        `repository: ${root ? store().repoPath(root) : '(not inside a Git repository)'}`,
      );
    });

  async function writeScoped(
    key: ConfigKey,
    options: ScopeOptions,
    update: <C extends GlobalConfig | RepoConfig>(config: C) => C,
  ): Promise<string> {
    const definition = CONFIG_KEYS[key];
    if (options.repo) {
      if (!definition.scopes.includes('repository')) {
        throw new UsageError(`${key} cannot be stored in the repository configuration.`);
      }
      const root = await requireRepoRoot();
      await store().writeRepo(root, update(await store().readRepo(root)));
      return store().repoPath(root);
    }
    await store().writeGlobal(update(await store().readGlobal()));
    return store().globalPath;
  }

  return command;
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
