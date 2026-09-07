# codex-grok-relay

[English](README.md) | [简体中文](README.zh-CN.md)

A local stdio MCP relay that lets Codex delegate tasks to the Grok CLI through a single tool, `grok_delegate`. Each call starts an independent Grok child process and uses ACP v1 for authentication, session creation or resumption, and one prompt.

The relay handles protocol translation, session metadata, concurrency control for the same working directory, and process cleanup. Codex remains responsible for selecting worktrees, reviewing diffs, running tests, and integrating results.

## Quick Start

### Prerequisites

- Node.js 22+
- pnpm 11+
- The Grok CLI installed and configured with a non-interactive authentication method
- A local worktree or other working directory that Grok is allowed to modify

### Install, check, and build

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The build output is `dist/cli.js`. Register it as a Codex MCP server using an absolute local path:

```toml
[mcp_servers.grok-build]
command = "node"
args = ["/ABSOLUTE/PATH/codex-grok-relay/dist/cli.js"]
startup_timeout_sec = 10
tool_timeout_sec = 3660
```

`tool_timeout_sec` should cover the relay's default 3600-second total call limit. The relay uses stdout only for MCP protocol traffic and writes diagnostics to stderr.

## Basic Usage

For the first call, provide a task and working directory:

```json
{
  "task": "Inspect the current changes, run the relevant tests, and summarize any issues.",
  "cwd": "/absolute/path/to/worktree"
}
```

Example successful response:

```json
{
  "sessionId": "opaque-session-id",
  "stopReason": "end_turn",
  "text": "Inspection completed; all tests passed.",
  "truncated": false
}
```

To resume the same Grok session, pass the returned `sessionId` together with the same `cwd`:

```json
{
  "task": "Continue by fixing the issues found in the previous turn.",
  "cwd": "/absolute/path/to/worktree",
  "sessionId": "opaque-session-id"
}
```

Delegated tasks should state the allowed modification scope, acceptance criteria, and checks to run. Independent tasks can run in parallel in different worktrees.

## Tool Contract

The relay registers exactly one MCP tool: `grok_delegate`.

### Input

| Field | Type | Description |
| --- | --- | --- |
| `task` | Non-empty string | The task to send to Grok. Leading and trailing whitespace is trimmed. |
| `cwd` | String | An existing absolute directory. The relay resolves it with `realpath`; state binding and locking use the normalized path. |
| `sessionId` | Optional string | A session ID previously returned by the relay and bound to the same normalized `cwd`. |

### Output

The text response and `structuredContent` contain the same JSON object:

```json
{
  "sessionId": "opaque-id-or-null",
  "stopReason": "end_turn-or-null",
  "text": "Grok response",
  "truncated": false,
  "error": {
    "code": "OPTIONAL_CODE",
    "message": "optional message"
  }
}
```

- `sessionId`: Returned after a session is created; if a failure occurs after an ID is obtained, the relay tries to preserve it.
- `stopReason`: The stop reason returned by Grok. The relay does not invent one when a prompt fails.
- `text`: Grok text received so far, capped at 256 KiB.
- `truncated`: `true` when the text exceeds the limit. The relay continues reading the ACP stream and completes cleanup even after reaching the cap.
- `error`: A stable error code and human-readable message when the call fails.

Infrastructure, authentication, state, lock, ACP, or child-process failures also set MCP `isError: true`. If a session ID or partial text has already been obtained, the error response tries to preserve it. Prompt failures are not retried automatically.

## Sessions, Concurrency, and Lifecycle

The approximate lifecycle of a call is:

```text
Normalize cwd → acquire cwd lock → start Grok → ACP initialize/authenticate
→ session/new or session/load → session/prompt → reap child and release lock
```

### Session resumption

