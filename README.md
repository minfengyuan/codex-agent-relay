# codex-agent-relay

[English](README.md) | [简体中文](README.zh-CN.md)

Delegate Codex tasks to **Grok**, **Cursor**, and **OpenCode** through one local MCP server.

`codex-agent-relay` bridges Codex MCP calls to ACP-capable coding agents. Codex stays in charge of orchestration and review; the relay handles delegation and returns the agent result together with a resumable session ID.

## Why use it?

- **One MCP server, multiple coding agents** — switch between Grok, Cursor, and OpenCode without changing the Codex workflow.
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

## Quick start

### 1. Prerequisites

- Node.js 22+
- pnpm 11+
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

Grok defaults to the `grok` command and OpenCode defaults to `opencode`. Cursor must be configured explicitly:

```toml
[mcp_servers.codex_agent_relay.env]
CODEX_AGENT_RELAY_CURSOR_COMMAND = "/ABSOLUTE/PATH/TO/cursor-agent"
```

If needed, the Grok and OpenCode executables can also be overridden with `CODEX_AGENT_RELAY_GROK_COMMAND` and `CODEX_AGENT_RELAY_OPENCODE_COMMAND`.

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
```

The relay exposes three tools:

- `grok_delegate`
- `cursor_delegate`
- `opencode_delegate`

Each call needs a task and an absolute working directory. Returned `sessionId` values can be passed back to the same tool to continue the conversation with that agent.

## Recommended workflow

```text
Codex chooses a task and worktree
        ↓
codex-agent-relay delegates it
        ↓
Grok / Cursor / OpenCode works locally
        ↓
Codex reviews the result, diff, and tests
        ↓
Codex integrates or follows up
```

Use separate worktrees for independent tasks when you want parallel delegation. Calls targeting the same working directory are serialized to avoid agents modifying it concurrently.

## Important notes

- Authenticate each agent CLI before delegating work. Credentials should not be placed in task arguments.
- The relay does not create worktrees or automatically accept an agent's changes.
- Filesystem, network, and permission behavior ultimately depends on the selected agent and its local configuration.
- Treat delegated output as work to review: inspect the actual diff and run the relevant checks before integrating it.

## Development

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For real-agent smoke tests, see the `test:real`, `test:real:cursor`, and `test:real:opencode` scripts in `package.json`.
