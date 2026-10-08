import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ServiceContainer } from '../src/app/container';
import { FileConfigStore } from '../src/config/store';
import { repoConfigPath } from '../src/config/paths';
import type { CliContext } from '../src/cli/context';
import { runCli } from '../src/cli/run';

export async function createTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'git2jira-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export class MemoryStream {
  text = '';
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

/** A workspace with an isolated global config dir and a fake repository (`.git` dir). */
export async function createCliHarness() {
  const { dir, cleanup } = await createTempDir();
  const globalPath = path.join(dir, 'home', 'git2jira', 'config.json');
  const repoRoot = path.join(dir, 'repo');
  await mkdir(path.join(repoRoot, '.git'), { recursive: true });
  await mkdir(path.join(repoRoot, 'src', 'nested'), { recursive: true });
  const store = new FileConfigStore({ globalPath, repoPath: repoConfigPath });

  const run = async (argv: string[], cwd: string = repoRoot) => {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();
    const ctx: CliContext = {
      container: new ServiceContainer().register('configStore', () => store),
      cwd,
      stdout,
      stderr,
    };
    const exitCode = await runCli(argv, ctx);
    return { exitCode, stdout: stdout.text, stderr: stderr.text };
  };

  return { dir, globalPath, repoRoot, store, run, cleanup };
}
