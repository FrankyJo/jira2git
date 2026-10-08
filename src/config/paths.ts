import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const APP_DIR_NAME = 'git2jira';
export const GLOBAL_CONFIG_FILE = 'config.json';
export const REPO_CONFIG_FILE = '.git2jira.json';

export interface PathEnvironment {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  homeDir: string;
}

export function currentPathEnvironment(): PathEnvironment {
  return { env: process.env, platform: process.platform, homeDir: homedir() };
}

/**
 * Global configuration directory. `GIT2JIRA_CONFIG_DIR` overrides everything;
 * otherwise `%APPDATA%\git2jira` on Windows and `$XDG_CONFIG_HOME/git2jira`
 * (default `~/.config/git2jira`) elsewhere.
 */
export function globalConfigDir({ env, platform, homeDir }: PathEnvironment): string {
  const override = env.GIT2JIRA_CONFIG_DIR;
  if (override) return path.resolve(override);
  if (platform === 'win32') {
    return path.join(env.APPDATA ?? path.join(homeDir, 'AppData', 'Roaming'), APP_DIR_NAME);
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(homeDir, '.config'), APP_DIR_NAME);
}

export function globalConfigPath(environment: PathEnvironment): string {
  return path.join(globalConfigDir(environment), GLOBAL_CONFIG_FILE);
}

export function repoConfigPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, REPO_CONFIG_FILE);
}

/**
 * Locates the enclosing working tree by looking for a `.git` entry (directory,
 * or file for worktrees and submodules). This is only used to find the
 * repository config file; full Git discovery via the git binary is Phase 1.
 */
export async function findRepositoryRoot(startDir: string): Promise<string | undefined> {
  let current = path.resolve(startDir);
  for (;;) {
    if (await exists(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
