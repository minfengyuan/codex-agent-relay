# AGENTS.md

This file is the default entry point for coding agents working in this repository. Keep it concise: read the next document only when the task needs that detail.

## Project in one paragraph

`codex-agent-relay` is a local Node.js/TypeScript MCP server that lets Codex delegate work to ACP-capable coding agents. `src/server.ts` exposes the MCP tools, `src/runner/acp-runner.ts` owns the provider-neutral ACP/process lifecycle, `src/adapters/` contains provider policy, and `src/store.ts` persists resumable session metadata and serializes access to a working directory.

## Read next only when relevant

| Task | Read |
| --- | --- |
| Change request flow, lifecycle, sessions, locking, cancellation, or component boundaries | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Change or add a provider adapter | [`src/adapters/AGENTS.md`](src/adapters/AGENTS.md) |
| Add or update tests/fixtures | [`test/AGENTS.md`](test/AGENTS.md) |
| Change installation, MCP configuration, or user-facing usage | [`README.md`](README.md) and [`README.zh-CN.md`](README.zh-CN.md) |

Nested `AGENTS.md` files add instructions for their subtree. Do not read every linked document pre-emptively.

## Fast path

Requirements: Node.js 22+ and pnpm 12+.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For a focused test, prefer:

```bash
pnpm exec vitest run test/<file>.test.ts
```

Real-agent smoke tests are opt-in because they require local CLIs/authentication; see `test/AGENTS.md`.

## Repository map

- `src/cli.ts` — stdio MCP entry point and shutdown cleanup.
- `src/server.ts` — MCP schemas, tool registration, input validation, structured error/result mapping.
- `src/runner/acp-runner.ts` — ACP handshake, session create/load/resume, prompt execution, progress, cancellation, timeouts, and child cleanup.
- `src/runner/` — shared limits, summaries, helpers, and adapter contracts.
- `src/adapters/` — Grok, Cursor, and OpenCode-specific command/auth/session/permission behavior.
- `src/store.ts` — session records plus per-`cwd` lock files.
- `src/config.ts` — environment-backed runtime configuration.
- `test/` — hermetic runner/server/store tests, fake ACP agents, and opt-in real smoke tests.
- `scripts/` — developer/setup utilities.

## Non-negotiable invariants

1. **Delegation stays non-interactive.** A delegated worker must not depend on an interactive question/approval round-trip through Codex.
2. **One active task per resolved working directory.** Preserve the `cwd` lock so two agents cannot mutate the same workspace concurrently.
3. **Sessions stay bound to their working directory.** Resuming a session from another `cwd` must fail rather than silently retarget it.
4. **No nested relay delegation.** The delegated child environment marks itself with `CODEX_AGENT_RELAY_DELEGATED=1`; do not create recursive agent trees through this relay.
5. **Cancellation and timeout must clean up children.** Preserve process-group termination and global shutdown cleanup; never leave an ACP CLI running after the MCP task ends.
6. **Outputs stay bounded.** Keep text/stderr/provider summaries within configured limits and accurately propagate truncation.
7. **Provider policy belongs in adapters.** Keep the generic ACP lifecycle provider-neutral unless behavior is truly protocol-wide.
8. **Failures remain structured.** Use `RelayFailure` with stable machine-readable codes and preserve useful partial results where available.

## Change discipline

- Keep MCP input/output schema changes in `src/server.ts` synchronized with the TypeScript result/input types.
- Keep provider command, authentication, permission, session-option, and provider-specific notification handling in `src/adapters/<provider>.ts`.
- Keep reusable ACP lifecycle logic in `src/runner/`; avoid provider-name conditionals there when an adapter hook can express the behavior.
- Treat the on-disk session format in `src/store.ts` as persistent state. A schema change needs explicit compatibility/migration consideration.
- This is ESM TypeScript; local source imports use `.js` specifiers.
- Never put credentials in source, fixtures, task arguments, or docs. Agent authentication comes from the local CLI/environment.
- If public configuration, tool inputs/outputs, supported agents, or user workflow changes, update both English and Chinese READMEs.

## Validation by change type

| Change | Minimum validation |
| --- | --- |
| Docs only | Check links, paths, commands, and consistency with current source |
| Config/schema/types | `pnpm lint && pnpm typecheck && pnpm test` |
| Runner/store/process lifecycle | Focused affected tests, then `pnpm lint && pnpm typecheck && pnpm test && pnpm build` |
| Provider adapter | Provider runner tests plus the full default suite; real smoke test only when the local provider CLI/auth is available and the change requires it |
| Packaging/entry point | Full default suite and `pnpm build` |

## Definition of done

A change is complete when the smallest correct layer owns the behavior, relevant hermetic tests cover success and failure paths, cleanup/session/locking invariants still hold, and user-facing documentation is updated when the external contract changed.
