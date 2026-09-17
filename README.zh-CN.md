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
- pnpm 11+
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
- Agent 返回的结果应视为待审查工作；合并前应检查实际 diff，并运行必要测试。

## 开发

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

真实 Agent 的 smoke test 可参考 `package.json` 中的 `test:real`、`test:real:cursor` 和 `test:real:opencode` 脚本。
