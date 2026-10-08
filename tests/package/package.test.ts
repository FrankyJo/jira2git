import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<
  string,
  unknown
> & {
  version: string;
  bin: Record<string, string>;
  files: string[];
  engines: { node: string };
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  publishConfig: Record<string, unknown>;
};

describe('npm package manifest', () => {
  it('exposes the CLI as git2jira (and git2jira-ai for npx)', () => {
    expect(pkg.name).toBe('git2jira-ai');
    expect(pkg.bin).toEqual({ git2jira: './dist/cli.js', 'git2jira-ai': './dist/cli.js' });
  });

  it('ships the compiled CLI and the Skill assets, nothing else', () => {
    expect(pkg.files).toEqual(['dist', 'skill', 'README.md', 'LICENSE']);
  });

  it('uses semantic versioning and the supported Node.js range', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    expect(pkg.engines.node).toBe('>=22.12.0');
  });

  it('builds before packing, checks before publishing, and publishes with provenance only by hand', () => {
    expect(pkg.scripts.prepack).toBe('pnpm build');
    expect(pkg.scripts.prepublishOnly).toBe('pnpm check');
    expect(pkg.publishConfig).toEqual({ access: 'public', provenance: true });
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@clack/prompts', 'commander', 'zod']);
  });

  it('declares repository metadata', () => {
    expect(pkg).toMatchObject({
      repository: { type: 'git', url: 'git+https://github.com/FrankyJo/jira2git.git' },
      license: 'MIT',
    });
  });
});

// Packs, installs the tarball into a clean directory outside the repository, and runs the
// installed CLI (scripts/verify-package.mjs). Needs the network for the runtime
// dependencies, so it runs when GIT2JIRA_PACKAGE_TEST=1 (CI runs "pnpm test:package").
describe.runIf(process.env.GIT2JIRA_PACKAGE_TEST === '1')('npm tarball installation', () => {
  it('installs and runs outside the source repository', () => {
    const output = execFileSync(
      process.execPath,
      [path.join(root, 'scripts', 'verify-package.mjs')],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 600_000,
      },
    );
    expect(output).toContain('All package checks passed.');
  }, 600_000);
});
