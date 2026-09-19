# Architecture

This document explains the durable component boundaries and runtime invariants of `codex-agent-relay`. For day-to-day agent instructions, start with [`AGENTS.md`](AGENTS.md).

## System context

The relay sits between **Codex/MCP** and locally installed **ACP coding-agent CLIs**:

```text
Codex
  │ MCP over stdio
  ▼
src/cli.ts → src/cli-runtime.ts
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
(Grok / Cursor / OpenCode / DSH)
```

The relay is an orchestration boundary, not a second autonomous planner. Codex chooses what to delegate and reviews/integrates the result; the relay executes one non-interactive provider turn and returns a resumable session ID plus bounded output.

## Layer boundaries

### `src/cli.ts` and `src/cli-runtime.ts`: process boundary

Responsibilities:

- `src/cli.ts` loads environment-derived configuration and enters the runtime.
- The runtime starts the MCP server on stdio and owns the testable shutdown coordinator.
- `SIGINT`, `SIGTERM`, `SIGHUP`, and stdin EOF synchronously close the runner admission gate and share one shutdown operation.
- MCP transport close has a fixed five-second timeout and runs in parallel with mandatory runner cleanup. Cleanup has no global timeout.
- Exit waits for every snapshotted task's process and lease finalization. A clean close exits `0`; transport, cleanup, lease, or shutdown-reporting failures exit `1` with bounded stderr diagnostics.

Do not move provider behavior here.

### `src/server.ts`: MCP contract boundary

Responsibilities:

- Define Zod schemas for MCP tool inputs and structured outputs.
- Register `grok_delegate`, `cursor_delegate`, `opencode_delegate`, and `dsh_delegate`.
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
14. Terminate the worker process tree and release the workspace lock only after cleanup is confirmed.

Provider-name branches should not be added here when the `ProviderAdapter` contract can express the difference.

### `src/runner/*`: shared execution primitives

- `types.ts` defines `ProviderAdapter`, summarizer, permission runtime, and session configuration extension points.
- `limits.ts` bounds output and supplies timeout helpers.
- `summaries.ts` converts high-volume provider updates into bounded structured summaries. Standard usage/tool-call summaries require an explicit provider; `OpenCodeSummaries(limit)` remains a thin `"opencode"` wrapper.
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

- The real/resolved `cwd` is hashed into a private `<hash>.lock/` directory created with non-recursive `mkdir` as the atomic acquisition step.
- `owner.json` records a random owner token, hostname, relay PID, lifecycle phase, and the bound process-tree reference. Lease transitions validate the token, serialize updates, reject state regression, and release only from `reaped`.
- Release and stale recovery rename the lock directory to a permanent, nonempty `<hash>.retired.<old-token>/` tombstone. The old token in the target makes concurrent reclaimers fail safely instead of moving or deleting a newer generation.
- Existing records are read with a 16 KiB limit and strict schema validation. Symlinks, empty/corrupt records, unknown formats, mismatched hosts/platforms, and uncertain process probes fail closed.
- A live owner returns `WORKSPACE_BUSY`. A dead owner is reclaimed only for `reaped`, pre-spawn `locked`, or a POSIX worker whose process group is confirmed gone. Unsafe crash states return `WORKSPACE_ORPHANED`; legacy stale locks return `STALE_LOCK_UNVERIFIED`.
- Independent working directories can run concurrently.

Session records and workspace lease records are persistent state. Lease version 1 intentionally does not migrate legacy file locks automatically because those records cannot prove descendant cleanup. Do not mix relay versions against one state directory.

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
  └─ mark terminating → child cleanup → mark reaped → retire lease
       ▼
