# codex-grok-relay

[English](README.md) | [简体中文](README.zh-CN.md)

A local stdio MCP relay that lets Codex delegate tasks to Grok, Cursor, or OpenCode through `grok_delegate`, `cursor_delegate`, and `opencode_delegate`. Each call starts an independent agent child process and uses a shared ACP v1 runner for authentication, session creation or resumption, and one prompt.

The relay handles protocol translation, session metadata, concurrency control for the same working directory, and process cleanup. Codex remains responsible for selecting worktrees, reviewing diffs, running tests, and integrating results.

## Quick Start

### Prerequisites

- Node.js 22+
- pnpm 11+
- The CLI for the selected backend installed and authenticated: Grok, Cursor, or OpenCode
- A local worktree or other working directory that the selected agent is allowed to use

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

To enable Cursor, add its executable explicitly to the same MCP server configuration:

```toml
[mcp_servers.grok-build.env]
GROK_RELAY_CURSOR_COMMAND = "/ABSOLUTE/PATH/TO/cursor-agent"
```

Use the actual Cursor CLI executable, regardless of its filename. Do not assume `agent` is Cursor: Grok installations may use the same command name. All three tools are registered even when Cursor is not configured; only Cursor calls then fail with a configuration error. Run Cursor's `login` command separately before delegation, or provide `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` through the relay environment. Never put credentials in tool arguments.

OpenCode defaults to the `opencode` executable. Override it only when the binary is not on `PATH`:

```toml
[mcp_servers.grok-build.env]
GROK_RELAY_OPENCODE_COMMAND = "/ABSOLUTE/PATH/TO/opencode"
```

Authenticate OpenCode with `opencode auth login` before delegation. The relay never starts a login UI or reads credentials from tool arguments.

Optionally add the recommended delegation guidance for all three tools to the global Codex instructions:

```bash
pnpm setup:codex-instructions
```

The script updates `$CODEX_HOME/AGENTS.md`, or `~/.codex/AGENTS.md` when `CODEX_HOME` is unset. It preserves other instructions and replaces the existing `GROK-BUILD` managed block with guidance for all three agents, without duplication. If a non-empty `AGENTS.override.md` exists in the same directory, Codex loads that file instead, and the script prints a warning.

## Basic Usage

For the first `grok_delegate` call, provide a task and working directory:

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

For a focused Cursor analysis, call `cursor_delegate`:

```json
{
  "task": "Review the authentication flow and report defects without editing files.",
  "cwd": "/absolute/path/to/worktree",
  "mode": "ask"
}
```

Omit `mode` for a new implementation session (`agent`). An optional `model` selects the model at process startup; omit it to use Cursor's default. Resume through the same tool with its returned `sessionId`. Omitted model/mode inherit the saved selection; explicitly different values require a new session.

For OpenCode, call `opencode_delegate`. New sessions inherit OpenCode's own defaults. Optional `model`, `effort`, and `agent` are applied after session create/resume/load through ACP `session/set_config_option` (`agent` maps to OpenCode's `mode` option). Omitted fields keep the native restored or default state; later calls may change them. Pass the returned `sessionId` to continue. `resume` defaults to true when `sessionId` is set; `resume: false` forces `session/load`. Specifying `resume` without `sessionId` is an input error.

## Tool Contract

The relay registers three MCP tools: `grok_delegate`, `cursor_delegate`, and `opencode_delegate`.

### Input

| Field | Type | Description |
| --- | --- | --- |
| `task` | Non-empty string | The task to send to the selected agent. Leading and trailing whitespace is trimmed. |
| `cwd` | String | An existing absolute directory. The relay resolves it with `realpath`; state binding and locking use the normalized path. |
| `sessionId` | Optional string | A session ID previously returned by the relay and bound to the same normalized `cwd`. |

Cursor additionally accepts `model?: string` and `mode?: "agent" | "ask"`. Plan mode is not exposed. OpenCode additionally accepts `resume?: boolean`, `model?: string`, `effort?: string`, and `agent?: string`. Grok's and Cursor's input and output contracts remain unchanged.

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
- `stopReason`: The stop reason returned by the agent. The relay does not invent one when a prompt fails.
- `text`: Agent text received so far, capped at 256 KiB.
- `truncated`: `true` when the text exceeds the limit. The relay continues reading the ACP stream and completes cleanup even after reaching the cap.
- `error`: A stable error code and human-readable message when the call fails.

Infrastructure, authentication, state, lock, ACP, or child-process failures also set MCP `isError: true`. If a session ID or partial text has already been obtained, the error response tries to preserve it. Prompt failures are not retried automatically.

Cursor results additionally include `provider: "cursor"` and optional bounded arrays: `toolCalls`, `todos`, `subagents`, `interactions`, and `images`. Their shared budget is the greater of 64 KiB and `GROK_RELAY_TEXT_LIMIT_BYTES`, separate from the text budget. Reaching it sets `summariesTruncated` and `truncated`; collection never reads generated image files. Permission failures retain a clipped request summary in `interactions`, evicting older summaries when necessary, so the caller can review what was rejected.

