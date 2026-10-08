#!/usr/bin/env node
// Builds the npm tarball, installs it into a clean directory outside the repository, and
// runs the installed CLI there: version, help, configuration, /jira-report installation,
// the setup wizard (--yes), a full manual report in a scratch Git repository, and
// uninstall. Everything uses scratch HOME, config, and Claude Code directories.
//
// Usage: node scripts/verify-package.mjs [path/to/git2jira-ai-x.y.z.tgz]
// Needs network access (or an npm cache) for the package's runtime dependencies.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const work = mkdtempSync(path.join(tmpdir(), 'git2jira-package-'));
const keep = process.env.KEEP_PACKAGE_TEST === '1';
let failures = 0;

function step(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${String(error.message).split('\n').join('\n     ')}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** npm without a shell, also on Windows (where npm is a .cmd shim). */
function npm(args, options) {
  if (process.platform === 'win32') {
    const cli = path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
    return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...options });
  }
  return execFileSync('npm', args, { encoding: 'utf8', ...options });
}

// 1. The tarball.
let tarball = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
if (!tarball) {
  const dest = path.join(work, 'pack');
  mkdirSync(dest);
  const pnpm = process.env.npm_execpath;
  if (pnpm && /pnpm/.test(pnpm)) {
    execFileSync(process.execPath, [pnpm, 'pack', '--pack-destination', dest], {
      cwd: root,
      stdio: 'inherit',
    });
  } else {
    npm(['pack', '--pack-destination', dest], { cwd: root, stdio: 'inherit' });
  }
  tarball = path.join(
    dest,
    readdirSync(dest).find((f) => f.endsWith('.tgz')),
  );
}
console.log(`tarball: ${tarball}`);

step('tarball contains the CLI and the Skill, and no sources', () => {
  const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split(/\r?\n/);
  for (const required of [
    'package/package.json',
    'package/dist/cli.js',
    'package/skill/jira-report/SKILL.md',
    'package/skill/jira-report/reference/mcp.md',
    'package/skill/agents/jira-reporter.md',
    'package/README.md',
    'package/LICENSE',
  ]) {
    assert(files.includes(required), `missing ${required}`);
  }
  const forbidden = files.filter(
    (f) => /^package\/(src|tests|scripts|\.github)\//.test(f) || /\.env/.test(f),
  );
  assert(forbidden.length === 0, `unexpected files: ${forbidden.join(', ')}`);
});

// 2. A clean install outside the repository.
const app = path.join(work, 'app');
const home = path.join(work, 'home');
const outside = path.join(work, 'outside');
for (const dir of [app, home, outside]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'probe', private: true }));
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  HOME: home,
  USERPROFILE: home,
  GIT2JIRA_CONFIG_DIR: path.join(home, 'git2jira'),
  CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Probe',
  GIT_AUTHOR_EMAIL: 'probe@example.com',
  GIT_COMMITTER_NAME: 'Probe',
  GIT_COMMITTER_EMAIL: 'probe@example.com',
};
delete env.CLAUDECODE;
npm(['install', '--no-audit', '--no-fund', '--loglevel=error', tarball], {
  cwd: app,
  env,
  stdio: 'inherit',
});
const cliPath = path.join(app, 'node_modules', pkg.name, 'dist', 'cli.js');

// Unrelated Claude Code files that installing and uninstalling must leave exactly as they are.
const claudeHome = path.join(home, 'claude');
const existing = {
  'settings.json': JSON.stringify({ permissions: { allow: ['Read'] }, env: { KEEP: '1' } }),
  'skills/other-skill/SKILL.md': '---\nname: other-skill\ndescription: mine\n---\nkeep\n',
  'agents/other-agent.md': '---\nname: other-agent\ndescription: mine\n---\nkeep\n',
};
for (const [file, content] of Object.entries(existing)) {
  mkdirSync(path.dirname(path.join(claudeHome, file)), { recursive: true });
  writeFileSync(path.join(claudeHome, file), content);
}
function assertExistingPreserved() {
  for (const [file, content] of Object.entries(existing)) {
    const actual = readFileSync(path.join(claudeHome, file), 'utf8');
    if (actual !== content) throw new Error(`${file} was changed`);
  }
}

function cli(args, options = {}) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd ?? outside,
    env,
    encoding: 'utf8',
    input: options.input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function cliExit(args, options = {}) {
  try {
    return { code: 0, stdout: cli(args, options) };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout) };
  }
}

step('the installed bin links exist', () => {
  const bin = path.join(app, 'node_modules', '.bin');
  const names = readdirSync(bin);
  assert(
    names.some((n) => n.startsWith('git2jira')),
    `no git2jira in ${bin}`,
  );
  assert(
    names.some((n) => n.startsWith('git2jira-ai')),
    `no git2jira-ai in ${bin}`,
  );
});

