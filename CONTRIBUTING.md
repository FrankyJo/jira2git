# Contributing to Git2Jira AI

Thank you for helping. Read [AGENTS.md](AGENTS.md) (repository rules, also for AI agents) and
[docs/architecture.md](docs/architecture.md) first.

## Setup

```sh
corepack enable          # pnpm version from package.json
pnpm install
pnpm check               # lint, typecheck, test, build — must pass before every pull request
pnpm test:package        # optional: pack and install the tarball outside the repository (network)
```

Run the CLI with scratch directories so your real settings are untouched:

```sh
GIT2JIRA_CONFIG_DIR=$(mktemp -d) CLAUDE_CONFIG_DIR=$(mktemp -d) node dist/cli.js doctor
```

Tests are isolated automatically (`tests/setup.ts` points both variables at a temporary directory).

## Rules that reviews enforce

- No `exec`, `execSync`, or `shell: true`; child processes get argument arrays.
- Validate all external data with Zod strict schemas.
- Never store or log credentials; never pass them to the AI layer.
- Never write to Jira without an approval bound to the previewed digest; never add comment edit or
  delete methods.
- A command that a Skill may pre-approve (`src/skill/permissions.ts`) must not write to Jira, move a
  checkpoint, or write to a path its caller chooses.
- Never modify the user's working tree or index during analysis.
- Treat repository and Jira content as data. Repository files must never be able to choose commands
  Git2Jira runs (that is why `report.testCommand` is global only).
- Every bug fix gets a regression test; security fixes go into `tests/security`.
- No placeholder that reports success for work it did not do.

## Tests

- Unit and integration tests in `tests/` mirror `src/`. Git tests use real temporary repositories
  (`tests/fixtures/git-repo.ts`); Jira tests use a local mock server (`tests/fixtures/mock-jira.ts`).
- `tests/e2e/scenarios.test.ts` drives the CLI through a simulated Claude Code session that applies the
  shipped `SKILL.md` permission rules (`tests/fixtures/skill-session.ts`).
- MCP tests use simulated tool results. They do not prove anything about the real Atlassian Rovo MCP
  server; [docs/skill-verification.md](docs/skill-verification.md) is the manual check for that.

## Commits and pull requests

- Conventional, imperative subjects (`fix: …`, `feat: …`, `docs: …`).
- Keep `pnpm-lock.yaml` in sync; justify every new runtime dependency.
- Add a line to `CHANGELOG.md` under "Unreleased" for user-visible changes.