OpenCode results include `provider: "opencode"`, optional `usage` (`used`, `size`, and optional cumulative `cost` from the server; the relay never sums cost), and an optional bounded `toolCalls` array. Usage is the latest `usage_update` for the current prompt; replay and other-session updates are ignored. Reaching the summary budget sets `summariesTruncated` and `truncated`. Error results preserve these provider fields when they are already available.

## Sessions, Concurrency, and Lifecycle

The approximate lifecycle of a call is:

```text
Normalize cwd → acquire cwd lock → start agent → ACP initialize/authenticate
→ session/new, session/resume, or session/load → optional session/set_config_option
→ session/prompt → reap child and release lock
```

### Session resumption

- A new session binding is written to relay metadata before the prompt is sent.
- Grok metadata keeps its existing format and location. Cursor metadata is namespaced separately and also records the startup model selection and mode. OpenCode metadata uses the `opencode` namespace and stores only the session ID, cwd, and timestamps. Records use private permissions and hashed session filenames.
- Each backend stores its own conversation history. Grok and Cursor IDs resume through `session/load`. OpenCode prefers `session/resume` when initialize advertises `sessionCapabilities.resume`; otherwise it uses `session/load` only when `loadSession` is advertised. `resume: false` forces load. Resume/load failures never fall back to a new or replacement session. Grok, Cursor, and OpenCode IDs are never interchangeable.
- Unknown IDs, corrupt records, a different `cwd`, missing resume/load capability, or resume/load failures return explicit errors; the relay does not silently create a replacement session.

### Concurrency and cleanup

- The same normalized `cwd` uses an exclusive lock shared across all backends and relay processes; different worktrees can run in parallel.
- An existing lock is always treated as active, preventing a competitor from deleting a new owner's lock.
- Normal completion, cancellation, timeouts, disconnects, and parent-process signals reap the agent child process and release the lock.
- If the relay is terminated by `SIGKILL` and leaves a lock behind, first confirm that no corresponding agent process is running, then manually remove the corresponding file under the state directory's `locks/` directory.

## Configuration

All configuration is provided through environment variables. Tests can construct `RelayConfig` directly to inject a fake command and shorter timeouts; production configuration cannot override the fixed Grok sandbox arguments.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `GROK_RELAY_GROK_COMMAND` | `grok` | Grok executable path or command name. |
| `GROK_RELAY_CURSOR_COMMAND` | Unset | Explicit Cursor executable path or command name; required only for Cursor calls. |
| `GROK_RELAY_OPENCODE_COMMAND` | `opencode` | OpenCode executable path or command name. The relay spawns `opencode acp --cwd <canonical-cwd>` with `shell: false` and the same process cwd. |
| `GROK_RELAY_STATE_DIR` | `~/.local/state/codex-grok-relay` | Root directory for session metadata and cwd locks. |
| `GROK_RELAY_PHASE_TIMEOUT_MS` | `30000` | Per-phase timeout for startup, initialize, authentication, creation, and loading. |
| `GROK_RELAY_TOTAL_TIMEOUT_MS` | `3600000` | Total timeout for one call, or 3600 seconds. |
| `GROK_RELAY_CANCEL_GRACE_MS` | `5000` | Time to wait for ACP `session/cancel` and child-process exit during cancellation. |
| `GROK_RELAY_TERM_GRACE_MS` | `2000` | Time to wait after SIGTERM before escalating to SIGKILL. |
| `GROK_RELAY_TEXT_LIMIT_BYTES` | `262144` | Maximum agent text retained for one response. |
| `GROK_RELAY_STDERR_LIMIT_BYTES` | `65536` | Maximum agent stderr retained. |
| `GROK_RELAY_PROGRESS_INTERVAL_MS` | `1000` | Minimum interval between tool-call progress notifications. |

## Authentication, Permissions, and Security Boundaries

### Authentication

The relay never starts interactive login and never reads credentials from tool arguments. Authentication is selected in this order:

1. If Grok advertises `xai.api_key` and `XAI_API_KEY` is present in the environment, use the API key.
2. Otherwise, if Grok advertises `cached_token`, use Grok's cached token.
3. If neither is available, return an authentication error.

Cursor requires advertised `cursor_login`. OpenCode authenticates with advertised `opencode-login`; if `authMethods` is empty, authentication is skipped; if only unknown methods are advertised, the call fails with `AUTH_UNAVAILABLE`. Grok and Cursor authentication is unchanged.

The relay always starts Grok with these arguments:

```text
grok --no-auto-update --sandbox workspace agent --always-approve --no-leader stdio
```

### Important boundaries

- The `workspace` sandbox can read the host filesystem, can write to the current `cwd`, `~/.grok`, and temporary directories, and allows network access.
- This is an OS-level write restriction, not complete host-read or network isolation. A worktree must not be treated as a security boundary.
- If the sandbox fails to start, the relay does not fall back to running without a sandbox.
- The relay does not create worktrees, generate Git patches or `task_id` values, or expose client-file or terminal ACP capabilities to any backend.
- Even with `--always-approve`, if Grok unexpectedly requests permission, the relay returns cancelled and marks the call as an error.
- The relay does not claim an OS sandbox for OpenCode. Native OpenCode subagents and project MCP servers remain enabled.

