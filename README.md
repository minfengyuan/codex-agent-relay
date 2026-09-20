# codex-agent-relay

[English](README.md) | [简体中文](README.zh-CN.md)

Delegate Codex tasks to **Grok**, **Cursor**, **OpenCode**, and **DSH** through one local MCP server.

`codex-agent-relay` bridges Codex MCP calls to ACP-capable coding agents. Codex stays in charge of orchestration and review; the relay handles delegation and returns the agent result together with a resumable session ID.

## Why use it?

- **One MCP server, multiple coding agents** — switch between Grok, Cursor, OpenCode, and DSH without changing the Codex workflow.
- **Resumable sessions** — continue a delegated task instead of starting from scratch every turn.
- **Worktree-friendly delegation** — run independent tasks in different working directories in parallel.
- **Local-first** — agents run through their local CLIs and use their existing authentication and configuration.
- **Codex remains the orchestrator** — review diffs, run tests, and decide what to integrate from one place.

## Supported agents

| Agent | MCP tool | Typical use |
| --- | --- | --- |
| Grok | `grok_delegate` | General implementation, debugging, and review |
| Cursor | `cursor_delegate` | Agent or ask-mode coding tasks |
| OpenCode | `opencode_delegate` | Coding tasks with optional model/effort/agent selection |
| DSH | `dsh_delegate` | Coding tasks with optional model/reasoning effort; resume only |

## Quick start

### 1. Prerequisites

- Node.js 22+
- pnpm 12+
- At least one supported agent CLI installed and authenticated

### 2. Install and build

```bash
git clone https://github.com/minfengyuan/codex-agent-relay.git
cd codex-agent-relay
pnpm install
pnpm build
```

The MCP entry point is `dist/cli.js`.

### 3. Add it to Codex

Add the relay to your Codex MCP configuration using an absolute path:

```toml
[mcp_servers.codex_agent_relay]
command = "node"
args = ["/ABSOLUTE/PATH/codex-agent-relay/dist/cli.js"]
startup_timeout_sec = 10
tool_timeout_sec = 3660
```

Grok defaults to the `grok` command, OpenCode defaults to `opencode`, and DSH defaults to `dsh --profile acp`. Cursor must be configured explicitly:

```toml
[mcp_servers.codex_agent_relay.env]
CODEX_AGENT_RELAY_CURSOR_COMMAND = "/ABSOLUTE/PATH/TO/cursor-agent"
```

If needed, the Grok, OpenCode, and DSH executables can also be overridden with `CODEX_AGENT_RELAY_GROK_COMMAND`, `CODEX_AGENT_RELAY_OPENCODE_COMMAND`, and `CODEX_AGENT_RELAY_DSH_COMMAND`. DSH arguments have no environment override; the relay always launches with `--profile acp`.

On Windows, the relay does not spawn `dsh.cmd` through `cmd.exe` or `shell: true`. It resolves a bare or configured command with `PATH`/`PATHEXT`, keeps native `.exe`/`.com` launchers, runs `.js`/`.mjs` entries with the current Node executable, and for known npm/pnpm `.cmd` shims it validates the generated launcher structure, verifies that the referenced file is the package's `bin.dsh`, then spawns `node` with that entry plus the original DSH arguments. Unsupported `.bat` files, malformed shims, missing entries, and mismatched packages fail with `ACP_FAILURE`. Safe `CODEX_AGENT_RELAY_DSH_COMMAND` overrides are a native DSH executable or the official DSH `.js`/`.mjs` entry.

Process cleanup can be tuned in milliseconds with `CODEX_AGENT_RELAY_CANCEL_GRACE_MS` (ACP cancellation grace), `CODEX_AGENT_RELAY_TERM_GRACE_MS` (POSIX `SIGTERM` grace), and `CODEX_AGENT_RELAY_KILL_CONFIRM_MS` (forced-termination confirmation, default `2000`). Invalid or non-positive values use their defaults.

### 4. Optional: install delegation guidance

```bash
pnpm setup:codex-instructions
```

This adds the recommended delegation guidance to your Codex instructions while preserving unrelated content.

## Usage

Once configured, ask Codex to delegate work in natural language, for example:

```text
Use Grok to review the current changes in /path/to/worktree and run the relevant tests.

Ask Cursor to inspect the authentication flow without editing files.

Delegate this implementation task to OpenCode in /path/to/worktree.

Delegate this implementation task to DSH in /path/to/worktree.
```

The relay exposes four tools:

- `grok_delegate`
- `cursor_delegate`
- `opencode_delegate`
- `dsh_delegate`

Each call needs a task and an absolute working directory. Returned `sessionId` values can be passed back to the same tool to continue the conversation with that agent.

### DSH (`dsh_delegate`)

DSH is DeepSeek Harness. Install and configure the `dsh` CLI before delegating. Production calls and opt-in real-test preflights (`--version` and `--profile acp --help`) use the same launcher resolution: `dsh --profile acp` on POSIX, and on Windows a `shell: false` spawn of `node` plus the verified `@deepseek-ai/dsh` entry when the PATH hit is an npm/pnpm `.cmd` shim.

Tool inputs:

| Input | Required | Notes |
| --- | --- | --- |
| `task` | yes | Non-empty after trim |
| `cwd` | yes | Existing absolute working directory |
| `sessionId` | no | Previously returned DSH session ID (resume only; there is no `resume` boolean) |
| `model` | no | Opaque advertised `model` session option |
| `reasoningEffort` | no | Opaque advertised `reasoning_effort` session option |

