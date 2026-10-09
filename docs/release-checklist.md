# Release checklist

Use this for every release. Nothing in it is automated end to end: publishing to npm and creating the
GitHub release are deliberate manual steps.

## 1. Code and tests

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` (or `pnpm check`) — all green
- [ ] `pnpm pack` and `pnpm test:package` (tarball installed outside the repository, CLI and Skill run)
- [ ] On macOS: `GIT2JIRA_TEST_KEYCHAIN=1 pnpm test tests/credentials` (real Keychain round trip)
- [ ] CI green on ubuntu, macOS, and Windows, Node 22 and 24
- [ ] `pnpm audit --prod` shows no known vulnerabilities in runtime dependencies
- [ ] No skipped test hides broken functionality (allowed skips: Git LFS when not installed, the opt-in
      Keychain test, the network tarball test outside CI)

## 2. Manual checks in real Claude Code

Follow [skill-verification.md](skill-verification.md). Required for every release: sections 1–3 and 6
(discovery, manual mode, subagent, installation lifecycle). Required before calling MCP mode supported:
section 4 (MCP) on a real Jira Cloud test site, and section 5 if possible. Record the Claude Code version,
date, site type (personal / corporate), and results in the release notes.

## 3. Package

- [ ] `npm view git2jira-ai` still returns 404 (name free), or the name is ours
- [ ] Version bumped in `package.json`; `CHANGELOG.md` section dated
- [ ] `tar -tzf git2jira-ai-<v>.tgz` lists only `package/{package.json,README.md,LICENSE}`,
      `package/dist/*`, `package/skill/*`
- [ ] `git2jira --version` of the installed tarball prints the new version

## 4. Release

- [ ] Tag `v<version>` → the Release workflow builds, verifies, and creates a **draft** GitHub release
- [ ] Review the draft notes; publish the GitHub release by hand
- [ ] npm: run the Release workflow by hand with `publish: true`; approve the `npm` environment
      (publishes with provenance). Never publish from a laptop.
- [ ] After publishing: `npx git2jira-ai@<version> --version` from an empty directory

## Readiness

Assessment for 0.9.x (2026-10-08), from the Phase 6 audit.

| Delivery mode              | Verdict                                  | Basis                                                                                                                                                                                              |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Personal manual mode    | **Ready** (release candidate)            | Needs no Jira access; full lifecycle tested with real Git through the CLI and the shipped Skill rules; tarball tested                                                                              |
| B. Corporate Atlassian MCP | **Early; works on one corporate site**   | 2026-10-09: OAuth, site discovery, issue read, and comment creation worked on a real corporate Jira Cloud site. Error formats, policy blocks, and recovery after a lost response not yet seen live |
| C. Personal API-token mode | **Ready for personal use, with caveats** | Tested against a local Jira mock (auth, pagination, retries, lost responses), not a real Jira Cloud site                                                                                           |
| D. Public npm distribution | **Ready to distribute as 0.9.2**         | Tarball installs and runs outside the repository; manual checks in real Claude Code (sections 1–3, 6) still to be done                                                                             |

Not claimed anywhere: exactly-once Jira publication. Jira comments have no idempotency key; Git2Jira
prevents blind duplicates (write-ahead journal, marker search, `UNCERTAIN` state), but a second comment
is possible if Jira is unreadable for longer than the settle window and the user retries.

Recommended path: distribute **0.9.2** with manual mode as the supported mode and MCP labeled experimental;
release **1.0.0** after section 4 of skill-verification.md passes on at least one corporate Jira Cloud
site and the findings (parameter names, result shapes, marker survival, error formats) are recorded in
[jira-publication.md](jira-publication.md#what-has-and-has-not-been-verified).
