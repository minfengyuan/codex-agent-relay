# Test instructions

These instructions apply to `test/**`. Read the root [`AGENTS.md`](../AGENTS.md) first. Read [`ARCHITECTURE.md`](../ARCHITECTURE.md) when testing lifecycle, sessions, locking, or component-boundary changes.

## Test strategy

The default suite must be hermetic. Most relay behavior is tested by spawning deterministic fake ACP agents from `test/fixtures/`, not by invoking a developer's installed Grok/Cursor/OpenCode CLI.

Real-agent smoke tests are separate and opt-in because they depend on local executables, authentication, provider versions, network/service availability, and provider-side behavior.

## Default commands

Run one focused file while iterating:

```bash
pnpm exec vitest run test/<file>.test.ts
```

Before completing a source change, run the appropriate full checks from the repository root:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Do not make `pnpm test` require real provider credentials or network access.

## Real smoke tests

Available package scripts:

```bash
pnpm test:real
pnpm test:real:cursor
pnpm test:real:opencode
```

Run these only when the corresponding CLI is installed/authenticated and the change needs verification against a real implementation. A missing real-provider environment is not a reason to weaken or skip hermetic coverage.

## Test ownership map

Use the narrowest test file that owns the behavior:

- `config.test.ts` — environment parsing and defaults.
- `store.test.ts` — session persistence, validation, and state I/O.
- `workspace-lock.test.ts` — per-`cwd` serialization/lock behavior.
- `runner.test.ts` — generic Grok/common ACP runner behavior.
- `cursor-runner.test.ts` — Cursor adapter behavior.
- `opencode-runner.test.ts` — OpenCode adapter behavior.
- `process-lifecycle.test.ts` — cancellation, timeouts, child/process cleanup, and shutdown-sensitive cases.
- `server.test.ts` — MCP tool schemas/wiring and structured results/errors.
- `append-codex-agent-relay-instructions.test.ts` — setup-script transformations.
- `*-real-smoke.test.ts` — opt-in integration with real CLIs.

When a change crosses boundaries, add assertions at each affected public boundary rather than putting every scenario into one large test.

## Shared helpers

`test/helpers.ts` is the preferred place for reusable test plumbing:

- `tempDir()` returns a canonical temporary directory.
- `baseConfig()` points provider commands at fake ACP fixtures and uses short test timeouts.
- `useRunnerCleanup()` resets stubbed environment variables, calls `cleanupAllChildren()`, and removes temporary directories after each test.

For tests that spawn runners, prefer `useRunnerCleanup()` or equivalent explicit cleanup. A passing assertion with a leaked child process is still a failing test design.

## Fixture rules

Fixtures model external ACP CLIs. Keep them deterministic and purpose-specific.

- Prefer extending an existing fake agent when the protocol behavior is shared.
- Add a new fixture when a scenario requires materially different process/backpressure/lifecycle behavior.
- Do not put real credentials, user paths, or machine-specific assumptions in fixtures.
- Keep fixture behavior controlled by explicit arguments/environment/test input rather than timing races.
- When testing failure paths, make the fixture fail in a way that lets the test assert the relay's structured error code and cleanup behavior.

## Assertions that matter

Prefer externally meaningful assertions over implementation details. Depending on the layer, verify:

- stable `RelayFailure` code, not only message text;
- `sessionId`, `stopReason`, text, structured provider summaries, and truncation flags;
- session/`cwd` mismatch rejection;
- `WORKSPACE_BUSY` behavior for overlapping work in the same directory;
- independent workspaces remaining concurrent;
- session option conflicts remaining explicit;
- permission behavior remaining non-interactive and deterministic;
- partial output being preserved on failure when expected;
- child processes and locks being released after success, cancellation, timeout, and error.

Use message assertions only when the human-readable wording is itself part of the intended behavior.

## Timing and concurrency tests

Lifecycle tests are inherently sensitive to races. Keep them event-driven whenever possible:

- wait for an observable fixture event/log instead of sleeping for an arbitrary duration;
- use the short timeouts in `baseConfig()` but leave enough margin for CI scheduling;
- always clean up active children in `afterEach`;
- when asserting concurrency, distinguish "same `cwd` must serialize/fail" from "different `cwd`s may run in parallel".

Do not fix a flaky lifecycle test by adding a large unconditional sleep unless no deterministic synchronization point exists.

## Adding provider coverage

For a new provider, create a dedicated `<provider>-runner.test.ts` when it has provider-specific semantics. The fake agent should cover the ACP features that distinguish the adapter: authentication, session resume/load, permission requests, config options, and extension notifications.

Also update `server.test.ts` for the MCP tool contract and add a real smoke test only if maintaining one is practical for that provider.

## Completion checklist

A source change is adequately tested when the narrow behavior test passes, the full hermetic suite passes, no test depends on a developer's real credentials, and lifecycle-sensitive cases leave neither child processes nor workspace locks behind.
