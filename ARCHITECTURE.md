# Architecture

This document explains the durable component boundaries and runtime invariants of `codex-agent-relay`. For day-to-day agent instructions, start with [`AGENTS.md`](AGENTS.md).

## System context

The relay sits between **Codex/MCP** and locally installed **ACP coding-agent CLIs**:

```text
Codex
  │ MCP over stdio
  ▼
src/cli.ts
  ▼
src/server.ts
  │ validated delegate request
  ▼
AcpRunner ───────── SessionStore
  │                    │
  │ ACP over child     ├─ session metadata
  │ stdin/stdout       └─ per-cwd locks
  ▼
Provider CLI
(Grok / Cursor / OpenCode)
```

The relay is an orchestration boundary, not a second autonomous planner. Codex chooses what to delegate and reviews/integrates the result; the relay executes one non-interactive provider turn and returns a resumable session ID plus bounded output.

## Layer boundaries

### `src/cli.ts`: process boundary

Responsibilities:

- Load environment-derived configuration.
- Start the MCP server on stdio.
- React to `SIGINT`, `SIGTERM`, `SIGHUP`, and stdin closure.
- Close the MCP transport and ask the runner layer to clean up all active children before process exit.

Do not move provider behavior here.

### `src/server.ts`: MCP contract boundary

Responsibilities:

- Define Zod schemas for MCP tool inputs and structured outputs.
- Register `grok_delegate`, `cursor_delegate`, and `opencode_delegate`.
- Resolve and validate `cwd` before execution.
- Convert runner results and `RelayFailure`s into MCP tool results.
- Forward MCP cancellation and progress notifications into the runner.

A public tool-contract change normally begins here and must stay synchronized with `src/types.ts`, provider adapters, tests, and the READMEs.

### `src/runner/acp-runner.ts`: provider-neutral execution engine

`AcpRunner` owns the common ACP lifecycle:

1. Reject nested delegation when `CODEX_AGENT_RELAY_DELEGATED=1`.
2. Validate provider input through the adapter hook.
3. Acquire the per-`cwd` workspace lock.
4. Load persisted session metadata when a `sessionId` is supplied.
5. Ask the adapter how to spawn the provider CLI and construct the child environment.
6. Connect ACP over NDJSON on the child's stdin/stdout.
7. Initialize and, when required, authenticate.
8. Create, load, or resume a session.
9. Let the adapter apply provider-specific session configuration.
10. Persist a newly created session before prompting.
11. Send one prompt and collect bounded text/provider summaries.
12. Touch resumed session metadata after successful completion.
13. On cancellation, timeout, permission failure, or other error, preserve useful partial output.
14. Terminate the child/process group and release the workspace lock in `finally`.

Provider-name branches should not be added here when the `ProviderAdapter` contract can express the difference.

### `src/runner/*`: shared execution primitives

- `types.ts` defines `ProviderAdapter`, summarizer, permission runtime, and session configuration extension points.
- `limits.ts` bounds output and supplies timeout helpers.
- `summaries.ts` converts high-volume provider updates into bounded structured summaries.
- `helpers.ts` centralizes ACP capability/auth/cancellation helpers.

These modules may know ACP concepts but should remain provider-neutral unless a type is explicitly a provider summary implementation.

### `src/adapters/*`: provider policy

An adapter decides provider-specific behavior such as:

- CLI executable and arguments.
- Authentication method selection.
- ACP client capabilities advertised by the relay.
- Prompt preamble for non-interactive execution.
- Session metadata and whether existing sessions are loaded or resumed.
- Session mode/config-option selection.
- Permission-request handling.
- Provider-specific ACP requests/notifications and summaries.

See [`src/adapters/AGENTS.md`](src/adapters/AGENTS.md) before changing this layer.

### `src/store.ts`: state and concurrency boundary

The store has two separate responsibilities.

**Session metadata**

- Session IDs are hashed for filenames, but the record stores the original ID.
- Records include the canonical `cwd`, creation/update timestamps, and optional provider metadata (`model`/`mode`).
- State directories/files are created with private permissions.
- A session may only be resumed from the same resolved `cwd`.
- Writes are atomic enough to avoid exposing partially written JSON.

**Workspace serialization**

- The real/resolved `cwd` is hashed into a lock filename.
- Lock creation uses exclusive file creation.
- If the lock already exists, the request fails with `WORKSPACE_BUSY`; it does not queue inside the relay.
- Independent working directories can run concurrently.

The session-record format is persistent state. If its schema changes, decide explicitly whether to preserve `version: 1`, accept older records, migrate them, or introduce a new version.

## Request and result flow