When both `model` and `reasoningEffort` are set, the relay applies `model` first, then `reasoning_effort`, using the option values advertised by the current session. Omitting either field leaves the CLI's existing configuration unchanged. Invalid advertised values fail closed (`INVALID_CONFIG` / `CONFIG_UNSUPPORTED`).

Successful results include `provider: "dsh"` plus bounded `text`, optional `toolCalls` / `usage`, and `summariesTruncated` when summaries were capped. Permission requests are refused (`reject_once` when offered) and abort with `PERMISSION_REQUIRED`.

Real DSH smoke tests are opt-in (`pnpm test:real:dsh` or `RUN_DSH_REAL_TESTS=1`). Optional `DSH_TEST_MODEL` and `DSH_TEST_REASONING_EFFORT` exercise config-on-resume coverage when set.

## Recommended workflow

```text
Codex chooses a task and worktree
        ↓
codex-agent-relay delegates it
        ↓
Grok / Cursor / OpenCode / DSH works locally
        ↓
Codex reviews the result, diff, and tests
        ↓
Codex integrates or follows up
```

Use separate worktrees for independent tasks when you want parallel delegation. Calls targeting the same working directory are serialized to avoid agents modifying it concurrently.

## Important notes

- Authenticate each agent CLI before delegating work. Credentials should not be placed in task arguments.
- The relay does not create worktrees or automatically accept an agent's changes.
- Filesystem, network, and permission behavior ultimately depends on the selected agent and its local configuration. For DSH, the relay refuses automatic ACP approvals (`reject_once` when offered) and returns `PERMISSION_REQUIRED`; that is not hard filesystem or network isolation. Saved DSH sessions and deployment configuration still apply.
- DSH existing sessions are resumed only when the CLI advertises resume. The relay never loads a session or falls back to creating a new one; missing resume capability returns `RESUME_UNSUPPORTED`.
- A delegated worker is terminated as a process tree. If cleanup cannot be confirmed, the relay returns `PROCESS_CLEANUP_FAILED`, marks the workspace lease orphaned when possible, and keeps it locked. Later calls return `WORKSPACE_BUSY` while the owner is alive; after its death, unresolved worker cleanup returns `WORKSPACE_ORPHANED`.
- `SIGINT`, `SIGTERM`, `SIGHUP`, and stdin EOF start one shared shutdown operation. The relay immediately stops accepting delegation, closes the MCP transport with a 5-second close timeout, and waits without a global deadline for every already-registered task to finish process-tree cleanup and workspace-lease finalization. Repeated shutdown events do not bypass cleanup or repeat cancellation.
- A clean signal/EOF shutdown exits with status `0`. Transport-close, process-cleanup, or lease-finalization failures are reported on stderr and exit with status `1`; an unconfirmed worker keeps its lease locked. Because runner cleanup has no forced deadline, a permanently blocked filesystem operation can also keep shutdown waiting.
- On Windows the relay uses the absolute `%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F` command. This confirms the result of that operation; it is not Job Object or crash-proof containment. If the root process exits before tree termination begins, descendant cleanup cannot be confirmed and the lock is retained. POSIX cleanup covers only the worker's original process group.
- Workspace locks are private lease directories with owner tokens and lifecycle state. A new relay automatically recovers only states it can verify safely: a reaped lease, a lease that never began spawning, or a dead POSIX owner whose recorded process group is gone. Live owners remain `WORKSPACE_BUSY`; legacy locks, unknown owner probes, and locks from another hostname/platform fail closed. A dead Windows owner with a non-reaped worker remains orphaned because a missing root PID does not prove that descendants exited.
- Do not run old and new relay versions against the same state directory during an upgrade. Recovery assumes that a matching hostname represents the same OS and PID namespace when a pre-spawn record has no worker reference; copied state directories violate that assumption. The lease protocol is conservative after crashes but does not promise unattended recovery after storage loss, power failure, or manual state changes.
- Use a local filesystem for the state directory, within one host and PID namespace. `STALE_LOCK_UNVERIFIED` means the record or owner cannot be safely verified; `WORKSPACE_ORPHANED` means a dead owner's worker may remain; `LOCK_OWNERSHIP_LOST` means a lease no longer owns the on-disk lock. Legacy lock files are read only and never automatically migrated or removed.
- To recover manually, first stop every relay using the state directory and independently confirm that the recorded worker and descendants are gone. Only then remove the affected `.lock` directory. Retired token tombstones prevent ABA races and are intentionally permanent during normal operation; clean them only offline while all relays are stopped.
- Treat delegated output as work to review: inspect the actual diff and run the relevant checks before integrating it.

## Development

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

On Windows, Vitest runs test files serially to avoid contention between simultaneous process-tree teardown operations. Other platforms keep Vitest's default file parallelism; concurrency within an individual test file is unchanged.

For real-agent smoke tests, see the `test:real`, `test:real:cursor`, `test:real:opencode`, and `test:real:dsh` scripts in `package.json`. Default `pnpm test` skips real DSH tests; `pnpm test:real:dsh` (or `RUN_DSH_REAL_TESTS=1`) fails if the local `dsh` CLI is unavailable.
