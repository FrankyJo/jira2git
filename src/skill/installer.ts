import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Git2JiraError } from '../core/errors';
import {
  SKILL_ENTRY,
  checkAgentFile,
  checkSkillFile,
  checkSkillPackage,
  sha256,
  type SkillPackage,
} from './package';
import { scanPermissionSettings, type PermissionSettings } from './permissions';
import {
  AGENT_NAME,
  MANIFEST_FILE,
  SKILL_NAME,
  type SkillInstallResult,
  type SkillInstallState,
  type SkillInstaller,
  type SkillLocation,
  type SkillUninstallResult,
  type SkillVerification,
  type SkillVerifyOptions,
} from './types';

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const RelativePathSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\\'), {
    message: 'unsafe path',
  });

/** Ownership record in the Skill directory. Lists every file Git2Jira wrote. */
export const SkillManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  package: z.literal('git2jira-ai'),
  skill: z.literal(SKILL_NAME),
  version: z.string().min(1).max(50),
  installedAt: z.iso.datetime(),
  files: z.record(RelativePathSchema, Sha256Schema),
  agent: z.strictObject({ name: z.literal(AGENT_NAME), sha256: Sha256Schema }),
});

export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export class SkillConflictError extends Git2JiraError {}

export interface FileSkillInstallerOptions {
  /** Claude Code's user directory (`~/.claude`, or `CLAUDE_CONFIG_DIR`). */
  claudeHome: string;
  /** Loads the package shipped with this CLI. */
  loadPackage: () => Promise<SkillPackage>;
  now?: () => Date;
}

/**
 * Installs `/jira-report` for the current user: `<claude home>/skills/jira-report/` and
 * `<claude home>/agents/jira-reporter.md`. Claude Code discovers both in every project,
 * so nothing is copied into repositories.
 *
 * Ownership is proven by the manifest and the file hashes in it. Git2Jira never
 * overwrites or deletes a file it did not write, and replaces files the user changed
 * only when asked to (`force`).
 */
export class FileSkillInstaller implements SkillInstaller {
  readonly location: SkillLocation;
  private readonly now: () => Date;
  private loaded: Promise<SkillPackage> | undefined;

  constructor(private readonly options: FileSkillInstallerOptions) {
    this.location = {
      skillDir: path.join(options.claudeHome, 'skills', SKILL_NAME),
      agentPath: path.join(options.claudeHome, 'agents', `${AGENT_NAME}.md`),
    };
    this.now = options.now ?? (() => new Date());
  }

  private package(): Promise<SkillPackage> {
    this.loaded ??= this.options.loadPackage();
    return this.loaded;
  }

  async status(): Promise<SkillInstallState> {
    return (await this.inspect()).state;
  }

  async install(options: { force?: boolean } = {}): Promise<SkillInstallResult> {
    const pkg = await this.package();
    const packageProblems = checkSkillPackage(pkg);
    if (packageProblems.length > 0) {
      throw new Git2JiraError(
        `The Skill package shipped with this CLI is invalid: ${packageProblems.join('; ')}`,
      );
    }
    const { state, manifest } = await this.inspect();
    switch (state.state) {
      case 'conflict':
        throw new SkillConflictError(
          `${state.reason} Git2Jira does not overwrite files it did not install: ${state.paths.join(', ')}. ` +
            'Move or remove them yourself, then run "git2jira skill install" again.',
        );
      case 'modified':
        if (!options.force) {
          throw new SkillConflictError(
            `The installed Skill was changed since Git2Jira installed it (${[
              ...state.modifiedFiles,
              ...state.missingFiles.map((f) => `${f} missing`),
            ].join(', ')}). Run "git2jira skill install --force" to replace those files.`,
          );
        }
        break;
      case 'installed':
        return { action: 'unchanged', state, keptFiles: await this.unmanagedFiles(manifest) };
      default:
        break;
    }

    if (state.state === 'not-installed') await this.freshInstall(pkg);
    else await this.upgradeInPlace(pkg, manifest);
    await writeAtomic(this.location.agentPath, pkg.agent);

    const after = await this.status();
    if (after.state !== 'installed') {
      throw new Git2JiraError(
        `The Skill was written, but checking it afterwards found it ${after.state}.`,
      );
    }
    return {
      action:
        state.state === 'not-installed'
          ? 'installed'
          : state.state === 'outdated'
            ? 'upgraded'
            : 'repaired',
      state: after,
      keptFiles: await this.unmanagedFiles(await this.readManifest()),
    };
  }

