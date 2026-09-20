# codex-agent-relay

[English](README.md) | [简体中文](README.zh-CN.md)

通过一个本地 MCP Server，让 Codex 将任务委派给 **Grok**、**Cursor**、**OpenCode** 和 **DSH**。

`codex-agent-relay` 用来连接 Codex 与支持 ACP 的 Coding Agent。Codex 负责统一编排和最终审查，relay 负责把任务交给对应 Agent，并返回执行结果和可继续使用的会话 ID。

## 为什么使用它？

- **一个 MCP Server，对接多个 Coding Agent** —— 无需改变 Codex 工作流，即可在 Grok、Cursor、OpenCode 和 DSH 之间切换。
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
| DSH | `dsh_delegate` | 支持可选模型和 reasoning effort；仅 resume 已有会话 |

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

Grok 默认使用 `grok` 命令，OpenCode 默认使用 `opencode`，DSH 默认使用 `dsh --profile acp`。Cursor 需要显式配置可执行文件：

```toml
[mcp_servers.codex_agent_relay.env]
CODEX_AGENT_RELAY_CURSOR_COMMAND = "/ABSOLUTE/PATH/TO/cursor-agent"
```

如有需要，也可以通过 `CODEX_AGENT_RELAY_GROK_COMMAND`、`CODEX_AGENT_RELAY_OPENCODE_COMMAND` 和 `CODEX_AGENT_RELAY_DSH_COMMAND` 覆盖 Grok / OpenCode / DSH 的可执行文件路径。DSH 参数没有环境变量覆盖；relay 始终以 `--profile acp` 启动。

在 Windows 上，relay 不会通过 `cmd.exe` 或 `shell: true` 启动 `dsh.cmd`。它会用 `PATH`/`PATHEXT` 解析裸命令或配置的命令：保留原生 `.exe`/`.com`；用当前 Node 可执行文件运行 `.js`/`.mjs`；对已知的 npm/pnpm `.cmd` shim，先校验生成器产生的启动结构，再确认其引用文件是该包的 `bin.dsh`，最后以 `node` 加上该入口和原来的 DSH 参数启动。不受支持的 `.bat`、畸形 shim、缺失入口或不匹配的包会以 `ACP_FAILURE` 失败。安全的 `CODEX_AGENT_RELAY_DSH_COMMAND` 覆盖值是原生 DSH 可执行文件或官方 DSH `.js`/`.mjs` 入口。

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

把这个实现任务交给 DSH，在 /path/to/worktree 中完成。
```

relay 会向 Codex 暴露四个工具：

- `grok_delegate`
- `cursor_delegate`
- `opencode_delegate`
- `dsh_delegate`

每次调用需要提供任务描述和绝对工作目录。返回的 `sessionId` 可以在后续调用中继续传给同一个工具，从而延续对应 Agent 的会话。

### DSH（`dsh_delegate`）

DSH 即 DeepSeek Harness。委派前请先安装并配置好 `dsh` CLI。生产调用和 opt-in 真实测试预检（`--version` 与 `--profile acp --help`）共用同一套启动器解析：POSIX 上是 `dsh --profile acp`；Windows 上若 PATH 命中的是 npm/pnpm `.cmd` shim，则以 `shell: false` 启动 `node` 加上经过校验的 `@deepseek-ai/dsh` 入口。

工具输入：

| 输入 | 必填 | 说明 |
| --- | --- | --- |
| `task` | 是 | 去空白后非空 |
| `cwd` | 是 | 已存在的绝对工作目录 |
| `sessionId` | 否 | 先前返回的 DSH 会话 ID（仅 resume；没有 `resume` 布尔参数） |
| `model` | 否 | CLI 声明的不透明 `model` 会话选项 |
| `reasoningEffort` | 否 | CLI 声明的不透明 `reasoning_effort` 会话选项 |

同时提供 `model` 和 `reasoningEffort` 时，relay 先设置 `model`，再设置 `reasoning_effort`，取值必须是当前会话声明的选项。省略任一字段则保留 CLI 现有配置。未声明或不合法的值会失败关闭（`INVALID_CONFIG` / `CONFIG_UNSUPPORTED`）。

成功结果包含 `provider: "dsh"`、有界 `text`，以及可选的 `toolCalls` / `usage`；摘要超限时带 `summariesTruncated`。权限请求会被拒绝（有 `reject_once` 时选择拒绝）并以 `PERMISSION_REQUIRED` 中止。

真实 DSH smoke test 为 opt-in（`pnpm test:real:dsh` 或 `RUN_DSH_REAL_TESTS=1`）。可选环境变量 `DSH_TEST_MODEL` 和 `DSH_TEST_REASONING_EFFORT` 用于覆盖 resume 时的配置路径。

## 推荐工作流

```text
Codex 选择任务和 worktree
        ↓
codex-agent-relay 负责委派
        ↓
Grok / Cursor / OpenCode / DSH 在本地执行
        ↓
Codex 审查结果、diff 和测试
        ↓
Codex 决定集成、修正或继续追问
```

如果希望并行处理相互独立的任务，建议为它们使用不同 worktree。同一个工作目录上的委派会被串行化，避免多个 Agent 同时修改同一目录。

## 注意事项

- 委派前请先完成对应 Agent CLI 的认证，不要把凭据放入任务参数。
- relay 不负责创建 worktree，也不会自动接受 Agent 产生的修改。
- 文件系统、网络访问和权限行为最终取决于所选 Agent 及其本地配置。对 DSH，relay 会拒绝自动 ACP 批准（有 `reject_once` 时选择拒绝），并返回 `PERMISSION_REQUIRED`；这不是硬性的文件系统或网络隔离。已保存的 DSH 会话和部署配置仍然生效。
- DSH 仅在 CLI 声明 resume 能力时续接已有会话。relay 不会 load，也不会在失败时新建会话；缺少 resume 能力时返回 `RESUME_UNSUPPORTED`。
- relay 会按进程树终止委派 worker。若无法确认清理完成，将返回 `PROCESS_CLEANUP_FAILED`，并在可能时把 workspace lease 标记为 orphaned 后继续保锁。owner 存活时后续调用返回 `WORKSPACE_BUSY`；owner 死亡后仍无法确认 worker 清理时返回 `WORKSPACE_ORPHANED`。
- `SIGINT`、`SIGTERM`、`SIGHUP` 和 stdin EOF 会启动同一个关闭操作。relay 会立即停止接纳新委派，以 5 秒超时关闭 MCP transport，并且不设置全局期限，等待所有已登记任务完成进程树清理和 workspace lease 收尾。重复关闭事件不会绕过清理，也不会重复取消任务。
- 信号或 EOF 的正常关闭以状态码 `0` 退出。transport 关闭、进程清理或 lease 收尾失败会写入 stderr，并以状态码 `1` 退出；无法确认退出的 worker 会继续保锁。由于 runner 清理没有强制期限，永久阻塞的文件系统操作也可能使关闭一直等待。
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

真实 Agent 的 smoke test 可参考 `package.json` 中的 `test:real`、`test:real:cursor`、`test:real:opencode` 和 `test:real:dsh` 脚本。默认 `pnpm test` 会跳过真实 DSH 测试；`pnpm test:real:dsh`（或 `RUN_DSH_REAL_TESTS=1`）在本地没有可用 `dsh` CLI 时会失败。