```text
MCP request
  │
  ├─ Zod validation / cwd resolution
  │
  ├─ acquire workspace lock
  │
  ├─ optional session-record lookup
  │
  ├─ spawn provider ACP CLI
  │
  ├─ ACP initialize/auth
  │
  ├─ new | load | resume session
  │
  ├─ provider-specific session configuration
  │
  ├─ session/prompt
  │    ├─ text chunks -> bounded text
  │    ├─ tool/usage/provider updates -> bounded summarizer
  │    └─ progress -> MCP notifications/progress (rate limited)
  │
  ├─ result or RelayFailure + partial result
  │
  └─ child cleanup + lock release
       ▼
structured MCP result
```

## Session semantics

The relay persists only the metadata needed to safely reconnect Codex to a provider-owned ACP session. The provider remains the source of truth for conversation state.

Important consequences:

- A returned `sessionId` is provider-specific and must be sent back to the same MCP tool/provider.
- A session is tied to the resolved working directory to prevent accidental continuation in another checkout/worktree.
- Provider options that must remain stable across a session belong in persisted metadata when necessary. Cursor currently persists model/mode semantics; Grok and OpenCode currently do not persist extra adapter metadata.
- Provider capability negotiation decides whether an existing session can be resumed or loaded.

## Provider behavior matrix

| Concern | Grok | Cursor | OpenCode |
| --- | --- | --- | --- |
| CLI default | `grok` | explicit `CODEX_AGENT_RELAY_CURSOR_COMMAND` required | `opencode` |
| Authentication | `xai.api_key` when available, otherwise `cached_token` | `cursor_login` | `opencode-login` when advertised; no auth request when none advertised |
| Existing session | common load behavior | common load behavior with persisted mode/model checks | prefers ACP resume, falls back to load; `resume: false` forces load |
| Interactive questions | not supported | question requests are skipped; plan approval rejected | question permission is disabled in child env |
| Permission request | unexpected -> fail/cancel | reject once when possible and fail with structured summary | allow once when offered; otherwise fail |
| Provider summaries | plain text result | tool calls, todos, subagents, interactions, images | usage and tool-call summaries |

This table describes current implementation, not a requirement that every future provider behave identically.

## Non-interactive permission model

Delegated execution must not stall waiting for a human UI. Each provider adapter translates its available permission model into deterministic relay behavior.

The generic runner treats permission state as part of task failure handling so that cancellation, partial output, and cleanup use the same path as other execution failures. Do not add an unbounded user-question wait loop to the runner.

## Limits and backpressure

The relay bounds the data it accumulates:

- Agent text is capped by `textLimitBytes`.
- stderr keeps only a bounded tail controlled by `stderrLimitBytes`.
- Provider summary structures have their own bounded accounting.
- Progress notifications are rate-limited by `progressIntervalMs`.
- Individual ACP phases use `phaseTimeoutMs`; the whole delegated turn is bounded by `totalTimeoutMs`.

When adding new provider notifications, route them through a bounded summarizer rather than storing raw event streams.

## Cancellation and process lifetime

There are three cancellation sources:

- MCP request cancellation.
- Total task timeout.
- Relay shutdown.

The runner first attempts the ACP session-cancel notification when possible, then terminates the child. On POSIX systems the provider is spawned in its own process group so descendants can be terminated together; Windows uses child termination with grace/escalation behavior.

`cleanupAllChildren()` is a process-wide safety net used by `src/cli.ts` and tests. Any lifecycle refactor must preserve the guarantee that shutdown does not leave delegated workers alive.

## Error model

Expected operational failures use `RelayFailure(code, message, partial?)`.

Guidelines:

- Codes are part of the machine-readable behavior; prefer a specific stable code over parsing messages.
- Attach partial output/session metadata when the caller can still use it diagnostically.
- Convert unknown exceptions at layer boundaries rather than leaking arbitrary throw shapes through MCP.
- Do not hide cleanup/lock-release failures; they can indicate state corruption or leaked serialization.

## Configuration

`src/config.ts` maps environment variables to one immutable `RelayConfig` loaded at process startup. Defaults include:

- 30s phase timeout.
- 1h total delegation timeout.
- 5s ACP cancellation grace.
- 2s process termination grace.
- 256 KiB text limit.
- 64 KiB stderr tail.
- 1s progress interval.

New runtime settings should be environment-driven only when they represent deployment/runtime policy rather than provider session choices. Provider session choices belong in the MCP tool contract and adapter configuration hooks.

## Where to put a change

| Change | Primary layer |
| --- | --- |
| New MCP field/result property | `src/server.ts` + `src/types.ts` |
| ACP lifecycle behavior shared by all providers | `src/runner/` |
| Provider CLI/auth/permission/session option | `src/adapters/<provider>.ts` |
| Persistent session compatibility | `src/store.ts` |
| Environment/runtime default | `src/config.ts` |
| Shutdown/stdio process behavior | `src/cli.ts` |
| New provider | adapter first, then wire types/config/server/store/tests/docs; follow `src/adapters/AGENTS.md` |

Favor extending the existing adapter contract over adding cross-layer special cases. That boundary is what keeps additional ACP agents cheap to integrate without duplicating the process/session engine.