- A new session binding is written to relay metadata before the prompt is sent.
- The relay stores only the version, session ID, normalized `cwd`, and timestamps. The filename is the SHA-256 digest of the session ID, and the file uses private permissions.
- Grok stores the actual conversation history. To resume, the relay reads its metadata and calls Grok `session/load`.
- Unknown IDs, corrupt records, a different `cwd`, missing load capability, or load failures return explicit errors; the relay does not silently create a replacement session.

### Concurrency and cleanup

- The same normalized `cwd` uses an exclusive lock shared across relay processes; different worktrees can run in parallel.
- An existing lock is always treated as active, preventing a competitor from deleting a new owner's lock.
- Normal completion, cancellation, timeouts, disconnects, and parent-process signals reap the Grok child process and release the lock.
- If the relay is terminated by `SIGKILL` and leaves a lock behind, first confirm that no corresponding Grok process is running, then manually remove the corresponding file under the state directory's `locks/` directory.

## Configuration

All configuration is provided through environment variables. Tests can construct `RelayConfig` directly to inject a fake command and shorter timeouts; production configuration cannot override the fixed Grok sandbox arguments.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `GROK_RELAY_GROK_COMMAND` | `grok` | Grok executable path or command name. |
| `GROK_RELAY_STATE_DIR` | `~/.local/state/codex-grok-relay` | Root directory for session metadata and cwd locks. |
| `GROK_RELAY_PHASE_TIMEOUT_MS` | `30000` | Per-phase timeout for startup, initialize, authentication, creation, and loading. |
| `GROK_RELAY_TOTAL_TIMEOUT_MS` | `3600000` | Total timeout for one call, or 3600 seconds. |
| `GROK_RELAY_CANCEL_GRACE_MS` | `5000` | Time to wait for ACP `session/cancel` and child-process exit during cancellation. |
| `GROK_RELAY_TERM_GRACE_MS` | `2000` | Time to wait after SIGTERM before escalating to SIGKILL. |
| `GROK_RELAY_TEXT_LIMIT_BYTES` | `262144` | Maximum Grok text retained for one response. |
| `GROK_RELAY_STDERR_LIMIT_BYTES` | `65536` | Maximum Grok stderr retained. |
| `GROK_RELAY_PROGRESS_INTERVAL_MS` | `1000` | Minimum interval between tool-call progress notifications. |

## Authentication, Permissions, and Security Boundaries

### Authentication

The relay never starts interactive login. Authentication is selected in this order:

1. If Grok advertises `xai.api_key` and `XAI_API_KEY` is present in the environment, use the API key.
2. Otherwise, if Grok advertises `cached_token`, use Grok's cached token.
3. If neither is available, return an authentication error.

The relay always starts Grok with these arguments:

```text
grok --no-auto-update --sandbox workspace agent --always-approve --no-leader stdio
```

### Important boundaries

- The `workspace` sandbox can read the host filesystem, can write to the current `cwd`, `~/.grok`, and temporary directories, and allows network access.
- This is an OS-level write restriction, not complete host-read or network isolation. A worktree must not be treated as a security boundary.
- If the sandbox fails to start, the relay does not fall back to running without a sandbox.
- The relay does not create worktrees, generate Git patches or `task_id` values, provide multiple backends, or expose client-file or terminal ACP capabilities to Grok.
- Even with `--always-approve`, if Grok unexpectedly requests permission, the relay returns cancelled and marks the call as an error.

Codex should select an appropriate worktree before delegation, then inspect the actual diff, run relevant tests, and complete the final review. Do not decide whether a change is acceptable from Grok's natural-language summary alone.

## Testing and Verification

Standard quality checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Real Grok integration tests incur API call costs, require explicit opt-in, and depend on the Grok CLI, authentication, and available quota:

```bash
pnpm test:real
```

Regular `pnpm test` does not run `test/real-smoke.test.ts`. The test suite covers session creation and resumption, authentication selection, state binding, cwd locks, timeouts and cancellation, process-group cleanup, output truncation, progress notifications, and unexpected permission requests.
