import type { GlobalConfig, RepoConfig } from './schema';

/** `report.includeUncommitted`: repository, then global, then true. */
export function includeUncommittedSetting(repo: RepoConfig, global: GlobalConfig): boolean {
  return repo.report?.includeUncommitted ?? global.report?.includeUncommitted ?? true;
}

/** `--test-command` values, or the global `report.testCommand` when none were given. */
export function testCommandsSetting(
  given: readonly string[] | undefined,
  global: GlobalConfig,
): string[] {
  if (given !== undefined && given.length > 0) return [...given];
  return global.report?.testCommand !== undefined ? [global.report.testCommand] : [];
}