  async uninstall(options: { force?: boolean } = {}): Promise<SkillUninstallResult> {
    const { state, manifest } = await this.inspect();
    if (state.state === 'not-installed') return { removed: false, keptFiles: [] };
    if (state.state === 'conflict') {
      throw new SkillConflictError(
        `${state.reason} Git2Jira removes only what it installed; nothing was removed.`,
      );
    }
    if (state.state === 'modified' && !options.force) {
      throw new SkillConflictError(
        `The installed Skill was changed since Git2Jira installed it (${state.modifiedFiles.join(', ')}). ` +
          'Run "git2jira skill uninstall --force" to remove it anyway.',
      );
    }
    if (!manifest) return { removed: false, keptFiles: [] };

    for (const relative of Object.keys(manifest.files)) {
      await rm(path.join(this.location.skillDir, relative), { force: true });
    }
    const agent = await readOptional(this.location.agentPath);
    if (agent && (options.force || sha256(agent) === manifest.agent.sha256)) {
      await rm(this.location.agentPath, { force: true });
    }
    await rm(path.join(this.location.skillDir, MANIFEST_FILE), { force: true });
    const keptFiles = await listFiles(this.location.skillDir);
    await removeEmptyDirs(this.location.skillDir);
    return { removed: true, keptFiles };
  }

  async verify(options: SkillVerifyOptions = {}): Promise<SkillVerification> {
    const state = await this.status();
    const problems: string[] = [];
    switch (state.state) {
      case 'installed': {
        const skill = await readOptional(path.join(this.location.skillDir, SKILL_ENTRY));
        const agent = await readOptional(this.location.agentPath);
        problems.push(...checkSkillFile(skill?.toString('utf8') ?? ''));
        problems.push(...checkAgentFile(agent?.toString('utf8') ?? ''));
        break;
      }
      case 'not-installed':
        problems.push('The Skill is not installed. Run "git2jira skill install".');
        break;
      case 'outdated':
        problems.push(
          `The installed Skill is version ${state.installedVersion}; this CLI ships ${state.currentVersion}. Run "git2jira skill install".`,
        );
        break;
      case 'modified':
        problems.push(
          `Installed files were changed: ${[...state.modifiedFiles, ...state.missingFiles].join(', ')}. Run "git2jira skill install --force".`,
        );
        break;
      case 'conflict':
        problems.push(state.reason);
    }
    const settings = await readPermissionSettings([
      {
        source: '~/.claude/settings.json',
        file: path.join(this.options.claudeHome, 'settings.json'),
      },
      ...(options.projectSettingsFiles ?? []).map((file) => ({ source: file, file })),
    ]);
    const warnings = scanPermissionSettings(settings, options.mcpServers ?? ['atlassian']);
    return { ok: problems.length === 0, state, problems, warnings };
  }

  // ---------------------------------------------------------------------------

  private async inspect(): Promise<{ state: SkillInstallState; manifest?: SkillManifest }> {
    const pkg = await this.package();
    const { skillDir, agentPath } = this.location;
    const base = { skillDir, agentPath };
    const dirExists = await exists(skillDir);
    const agent = await readOptional(agentPath);
    const agentMatchesPackage = agent?.equals(pkg.agent) === true;

    if (!dirExists) {
      if (agent !== undefined && !agentMatchesPackage) {
        return {
          state: {
            ...base,
            state: 'conflict',
            reason: `An agent named "${AGENT_NAME}" already exists and was not installed by Git2Jira.`,
            paths: [agentPath],
          },
        };
      }
      return { state: { ...base, state: 'not-installed' } };
    }

    let manifest: SkillManifest | undefined;
    try {
      manifest = await this.readManifest();
    } catch {
      return {
        state: {
          ...base,
          state: 'conflict',
          reason: `The Git2Jira manifest in ${skillDir} cannot be read.`,
          paths: [path.join(skillDir, MANIFEST_FILE)],
        },
      };
    }
    if (!manifest) {
      return {
        state: {
          ...base,
          state: 'conflict',
          reason: `A Skill named "${SKILL_NAME}" already exists and was not installed by Git2Jira.`,
          paths: [skillDir],
        },
      };
    }

    const modifiedFiles: string[] = [];
    const missingFiles: string[] = [];
    for (const [relative, hash] of Object.entries(manifest.files)) {
      const content = await readOptional(path.join(skillDir, relative));
      const label = `skills/${SKILL_NAME}/${relative}`;
      if (content === undefined) missingFiles.push(label);
      else if (sha256(content) !== hash) modifiedFiles.push(label);
    }
    const agentLabel = `agents/${AGENT_NAME}.md`;
    if (agent === undefined) missingFiles.push(agentLabel);
    else if (sha256(agent) !== manifest.agent.sha256 && !agentMatchesPackage) {
      modifiedFiles.push(agentLabel);
    }
    if (modifiedFiles.length > 0 || missingFiles.length > 0) {
      return {
        state: {
          ...base,
          state: 'modified',
          installedVersion: manifest.version,
          modifiedFiles,
          missingFiles,
        },
        manifest,
      };
    }

    const sameFiles =
      Object.keys(manifest.files).length === pkg.skillFiles.size &&
      [...pkg.skillFiles].every(
        ([relative, content]) => manifest.files[relative] === sha256(content),
      );
    if (sameFiles && agentMatchesPackage && manifest.version === pkg.version) {
      return { state: { ...base, state: 'installed', version: manifest.version }, manifest };
    }
    return {
      state: {
        ...base,
        state: 'outdated',
        installedVersion: manifest.version,
        currentVersion: pkg.version,
      },
      manifest,
    };
  }

