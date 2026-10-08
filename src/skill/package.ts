import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Git2JiraError } from '../core/errors';
import { FrontmatterError, parseFrontmatter, stringList } from './frontmatter';
import { checkAllowedTools } from './permissions';
import { AGENT_NAME, SKILL_NAME } from './types';

/**
 * The Skill package shipped with the CLI (`skill/` in the npm package):
 *
 *   skill/jira-report/SKILL.md, reference/*.md   → <claude home>/skills/jira-report/
 *   skill/agents/jira-reporter.md                 → <claude home>/agents/jira-reporter.md
 *
 * Subagents cannot live inside a Skill directory, so the agent is installed next to the
 * user's other agents, and the Skill's manifest records it.
 */
export interface SkillPackage {
  version: string;
  /** Skill directory files by relative POSIX path. */
  skillFiles: ReadonlyMap<string, Buffer>;
  agent: Buffer;
}

export const SKILL_ENTRY = 'SKILL.md';
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 50;
const DESCRIPTION_LIMIT = 1024;
const READ_ONLY_AGENT_TOOLS = new Set(['Read', 'Grep', 'Glob']);

export function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Finds the bundled `skill/` directory by walking up from a module's directory: it is
 * `<package>/skill` both for the built CLI (`dist/cli.js`) and for the sources.
 */
export function findSkillAssets(fromDir: string): string | undefined {
  let current = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(current, 'skill');
    if (existsSync(path.join(candidate, SKILL_NAME, SKILL_ENTRY))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export class SkillPackageError extends Git2JiraError {}

export async function loadSkillPackage(assetsDir: string, version: string): Promise<SkillPackage> {
  const root = path.join(assetsDir, SKILL_NAME);
  const files = new Map<string, Buffer>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir)).sort()) {
      const full = path.join(dir, entry);
      const info = await lstat(full);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) {
        if (info.size > MAX_FILE_BYTES) throw new SkillPackageError(`${relative} is too large.`);
        files.set(relative, await readFile(full));
      } else {
        throw new SkillPackageError(`${relative} in the Skill package is not a regular file.`);
      }
      if (files.size > MAX_FILES)
        throw new SkillPackageError('The Skill package has too many files.');
    }
  };
  try {
    await walk(root);
  } catch (error) {
    if (error instanceof SkillPackageError) throw error;
    throw new SkillPackageError(
      `The Skill package is missing or unreadable at ${root}: ${(error as Error).message}`,
    );
  }
  const agent = await readFile(path.join(assetsDir, 'agents', `${AGENT_NAME}.md`)).catch(() => {
    throw new SkillPackageError(`The ${AGENT_NAME} subagent is missing from the Skill package.`);
  });
  return { version, skillFiles: files, agent };
}

/** Problems with a `SKILL.md`: discovery fields and the approval boundary. */
export function checkSkillFile(content: string): string[] {
  let parsed;
  try {
    parsed = parseFrontmatter(content);
  } catch (error) {
    return [`SKILL.md: ${error instanceof FrontmatterError ? error.message : String(error)}`];
  }
  const fm = parsed.frontmatter;
  const problems: string[] = [];
  if (fm.name !== SKILL_NAME) problems.push(`SKILL.md: name must be "${SKILL_NAME}"`);
  if (typeof fm.description !== 'string' || fm.description.trim() === '') {
    problems.push('SKILL.md: description is missing');
  } else if (fm.description.length > DESCRIPTION_LIMIT) {
    problems.push(`SKILL.md: description is longer than ${String(DESCRIPTION_LIMIT)} characters`);
  }
  // The Skill publishes and confirms reports: only the user may start it.
  if (fm['disable-model-invocation'] !== true) {
    problems.push('SKILL.md: disable-model-invocation must be true');
  }
  if (typeof fm['argument-hint'] !== 'string') problems.push('SKILL.md: argument-hint is missing');
  for (const problem of checkAllowedTools(stringList(fm['allowed-tools']))) {
    problems.push(`SKILL.md: allowed-tools: ${problem}`);
  }
  if (!parsed.body.includes('$ARGUMENTS')) {
    problems.push('SKILL.md: the body does not pass $ARGUMENTS to the CLI');
  }
  return problems;
}

/** Problems with the subagent: it must be read-only and unable to publish. */
export function checkAgentFile(content: string): string[] {
  let parsed;
  try {
    parsed = parseFrontmatter(content);
  } catch (error) {
    return [
      `${AGENT_NAME}.md: ${error instanceof FrontmatterError ? error.message : String(error)}`,
    ];
  }
  const fm = parsed.frontmatter;
  const problems: string[] = [];
  if (fm.name !== AGENT_NAME) problems.push(`${AGENT_NAME}.md: name must be "${AGENT_NAME}"`);
  if (typeof fm.description !== 'string' || fm.description.trim() === '') {
    problems.push(`${AGENT_NAME}.md: description is missing`);
  }
  // Without an explicit list a subagent inherits every tool, including MCP and Bash.
  const tools = stringList(fm.tools);
  if (tools.length === 0) problems.push(`${AGENT_NAME}.md: tools must be listed explicitly`);
  for (const tool of tools) {
    if (!READ_ONLY_AGENT_TOOLS.has(tool)) {
      problems.push(`${AGENT_NAME}.md: tool "${tool}" is not read-only`);
    }
  }
  return problems;
}

/** Problems with the package as shipped. Empty for a correct build. */
export function checkSkillPackage(pkg: SkillPackage): string[] {
  const entry = pkg.skillFiles.get(SKILL_ENTRY);
  const problems = entry ? checkSkillFile(entry.toString('utf8')) : [`${SKILL_ENTRY} is missing`];
  problems.push(...checkAgentFile(pkg.agent.toString('utf8')));
  const body = entry?.toString('utf8') ?? '';
  for (const link of body.matchAll(/\]\((reference\/[^)#\s]+)/g)) {
    if (link[1] !== undefined && !pkg.skillFiles.has(link[1])) {
      problems.push(`SKILL.md links to ${link[1]}, which is not in the package`);
    }
  }
  return problems;
}
