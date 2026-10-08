import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../core/errors';
import {
  CONFIG_SCHEMA_VERSION,
  GlobalConfigSchema,
  RepoConfigSchema,
  type GlobalConfig,
  type RepoConfig,
} from './schema';

export interface ConfigStore {
  readonly globalPath: string;
  repoPath(repositoryRoot: string): string;
  readGlobal(): Promise<GlobalConfig>;
  writeGlobal(config: GlobalConfig): Promise<void>;
  readRepo(repositoryRoot: string): Promise<RepoConfig>;
  writeRepo(repositoryRoot: string, config: RepoConfig): Promise<void>;
}

export interface FileConfigStoreOptions {
  globalPath: string;
  repoPath: (repositoryRoot: string) => string;
}

/** JSON-file config store. A missing file is an empty config; an invalid one is an error. */
export class FileConfigStore implements ConfigStore {
  readonly globalPath: string;
  readonly repoPath: (repositoryRoot: string) => string;

  constructor(options: FileConfigStoreOptions) {
    this.globalPath = options.globalPath;
    this.repoPath = options.repoPath;
  }

  readGlobal(): Promise<GlobalConfig> {
    return readConfigFile(this.globalPath, GlobalConfigSchema);
  }

  writeGlobal(config: GlobalConfig): Promise<void> {
    // The global config directory is private to the user.
    return writeConfigFile(this.globalPath, GlobalConfigSchema, config, {
      dirMode: 0o700,
      fileMode: 0o600,
    });
  }

  readRepo(repositoryRoot: string): Promise<RepoConfig> {
    return readConfigFile(this.repoPath(repositoryRoot), RepoConfigSchema);
  }

  writeRepo(repositoryRoot: string, config: RepoConfig): Promise<void> {
    return writeConfigFile(this.repoPath(repositoryRoot), RepoConfigSchema, config, {
      fileMode: 0o644,
    });
  }
}

export async function readConfigFile<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return schema.parse({});
    throw new ConfigError(`Cannot read configuration file ${file}.`, { cause: error });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`Configuration file ${file} is not valid JSON.`, { cause: error });
  }
  return parseConfig(file, schema, json);
}

async function writeConfigFile<T>(
  file: string,
  schema: z.ZodType<T>,
  config: T,
  modes: { dirMode?: number; fileMode: number },
): Promise<void> {
  const validated = parseConfig(file, schema, { ...config, version: CONFIG_SCHEMA_VERSION });
  await mkdir(path.dirname(file), { recursive: true, mode: modes.dirMode });
  // Write to a sibling temp file and rename, so a crash never leaves a half-written config.
  const temp = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temp, `${JSON.stringify(validated, null, 2)}\n`, { mode: modes.fileMode });
  await rename(temp, file);
}

function parseConfig<T>(file: string, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration in ${file}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
