# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/FrankyJo/jira2git/security/advisories/new), not in public
issues. Include the version (`git2jira --version`), the delivery mode, and steps to reproduce. Do not send
real Jira tokens, OAuth data, or proprietary source code.

## Supported versions

| Version | Supported                  |
| ------- | -------------------------- |
| 0.9.x   | Yes (release candidate)    |
| < 0.9   | No (development snapshots) |

## What Git2Jira protects

- **Jira credentials.** API tokens live only in the OS credential store (macOS Keychain, Windows
  Credential Manager, Secret Service), passed over stdin, never in config files, logs, prompts, or
  argv. MCP OAuth stays inside Claude Code; Git2Jira never reads, stores, or forwards it.
- **Your Jira issues.** Nothing is published without your approval of the exact report digest. In the
  Claude Code Skill, every command that confirms, publishes, records a result, or abandons a report is
  never pre-approved, so Claude Code's permission prompt asks you; the model cannot approve for you.
  MCP publication is refused unless a recent access check showed write access. Comments are only ever
  created, never edited or deleted.
- **Your working tree.** Analysis never changes your files, index, HEAD, or branches.
- **Your machine.** No shell is ever used; repository content and repository configuration cannot choose
  commands for Git2Jira to run.
- **Your secrets in code.** Secret files are excluded and secret-looking values are redacted before
  anything reaches the model.
- **Report integrity.** Diffs, READMEs, commit messages, and Jira text are untrusted data; model output
  is validated against Git (files, issue, language, snapshot, tests) before use.

Design details, the threat model, audit findings, and remaining risks: [docs/security.md](docs/security.md).

## Your responsibilities

- Do not run `/jira-report` with Claude Code's `bypassPermissions` mode or with permission rules that
  pre-approve `git2jira` publication commands; `git2jira skill verify` warns about both.
- Use the API-token mode only where your organization allows personal API tokens.
- Respect your organization's Atlassian policies; Git2Jira will not work around them.
