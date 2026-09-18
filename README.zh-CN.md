# codex-agent-relay

[English](README.md) | [简体中文](README.zh-CN.md)

通过一个本地 MCP Server，让 Codex 将任务委派给 **Grok**、**Cursor** 和 **OpenCode**。

`codex-agent-relay` 用来连接 Codex 与支持 ACP 的 Coding Agent。Codex 负责统一编排和最终审查，relay 负责把任务交给对应 Agent，并返回执行结果和可继续使用的会话 ID。

## 为什么使用它？

- **一个 MCP Server，对接多个 Coding Agent** —— 无需改变 Codex 工作流，即可在 Grok、Cursor 和 OpenCode 之间切换。
- **支持会话续接** —— 后续任务可以继续已有 Agent 会话，而不是每轮都从头开始。
- **适合 Worktree 工作流** —— 不同工作目录中的独立任务可以并行委派。
- **本地优先** —— Agent 通过本地 CLI 运行，并继续使用各自已有的认证和配置。
- **Codex 仍是总控** —— diff 审查、测试验证和最终集成都留在 Codex 一侧完成。

## 支持的 Agent

| Agent | MCP 工具 | 典型用途 |
| --- | --- | --- |
| Grok | `grok_delegate` | 通用实现、调试和代码审查 |
| Cursor | `cursor_delegate` | Agent / Ask 模式的编码与分析任务 |
| OpenCode | `opencode_delegate` | 支持可选模型、effort 和 agent 配置的编码任务 |

## 快速开始

### 1. 前置条件

- Node.js 22+
- pnpm 12+
- 至少安装并完成认证一个受支持的 Agent CLI

### 2. 安装与构建

```bash
git clone https://github.com/minfengyuan/codex-agent-relay.git
cd codex-agent-relay
pnpm install
pnpm build
```

MCP 入口文件为 `dist/cli.js`。

### 3. 接入 Codex

在 Codex 的 MCP 配置中使用绝对路径注册 relay：

```toml
[mcp_servers.codex_agent_relay]
command = "node"
args = ["/ABSOLUTE/PATH/codex-agent-relay/dist/cli.js"]
startup_timeout_sec = 10
tool_timeout_sec = 3660
```

Grok 默认使用 `grok` 命令，OpenCode 默认使用 `opencode`。Cursor 需要显式配置可执行文件：

```toml
[mcp_servers.codex_agent_relay.env]
CODEX_AGENT_RELAY_CURSOR_COMMAND = "/ABSOLUTE/PATH/TO/cursor-agent"
```

如有需要，也可以通过 `CODEX_AGENT_RELAY_GROK_COMMAND` 和 `CODEX_AGENT_RELAY_OPENCODE_COMMAND` 覆盖 Grok / OpenCode 的可执行文件路径。

进程清理可通过以下毫秒配置调整：`CODEX_AGENT_RELAY_CANCEL_GRACE_MS`（ACP 取消宽限）、`CODEX_AGENT_RELAY_TERM_GRACE_MS`（POSIX `SIGTERM` 宽限）和 `CODEX_AGENT_RELAY_KILL_CONFIRM_MS`（强制终止确认，默认 `2000`）。非法值或非正数会回退到默认值。

### 4. 可选：安装推荐委派规则

```bash
pnpm setup:codex-instructions
```

该命令会把推荐的 Agent 委派说明加入 Codex 全局指令，同时保留其他已有内容。

## 使用方式

配置完成后，可以直接让 Codex 用自然语言进行委派，例如：

```text
让 Grok 检查 /path/to/worktree 的当前改动，并运行相关测试。

让 Cursor 审查认证流程，不要修改文件。

把这个实现任务交给 OpenCode，在 /path/to/worktree 中完成。
```

relay 会向 Codex 暴露三个工具：

- `grok_delegate`
- `cursor_delegate`
- `opencode_delegate`

每次调用需要提供任务描述和绝对工作目录。返回的 `sessionId` 可以在后续调用中继续传给同一个工具，从而延续对应 Agent 的会话。

## 推荐工作流

```text
Codex 选择任务和 worktree
        ↓
codex-agent-relay 负责委派
        ↓
Grok / Cursor / OpenCode 在本地执行
        ↓
Codex 审查结果、diff 和测试
        ↓
Codex 决定集成、修正或继续追问
```

如果希望并行处理相互独立的任务，建议为它们使用不同 worktree。同一个工作目录上的委派会被串行化，避免多个 Agent 同时修改同一目录。

## 注意事项

- 委派前请先完成对应 Agent CLI 的认证，不要把凭据放入任务参数。
- relay 不负责创建 worktree，也不会自动接受 Agent 产生的修改。
- 文件系统、网络访问和权限行为最终取决于所选 Agent 及其本地配置。
- relay 会按进程树终止委派 worker。若无法确认清理完成，将返回 `PROCESS_CLEANUP_FAILED`，并在可能时把 workspace lease 标记为 orphaned 后继续保锁。owner 存活时后续调用返回 `WORKSPACE_BUSY`；owner 死亡后仍无法确认 worker 清理时返回 `WORKSPACE_ORPHANED`。
- Windows 使用绝对路径 `%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F`。该确认仅针对这次操作结果，不等同于 Job Object 或防崩溃进程容器。如果根进程在树级终止开始前已经退出，relay 无法确认后代清理，会保留锁。POSIX 清理范围仅覆盖 worker 的原始进程组。
- workspace 锁现在是包含 owner token 和生命周期状态的私有 lease 目录。新 relay 只自动恢复能够安全确认的状态：已 reaped、尚未开始 spawn，或旧 owner 已死亡且记录的 POSIX 进程组也已消失。存活 owner 仍返回 `WORKSPACE_BUSY`；旧格式锁、无法确认的 owner 探测以及来自其他主机或平台的锁都会保守失败。Windows 的非 reaped worker 即使根 PID 已消失也仍视为 orphaned，因为这不能证明后代已经退出。
- 升级时不要让新旧 relay 共用同一个状态目录并行运行。对于没有 worker 引用的 spawn 前记录，恢复逻辑假设相同 hostname 也代表相同 OS 和 PID namespace；复制状态目录会破坏该假设。lease 协议会保守处理崩溃，但不承诺在存储丢失、断电或人工修改状态后无人值守恢复。
- 状态目录必须使用同一主机、同一 PID namespace 内的本地文件系统。`STALE_LOCK_UNVERIFIED` 表示记录或 owner 无法安全验证；`WORKSPACE_ORPHANED` 表示已死亡 owner 的 worker 可能仍存活；`LOCK_OWNERSHIP_LOST` 表示 lease 不再拥有磁盘锁。旧格式锁文件只读识别，不自动迁移或删除。
- 人工恢复前，先停止所有使用该状态目录的 relay，并独立确认记录的 worker 及其后代已经退出，然后才能删除对应的 `.lock` 目录。带 token 的 retired tombstone 用于阻止 ABA 竞争，正常运行期间会永久保留；只能在所有 relay 停止时离线清理。
- Agent 返回的结果应视为待审查工作；合并前应检查实际 diff，并运行必要测试。

## 开发

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Windows 上的 Vitest 会串行运行测试文件，避免多个进程树清理同时执行造成竞争。其他平台保留 Vitest 默认的文件并行行为，单个测试文件内的并发不受影响。

真实 Agent 的 smoke test 可参考 `package.json` 中的 `test:real`、`test:real:cursor` 和 `test:real:opencode` 脚本。
