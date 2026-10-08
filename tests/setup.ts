import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// No test may read or write the developer's real Git2Jira or Claude Code directories,
// even one that forgets to register an isolated store: every default path resolves here.
const sandbox = mkdtempSync(path.join(tmpdir(), 'git2jira-vitest-home-'));
process.env.GIT2JIRA_CONFIG_DIR = path.join(sandbox, 'git2jira');
process.env.CLAUDE_CONFIG_DIR = path.join(sandbox, 'claude');
