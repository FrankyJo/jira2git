# Installation and setup (Phase 5)

Code: `src/installer/wizard.ts` (wizard), `src/diagnostics` (environment probe, doctor checks),
`src/cli/commands/setup.ts` (`init`, `doctor`, `uninstall`), `scripts/verify-package.mjs` (tarball test),
`.github/workflows/release.yml`. Tests: `tests/installer`, `tests/diagnostics`,
`tests/cli/setup-commands.test.ts`, `tests/package`.

## Package

| Item              | Value                                                                                |
| ----------------- | ------------------------------------------------------------------------------------ |
| npm name          | `git2jira-ai` (free on npm on 2026-10-08; check again before publishing)             |
| Executables       | `git2jira` and `git2jira-ai` → `dist/cli.js` (ESM, `#!/usr/bin/env node`)            |
| Files             | `dist/`, `skill/` (the `/jira-report` package), `README.md`, `LICENSE`               |
| Runtime deps      | `@clack/prompts`, `commander`, `zod`                                                 |
| Node.js           | `>=22.12.0`                                                                          |
| Version           | `0.9.0` (release candidate; 1.0.0 after the real MCP checks in release-checklist.md) |
| Lifecycle scripts | `prepack`: `pnpm build`; `prepublishOnly`: `pnpm check`                              |
| Publishing        | manual only, with provenance (see [development.md](development.md#releases))         |

The Skill assets are found at run time by walking up from `dist/cli.js` to `skill/`, so they work from a
global install, a local install, and `npx`. All paths come from `os.homedir()`, `%APPDATA%`,
`$XDG_CONFIG_HOME`, `$GIT2JIRA_CONFIG_DIR`, and `$CLAUDE_CONFIG_DIR`; nothing is hard-coded per platform.

## `git2jira init`

```
git2jira init                                       # interactive (needs a terminal)
git2jira init --yes [--mode manual|mcp|api-token] [--language en|uk] [--skip-skill]
```

The wizard first **asks**, then **applies**. Nothing is written before the summary is confirmed, so
Ctrl+C, Esc, or "no" at the summary leaves everything unchanged (the command exits with code 1).

| Step | What happens                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Welcome: "Git2Jira AI — Generate incremental Jira implementation reports with Claude Code." and the plan                                                                         |
| 2    | Environment: OS, Node.js ≥ 22.12, `git --version`, `claude --version`, `claude auth status --json`, `ANTHROPIC_API_KEY`, `git2jira` on PATH (and npx), existing config and Skill |
| 3    | "How would you like to work with Jira?" Atlassian MCP / Manual / Personal API token (advanced)                                                                                   |
| 4    | MCP: existing registration (reused, unchanged) or consent to `claude mcp add --transport http --scope user <name> https://mcp.atlassian.com/v2/mcp`; OAuth instructions          |
| 5    | Manual: explanation only; no credentials, no MCP                                                                                                                                 |
| 6    | API token: only when chosen; uses an existing connection or signs in (token verified, then stored in the OS credential store)                                                    |
| 7    | "Which language should Git2Jira AI use for Jira reports?" English (default) / Ukrainian → `report.language`                                                                      |
| 8    | Optional: `report.includeUncommitted`, `report.testCommand`, `jira.openAfterPublish`                                                                                             |
| 9    | Summary and confirmation; then apply: config, MCP registration, sign-in, `/jira-report` install                                                                                  |
| 10   | `git2jira doctor` checks                                                                                                                                                         |
| 11   | "Git2Jira AI is ready!" (only if doctor found no failure and the Skill is installed), mode, language, next steps                                                                 |

Rules the wizard follows:

- Manual is preselected when MCP is unavailable (Claude Code missing, or the last access check found
  `blocked-by-policy` / `no-jira-access`). API-token mode is never preselected.
- It never registers an MCP server without consent, never edits or replaces one, and picks another name
  if `atlassian` belongs to an unrelated server.
- It never signs in to Claude Code or Atlassian, never reads Claude Code's files, and never says OAuth
  succeeded: registration is reported as registration, and the `/mcp` → Authenticate step is explained.
- When MCP is blocked by an organization, it says so, does not work around it, and offers manual mode.
- A Skill directory or agent it did not install is reported and left alone; modified installed files
  are replaced only if the user agrees.
- `--yes` accepts every default; API-token sign-in cannot be done non-interactively.

## `git2jira doctor`

`git2jira doctor [--json]` exits with 1 when any check fails. Results are `pass`, `warn` (needs attention
or could not be verified), `fail`, or `skip` (does not apply to the current mode). The summary is "All
applicable checks passed." only when nothing was a warning.

| Check                                  | Pass means                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Git2Jira CLI                           | Node.js is supported and `git2jira` on PATH is this version (fail if missing: `/jira-report` could not run) |
| Operating system, Git, Claude Code     | found                                                                                                       |
| Claude Code sign-in                    | signed in with a subscription; warns on API billing or `ANTHROPIC_API_KEY`                                  |
| /jira-report Skill                     | installed and identical to this CLI's package                                                               |
| Configuration, language, delivery mode | files valid; effective values and their source                                                              |
| Secure credential storage (API token)  | OS store available and a connection exists                                                                  |
| Atlassian MCP: registered              | an Atlassian server on the official endpoint in `claude mcp list`                                           |
| Atlassian MCP: OAuth authorization     | Claude Code's own health status says connected                                                              |
| Atlassian MCP: Jira read access        | the last `/jira-report` access check read the issue                                                         |
| Atlassian MCP: comment creation        | the comment tool was available at that check (writing itself is proven only by the first publication)       |

## `git2jira uninstall`

Removes the `/jira-report` Skill and agent (only files Git2Jira installed), API tokens of configured
connections from the OS credential store, and the global configuration (`--keep-config`,
`--keep-credentials` to keep them). It asks first (`--yes` without a terminal). It does not remove MCP
servers from Claude Code (it prints `claude mcp remove "<name>" --scope user`) or report history in
repositories (`.git/git2jira/`, `refs/git2jira/`), and tells you to run `npm uninstall -g git2jira-ai`.

## Verified here, and not

| Item                                                                                                                                                                                                                       | Status                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Tarball built with `pnpm pack`, installed with npm into a clean directory outside the repository, CLI run there (version, help, config, Skill install/verify, `init --yes`, a manual report end to end, doctor, uninstall) | `pnpm test:package`; run locally on macOS (Node 22.19, npm 10.9) and in CI                            |
| `claude mcp add --transport http --scope user …` syntax                                                                                                                                                                    | checked against `claude mcp add --help` of Claude Code 2.1.294; executed only with a mocked runner    |
| OAuth authorization, Jira read access, Jira write access through Rovo MCP                                                                                                                                                  | **not verified**; needs a real authorized connection ([skill-verification.md](skill-verification.md)) |
| Windows and Linux clipboard and browser openers                                                                                                                                                                            | not exercised                                                                                         |
| Interactive wizard rendering (`@clack/prompts`)                                                                                                                                                                            | logic tested with a scripted prompter; rendering checked by hand only                                 |
| Publication to npm                                                                                                                                                                                                         | not done                                                                                              |