step('--version prints the package version (outside any repository)', () => {
  assert(cli(['--version']).trim() === pkg.version, 'wrong version');
});

step('--help lists the setup commands', () => {
  const help = cli(['--help']);
  for (const command of ['init', 'doctor', 'uninstall', 'report', 'skill', 'config']) {
    assert(new RegExp(`^  ${command}\\b`, 'm').test(help), `missing ${command}`);
  }
});

step('report language and delivery mode persist globally', () => {
  cli(['config', 'set', 'report.language', 'uk']);
  assert(cli(['config', 'get', 'report.language']).trim() === 'uk', 'language not stored');
  cli(['config', 'set', 'report.language', 'en']);
  assert(cli(['config', 'get', 'report.language']).trim() === 'en', 'language not switched');
  cli(['config', 'set', 'jira.mode', 'mcp']);
  cli(['config', 'set', 'jira.mode', 'manual']);
  assert(cli(['config', 'get', 'jira.mode']).trim() === 'manual', 'mode not stored');
});

step('/jira-report installs from the package and verifies', () => {
  const out = cli(['skill', 'install']);
  assert(/Installed \/jira-report/.test(out), out);
  assert(existsSync(path.join(home, 'claude', 'skills', 'jira-report', 'SKILL.md')), 'no SKILL.md');
  assert(existsSync(path.join(home, 'claude', 'agents', 'jira-reporter.md')), 'no agent');
  const verify = cliExit(['skill', 'verify']);
  assert(verify.code === 0, verify.stdout);
  assert(/Already up to date/.test(cli(['skill', 'install'])), 'reinstall not idempotent');
});

step('init --yes configures manual mode without any Jira credentials', () => {
  const result = cliExit(['init', '--yes', '--mode', 'manual', '--language', 'uk']);
  assert(result.code === 0, result.stdout);
  assert(/Delivery mode: Manual/.test(result.stdout), result.stdout);
  assert(cli(['config', 'get', 'report.language']).trim() === 'uk', 'language not stored');
});

step('a manual report works end to end in a scratch repository', () => {
  const repo = path.join(work, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'README.md'), '# probe\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('switch', '-q', '-c', 'feature/DEMO-1-probe');
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  const prepared = JSON.parse(
    cli(['report', 'prepare', '--json', '--mode', 'manual'], { cwd: repo }),
  );
  assert(prepared.result === 'prepared' && prepared.language === 'uk', JSON.stringify(prepared));
  const submitted = JSON.parse(
    cli(['report', 'submit', '--report', prepared.reportId, '--json', '--input', '-'], {
      cwd: repo,
      input: JSON.stringify({
        schemaVersion: 2,
        issueKey: 'DEMO-1',
        language: 'uk',
        summary: 'Додано модуль a.',
        completedWork: [
          {
            kind: 'added',
            category: 'feature',
            subject: 'a',
            description: 'Додано константу.',
            files: ['src/a.ts'],
          },
        ],
        testing: { status: 'not-run', notes: [] },
      }),
    }),
  );
  assert(submitted.markdown.includes('Підсумок'), 'not Ukrainian');
  cli(
    [
      'report',
      'confirm',
      '--report',
      prepared.reportId,
      '--digest',
      submitted.reportDigest,
      '--attest-manual-publication',
    ],
    { cwd: repo },
  );
  const receipt = JSON.parse(
    cli(['report', 'receipt', '--report', prepared.reportId], { cwd: repo }),
  );
  assert(
    receipt.checkpoint.advanced === true && receipt.evidence === 'user-attested',
    JSON.stringify(receipt),
  );
  const again = JSON.parse(cli(['report', 'prepare', '--json', '--mode', 'manual'], { cwd: repo }));
  assert(again.result === 'no-changes', 'expected no changes');
});

step('doctor runs and reports, without claiming unverified items', () => {
  const result = cliExit(['doctor', '--json']);
  const report = JSON.parse(result.stdout);
  assert(Array.isArray(report.checks) && report.checks.length >= 10, 'no checks');
  const skill = report.checks.find((c) => c.id === 'skill');
  assert(skill.status === 'pass', JSON.stringify(skill));
});

step('existing Claude Code skills, agents, and settings are untouched by install', () => {
  assertExistingPreserved();
});

step('uninstall removes the Skill and the configuration', () => {
  cli(['uninstall', '--yes']);
  assertExistingPreserved();
  assert(!existsSync(path.join(home, 'claude', 'skills', 'jira-report')), 'Skill still there');
  assert(!existsSync(path.join(home, 'git2jira', 'config.json')), 'config still there');
});

if (!keep) rmSync(work, { recursive: true, force: true });
else console.log(`kept: ${work}`);
if (failures > 0) {
  console.log(`${failures} package check(s) failed.`);
  process.exit(1);
}
console.log('All package checks passed.');
