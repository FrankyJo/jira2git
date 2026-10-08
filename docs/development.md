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
  git/ snapshots/ checkpoints/ credentials/ jira/ adf/ report/ ai/
  publication/ skill/ installer/ diagnostics/      interfaces for later phases
tests/            Vitest suites mirroring src/
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
- Unimplemented behavior throws `NotImplementedError(feature, phase)`.
- Child processes: `execFile`/`spawn` with argument arrays only.

## Adding a service

1. Define or extend the interface in `src/<module>/types.ts`.
2. Implement an adapter in the same module.
3. Register it in `createDefaultContainer()` and mark its phase in `SERVICE_PHASES`.
4. Test the adapter directly and the command with a container holding fakes.

## Adding a config key

Add a `ConfigKeyDefinition` to `CONFIG_KEYS` (`src/config/keys.ts`) and the field to the schema in
`src/config/schema.ts`. `config get|set|unset|list` pick it up automatically.

## Releasing

Packaging and npm publication are Phase 5; release preparation is Phase 6.
`pnpm pack --dry-run` shows the files that would be published (`dist`, `README.md`, `LICENSE`).
