import { SkillConflictError, type FileSkillInstaller } from './installer';
import type {
  SkillInstallAction,
  SkillInstallResult,
  SkillInstallState,
  SkillInstaller,
  SkillLocation,
  SkillUninstallResult,
  SkillVerification,
  SkillVerifyOptions,
} from './types';

/**
 * Installs every Skill Git2Jira ships (`/jira-report`, `/jira-release-note`) as one unit.
 * Each Skill keeps its own directory, manifest, and subagent; this class only combines
 * their states and checks all of them before writing anything, so a conflict in one
 * Skill never leaves the other half-installed.
 */
export class SkillSuiteInstaller implements SkillInstaller {
  readonly location: SkillLocation;
  readonly locations: readonly SkillLocation[];

  constructor(private readonly parts: readonly [FileSkillInstaller, ...FileSkillInstaller[]]) {
    this.location = parts[0].location;
    this.locations = parts.map((p) => p.location);
  }

  async status(): Promise<SkillInstallState> {
    return this.combine(await Promise.all(this.parts.map((p) => p.status())));
  }

  async install(options: { force?: boolean } = {}): Promise<SkillInstallResult> {
    const states = await Promise.all(this.parts.map((p) => p.status()));
    this.refuseConflicts(states, options.force === true, 'install');
    const before = this.combine(states);
    const results: SkillInstallResult[] = [];
    for (const part of this.parts) results.push(await part.install(options));
    const order: SkillInstallAction[] = ['unchanged', 'installed', 'upgraded', 'repaired'];
    const action =
      before.state === 'not-installed'
        ? 'installed'
        : results.reduce<SkillInstallAction>(
            (worst, r) => (order.indexOf(r.action) > order.indexOf(worst) ? r.action : worst),
            'unchanged',
          );
    return {
      action: action === 'installed' && before.state !== 'not-installed' ? 'upgraded' : action,
      state: await this.status(),
      keptFiles: results.flatMap((r, i) => this.label(i, r.keptFiles)),
    };
  }

  async uninstall(options: { force?: boolean } = {}): Promise<SkillUninstallResult> {
    const states = await Promise.all(this.parts.map((p) => p.status()));
    this.refuseConflicts(states, options.force === true, 'uninstall');
    const results: SkillUninstallResult[] = [];
    for (const part of this.parts) results.push(await part.uninstall(options));
    return {
      removed: results.some((r) => r.removed),
      keptFiles: results.flatMap((r, i) => this.label(i, r.keptFiles)),
    };
  }

  async verify(options: SkillVerifyOptions = {}): Promise<SkillVerification> {
    const results = await Promise.all(this.parts.map((p) => p.verify(options)));
    return {
      ok: results.every((r) => r.ok),
      state: this.combine(results.map((r) => r.state)),
      problems: results.flatMap((r, i) =>
        i === 0 ? r.problems : r.problems.map((p) => `/${this.parts[i]?.spec.skill ?? ''}: ${p}`),
      ),
      // Every part scans the same permission settings.
      warnings: [...new Set(results.flatMap((r) => r.warnings))],
    };
  }

  // ---------------------------------------------------------------------------

  /** One state for all Skills: the most serious one wins. */
  private combine(states: readonly SkillInstallState[]): SkillInstallState {
    const base = { ...this.location };
    const conflicts = states.filter((s) => s.state === 'conflict');
    if (conflicts.length > 0) {
      return {
        ...base,
        state: 'conflict',
        reason: conflicts.map((c) => c.reason).join(' '),
        paths: conflicts.flatMap((c) => c.paths),
      };
    }
    const modified = states.filter((s) => s.state === 'modified');
    if (modified[0]) {
      return {
        ...base,
        state: 'modified',
        installedVersion: modified[0].installedVersion,
        modifiedFiles: modified.flatMap((m) => m.modifiedFiles),
        missingFiles: modified.flatMap((m) => m.missingFiles),
      };
    }
    if (states.every((s) => s.state === 'not-installed'))
      return { ...base, state: 'not-installed' };
    const installed = states.filter((s) => s.state === 'installed');
    const first = installed[0];
    if (first && installed.length === states.length) {
      return { ...base, state: 'installed', version: first.version };
    }
    const outdated = states.find((s) => s.state === 'outdated');
    const installedVersion =
      outdated?.installedVersion ?? (first ? `${first.version} (incomplete)` : 'unknown');
    const currentVersion = outdated?.currentVersion ?? first?.version ?? 'unknown';
    return { ...base, state: 'outdated', installedVersion, currentVersion };
  }

  private refuseConflicts(
    states: readonly SkillInstallState[],
    force: boolean,
    action: 'install' | 'uninstall',
  ): void {
    const conflict = states.find((s) => s.state === 'conflict');
    if (conflict) {
      throw new SkillConflictError(
        `${conflict.reason} Git2Jira does not overwrite or remove files it did not install: ${conflict.paths.join(', ')}. ` +
          'Nothing was changed.',
      );
    }
    const modified = states.filter((s) => s.state === 'modified');
    if (modified.length > 0 && !force) {
      const files = modified.flatMap((m) => [
        ...m.modifiedFiles,
        ...m.missingFiles.map((f) => `${f} missing`),
      ]);
      throw new SkillConflictError(
        `The installed Skills were changed since Git2Jira installed them (${files.join(', ')}). ` +
          `Run "git2jira skill ${action} --force" to ${action === 'install' ? 'replace' : 'remove'} those files.`,
      );
    }
  }

  /** Paths below other Skills' directories are shown with their Skill directory. */
  private label(index: number, files: readonly string[]): string[] {
    const skill = this.parts[index]?.spec.skill;
    return index === 0 || !skill ? [...files] : files.map((f) => `skills/${skill}/${f}`);
  }
}