structured MCP result
```

## Session semantics

The relay persists only the metadata needed to safely reconnect Codex to a provider-owned ACP session. The provider remains the source of truth for conversation state.

Important consequences:

- A returned `sessionId` is provider-specific and must be sent back to the same MCP tool/provider.
- A session is tied to the resolved working directory to prevent accidental continuation in another checkout/worktree.
- Provider options that must remain stable across a session belong in persisted metadata when necessary. Cursor currently persists model/mode semantics; Grok, OpenCode, and DSH currently do not persist extra adapter metadata.
- Provider capability negotiation decides whether an existing session can be resumed or loaded.

## Provider behavior matrix

| Concern | Grok | Cursor | OpenCode | DSH |
| --- | --- | --- | --- | --- |
| CLI default | `grok` | explicit `CODEX_AGENT_RELAY_CURSOR_COMMAND` required | `opencode` | `dsh --profile acp` |
| Authentication | `xai.api_key` when available, otherwise `cached_token` | `cursor_login` | `opencode-login` when advertised; no auth request when none advertised | no authenticate request |
| Existing session | common load behavior | common load behavior with persisted mode/model checks | prefers ACP resume, falls back to load; `resume: false` forces load | resume only when advertised; never load or fall back to new |
| Interactive questions | not supported | question requests are skipped; plan approval rejected | question permission is disabled in child env | noninteractive prompt prefix only |
| Permission request | unexpected -> fail/cancel | reject once when possible and fail with structured summary | allow once when offered; otherwise fail | reject once when offered; never allow; fail with PERMISSION_REQUIRED. Refuses automatic approvals, not hard isolation |
| Provider summaries | plain text result | tool calls, todos, subagents, interactions, images | usage and tool-call summaries | usage and tool-call summaries |

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

The runner first attempts the ACP session-cancel notification when possible, waits within the cancellation grace period, then terminates the process tree. Cancellation and termination are single-flight operations so concurrent shutdown paths do not repeat notifications or signals.

On POSIX systems the provider is spawned in its own process group. Cleanup sends group-level `SIGTERM`, escalates to `SIGKILL`, and confirms both group disappearance and direct-child exit; processes that escape the original group are outside this guarantee. After those signals, confirmation retries transient unknown process-group probes (`EPERM` and other non-`ESRCH` errors) only inside the existing TERM/KILL confirmation deadlines, then fails closed if the last probe is still unknown. `EPERM` and direct-child exit alone never count as group disappearance. Windows invokes the absolute `%SystemRoot%\System32\taskkill.exe` path with `/T /F`, without a shell, and confirms both a successful helper exit and direct-child exit. This is confirmation of the `taskkill` operation, not Job Object or crash-proof containment. A Windows root that exits before tree termination is conservatively unconfirmed because the relay can no longer establish descendant cleanup.

If process-tree cleanup is unconfirmed, the runner returns `PROCESS_CLEANUP_FAILED`, preserves partial task output, and attempts to mark the lease `orphaned` without releasing it. Metadata failures never skip actual process cleanup. Once cleanup is confirmed, the runner must persist `reaped` before it can retire the lease. Error precedence is cleanup failure, then lease ownership/I/O failure, then the original task failure.

Crash recovery is deliberately conservative. Automatic recovery requires the same hostname and a compatible process-tree kind; records without a worker reference assume that the same hostname is also the same OS and PID namespace. The protocol does not provide Job Object containment, durable-write guarantees across power loss, or safe recovery from copied/manually edited state. Retired tombstones are not removed during normal startup and may be cleaned only offline.

`cleanupAllChildren()` snapshots the currently registered tasks, requests all cancellations in parallel, waits for their process-tree and lease-finalization reports, and throws a bounded `CleanupAggregateError` when any final cleanup is unconfirmed. Ordinary task failures and transient cancellation errors do not make shutdown fail when final cleanup succeeds. The reusable function does not close admission.

`beginRunnerShutdown()` is the CLI boundary: it synchronously closes the process-wide admission gate, immediately snapshots active tasks through `cleanupAllChildren()`, and caches that exact result for every later caller. A request that was still resolving its `cwd` before shutdown is rejected by the runner before lock acquisition or spawn. The gate remains closed for the process lifetime.

The CLI starts transport close and runner shutdown together. Transport exceptions and timeouts cannot skip worker cleanup, and repeated signals or EOF reuse the same coordinator promise. SDK errors reported during shutdown count as close failures even if `close()` resolves. Shutdown diagnostics remain on stderr and are bounded to 8 KiB; stdout remains reserved for MCP traffic. There is deliberately no global cleanup deadline, so an indefinitely blocked filesystem operation can keep the process alive rather than exit before lease state is safe.

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
- 2s forced-termination confirmation (`CODEX_AGENT_RELAY_KILL_CONFIRM_MS`).
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
