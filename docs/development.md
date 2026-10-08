# Development

## Prerequisites

- Node.js 22.12+ (`.nvmrc`)
- pnpm 10 (`corepack enable` picks the version from `package.json`)
- Git

## Commands

```sh
pnpm install         # install dependencies
pnpm lint            # ESLint + Prettier check
pnpm lint:fix        # auto-fix lint and formatting
pnpm typecheck       # tsc --noEmit (src and tests)
pnpm test            # Vitest
pnpm test:coverage   # Vitest with V8 coverage
pnpm build           # tsup → dist/cli.js (executable, with shebang)
pnpm check           # all of the above
node dist/cli.js --help
```

Use `GIT2JIRA_CONFIG_DIR=/some/tmp/dir` to run the CLI without touching your real global config.
Set `GIT2JIRA_DEBUG=1` to print stack traces for unexpected errors.

## Layout

```
src/
  cli/            bin.ts (entry), run.ts, program.ts, context.ts, commands/
  app/            container.ts (service registry + DI), bootstrap.ts (composition root)
  core/           errors, exit codes, phases, version
  config/         schemas, paths, file store, settable keys
  localization/   languages, resolution, label catalog types
  git/            runner, repository locator, issue keys, base branch
  snapshots/      snapshot engine, incremental diff
  checkpoints/    record schemas, lineage journal, locks, refs, site identity
  publication/    PublicationLifecycle (Phase 1); plans, JiraPublicationService, recovery (Phase 2)
  credentials/    OS credential store adapters (macOS, Linux, Windows)
  jira/           auth (API token, OAuth interfaces), REST client, connections
  adf/            report renderer, validation, footer marker
  report/ ai/     structured report schema and validation; AI analysis and writers
  delivery/ mcp/  manual and MCP drafts, receipts, Atlassian MCP bridge and setup
  skill/          /jira-report arguments, package checks, approval boundary, installer
  installer/      Prompter port, @clack/prompts adapter, init wizard
  diagnostics/    environment probe and doctor checks
skill/            the /jira-report package shipped in the npm tarball
scripts/          verify-package.mjs (tarball installation test)
tests/            Vitest suites mirroring src/
  fixtures/       GitRepo (real temporary repositories), MockJira (local mock Jira server),
                  publication harness
docs/             product and design documentation
```

## Conventions

- TypeScript strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- ESM; imports without file extensions (bundled by tsup).
- Interfaces live in `src/<module>/types.ts`; adapters implement them; commands get services from the
  container.
- Validate every external input with Zod.
- Commands write through the injected `stdout`/`stderr` streams and return exit codes; they never call
  `process.exit`.
- Unimplemented behavior throws `NotImplementedError(feature, phase)`. Since Phase 5 every command is
  implemented.
- Child processes: `execFile`/`spawn` with argument arrays only.

## Git integration tests

`tests/fixtures/git-repo.ts` creates throwaway repositories with an isolated global config
(`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`), so your own Git settings never affect results.
`userState()` captures index bytes, HEAD, and every working-tree file (mode, content, mtime) to assert
that analysis leaves them untouched. The LFS test runs only where `git lfs` is installed.

## Jira tests

Tests never contact a real Jira site. `tests/fixtures/mock-jira.ts` serves the REST endpoints Git2Jira
uses on a local port, with accounts (classic and scoped tokens), permissions, moved issues, a small
page size to force pagination, and fault injection (`status`, `hang`, `drop`, `process-then-drop`,
`process-then-hang`, `process-then-status`) to simulate lost responses. Its `fetch` routes
`https://example.atlassian.net` and `https://api.atlassian.com` to the mock. `MemoryCredentialStore`
exists only in tests.

The real macOS Keychain adapter test uses a throwaway keychain file and is opt-in:

```sh
GIT2JIRA_TEST_KEYCHAIN=1 pnpm test tests/credentials
```

## Adding a service

1. Define or extend the interface in `src/<module>/types.ts`.
2. Implement an adapter in the same module.
3. Register it in `createDefaultContainer()` and mark its phase in `SERVICE_PHASES`.
4. Test the adapter directly and the command with a container holding fakes.

## Adding a config key

Add a `ConfigKeyDefinition` to `CONFIG_KEYS` (`src/config/keys.ts`) and the field to the schema in
`src/config/schema.ts`. `config get|set|unset|list` pick it up automatically.

## Releases

```sh
pnpm pack                  # builds (prepack) and writes git2jira-ai-<version>.tgz
pnpm test:package          # packs, installs the tarball into a clean temp directory outside the
                           # repository, and runs the installed CLI there (needs network for deps)
GIT2JIRA_PACKAGE_TEST=1 pnpm test tests/package   # the same, from Vitest
KEEP_PACKAGE_TEST=1 pnpm test:package              # keep the temp directory for inspection
```

The tarball contains `dist/`, `skill/`, `README.md`, `LICENSE`, and `package.json` only.

`.github/workflows/release.yml`:

1. On a `v*.*.*` tag: `pnpm check`, tag must equal `package.json` `version`, `pnpm pack`, the tarball
   test, then a **draft** GitHub release with the tarball attached.
2. npm publication is a separate job that runs only when the workflow is started by hand with
   `publish: true`, in the `npm` environment (configure required reviewers there), with
   `npm publish --provenance --access public` and the `NPM_TOKEN` secret. Nothing is published
   automatically.

Before the first publication: check that `git2jira-ai` is still free (`npm view git2jira-ai`), bump the
version, update the changelog in the release notes, and run the manual checks in
[skill-verification.md](skill-verification.md). Versions follow semantic versioning; 1.0.0 is Phase 6.