These Grok sandbox details are not a description of Cursor's or OpenCode's isolation. Codex should select an appropriate worktree before delegation, then inspect the actual diff, run relevant tests, and complete the final review. Do not decide whether a change is acceptable from the worker's natural-language summary alone.

### Cursor permissions and interactions

Cursor starts with `--sandbox enabled`, using its existing sandbox and permission configuration. The relay does not modify these files or add `--force`, `--yolo`, or `--approve-mcps`. `full-access` is not exposed. Cursor's native allow/deny rules run first, with deny taking precedence. For example, a project `.cursor/cli.json` may allow a specific read while denying secrets:

```json
{
  "permissions": {
    "allow": ["Read(src/**/*.ts)"],
    "deny": ["Read(.env*)", "Write(**/*.key)"]
  }
}
```

An extra `session/request_permission` request is rejected using its `reject_once` option, or cancelled if no such option exists. The relay cancels the task and returns `PERMISSION_REQUIRED` with partial output and request information. Review that information and coordinate any necessary policy change before resuming; repeated calls do not authorize bypassing the rejection.

The bridge does not launch interactive login or ask users questions. `cursor/ask_question` receives `skipped`; `cursor/create_plan` receives `rejected`. Both are summarized in the result. A task prefix asks Cursor to handle minor ambiguity conservatively and stop/report material decisions.

Ask mode is an agent behavior setting, not an OS read-only guarantee. Actual filesystem and network boundaries depend on Cursor's effective sandbox configuration, including user/project overrides. Sandbox failures never trigger an automatic unsandboxed retry. See [Cursor ACP](https://cursor.com/cn/docs/cli/acp), [CLI parameters](https://cursor.com/docs/cli/reference/parameters), [permissions](https://cursor.com/docs/cli/reference/permissions), and [sandbox configuration](https://cursor.com/docs/reference/sandbox).

### OpenCode permissions and configuration

OpenCode starts as `opencode acp --cwd <canonical-cwd>` with the process cwd set to the same path. The relay does not write `OPENCODE_CONFIG_CONTENT` or any user/project OpenCode config file. For the child process only, it overlays `OPENCODE_PERMISSION` with `question: "deny"` while preserving other keys already present in that environment variable. If `OPENCODE_PERMISSION` is already set, it must be a JSON object; otherwise the call fails with a configuration error that does not echo the value.

That overlay is not hard isolation. OpenCode 1.18.29 merges `OPENCODE_PERMISSION` into config, and a global `question: deny` can still be overridden by agent-specific permission rules. The prompt tells OpenCode this is a noninteractive delegated task: do not ask the user questions, resolve minor ambiguity conservatively, and stop/report material unresolved decisions. If a question still blocks, the call times out. The relay does not claim OS sandboxing or filesystem isolation for OpenCode.

When OpenCode sends `session/request_permission`, the relay selects the option whose kind is `allow_once` and returns that option's actual `optionId`. It never selects `allow_always`. If `allow_once` is missing, the permission is cancelled, the task fails with `PERMISSION_REQUIRED`, and partial output is preserved. A cancelled request is not approved afterward. Permission requests for a different session are cancelled without approval.

Optional `model`, `effort`, and `agent` values are validated against the latest returned `configOptions`, including grouped select options, and applied in that order. After each `session/set_config_option` the relay refreshes the option list. Invalid or unsupported values return a stable error and do not send a prompt. The relay does not copy Cursor's locked model/mode rules and does not store a separate OpenCode options replica.

### Prevent recursive delegation

Do not configure this relay as an MCP server for downstream Cursor, Grok, or OpenCode agents. In particular, Cursor can load project and user `.cursor/mcp.json`; an empty ACP `mcpServers` list does not disable those configurations. OpenCode likewise keeps native project MCP servers. Workers inherit the internal `GROK_RELAY_DELEGATED=1` marker, and relay calls made under that marker are rejected. This is an inherited-environment loop guard, not an isolation mechanism; wrappers that remove the marker defeat it.

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

Cursor real tests are separately opt-in and require `GROK_RELAY_CURSOR_COMMAND`, authentication, and quota:

```bash
pnpm test:real:cursor
```

OpenCode real tests are separately opt-in and require the OpenCode CLI, authentication, and quota:

```bash
pnpm test:real:opencode
```

Regular `pnpm test` skips all real integration suites. Automated tests cover session creation and resumption, backend isolation, model/mode binding, authentication, cwd locks, timeouts/cancellation, process-group cleanup, bounded output, progress, Cursor extensions and permission rejection, Grok's unexpected permission behavior, and OpenCode resume/load dispatch, dynamic configuration, `allow_once` approval, usage, and permission overlay. Real tests are not evidence of full sandbox isolation; report any skipped live scenarios explicitly.