  private async readManifest(): Promise<SkillManifest | undefined> {
    const raw = await readOptional(path.join(this.location.skillDir, MANIFEST_FILE));
    if (raw === undefined) return undefined;
    return SkillManifestSchema.parse(JSON.parse(raw.toString('utf8')));
  }

  private manifestFor(pkg: SkillPackage): SkillManifest {
    return {
      schemaVersion: 1,
      package: 'git2jira-ai',
      skill: SKILL_NAME,
      version: pkg.version,
      installedAt: this.now().toISOString(),
      files: Object.fromEntries(
        [...pkg.skillFiles].map(([rel, content]) => [rel, sha256(content)]),
      ),
      agent: { name: AGENT_NAME, sha256: sha256(pkg.agent) },
    };
  }

  /** Builds the directory next to its target and renames it into place in one step. */
  private async freshInstall(pkg: SkillPackage): Promise<void> {
    const parent = path.dirname(this.location.skillDir);
    await mkdir(parent, { recursive: true });
    const staging = path.join(parent, `.${SKILL_NAME}.staging-${randomBytes(6).toString('hex')}`);
    try {
      for (const [relative, content] of pkg.skillFiles) {
        const target = path.join(staging, ...relative.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, { mode: 0o644 });
      }
      await writeFile(
        path.join(staging, MANIFEST_FILE),
        `${JSON.stringify(this.manifestFor(pkg), null, 2)}\n`,
        { mode: 0o644 },
      );
      // Fails if something appeared at the target meanwhile; nothing is overwritten.
      await rename(staging, this.location.skillDir);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Replaces managed files one by one (each atomically), removes managed files the new
   * package no longer has, and writes the manifest last. Files the user added stay.
   */
  private async upgradeInPlace(
    pkg: SkillPackage,
    manifest: SkillManifest | undefined,
  ): Promise<void> {
    for (const [relative, content] of pkg.skillFiles) {
      await writeAtomic(path.join(this.location.skillDir, ...relative.split('/')), content);
    }
    for (const relative of Object.keys(manifest?.files ?? {})) {
      if (!pkg.skillFiles.has(relative)) {
        await rm(path.join(this.location.skillDir, ...relative.split('/')), { force: true });
      }
    }
    await writeAtomic(
      path.join(this.location.skillDir, MANIFEST_FILE),
      Buffer.from(`${JSON.stringify(this.manifestFor(pkg), null, 2)}\n`),
    );
  }

  private async unmanagedFiles(manifest: SkillManifest | undefined): Promise<string[]> {
    const managed = new Set([...Object.keys(manifest?.files ?? {}), MANIFEST_FILE]);
    return (await listFiles(this.location.skillDir)).filter((f) => !managed.has(f));
  }
}

/** Reads `permissions.allow` and `permissions.defaultMode`, and nothing else, from settings files. */
export async function readPermissionSettings(
  files: readonly { source: string; file: string }[],
): Promise<PermissionSettings[]> {
  const Settings = z.looseObject({
    permissions: z
      .looseObject({
        allow: z.array(z.string()).optional(),
        defaultMode: z.string().optional(),
      })
      .optional(),
  });
  const result: PermissionSettings[] = [];
  for (const { source, file } of files) {
    const raw = await readOptional(file);
    if (raw === undefined) continue;
    let parsed: z.infer<typeof Settings>;
    try {
      parsed = Settings.parse(JSON.parse(raw.toString('utf8')));
    } catch {
      continue;
    }
    result.push({
      source,
      allow: parsed.permissions?.allow ?? [],
      defaultMode: parsed.permissions?.defaultMode,
    });
  }
  return result;
}

async function writeAtomic(target: string, content: Buffer): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temp, content, { mode: 0o644 });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function readOptional(file: string): Promise<Buffer | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile()) return undefined;
    return await readFile(file);
  } catch {
    return undefined;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** Every non-directory entry below `dir`, as relative POSIX paths. */
async function listFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const full = path.join(current, entry);
      const info = await lstat(full);
      if (info.isDirectory()) await walk(full);
      else found.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  await walk(dir);
  return found;
}

async function removeEmptyDirs(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if ((await lstat(full)).isDirectory()) await removeEmptyDirs(full);
  }
  if ((await readdir(dir)).length === 0) await rmdir(dir);
}
