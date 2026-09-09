# codex-agent-relay

[English](README.md) | [简体中文](README.zh-CN.md)

一个本地 stdio MCP relay，让 Codex 通过 `grok_delegate`、`cursor_delegate` 和 `opencode_delegate` 把任务交给 Grok、Cursor 或 OpenCode。每次调用都会启动独立的 agent 子进程，通过共享 ACP v1 runner 完成认证、创建或恢复会话以及一次 prompt。

relay 负责协议转换、会话元数据、同一工作目录的并发控制和进程清理；Codex 仍负责选择 worktree、审查 diff、运行测试以及整合结果。

## 快速开始

### 前置条件

- Node.js 22+
- pnpm 11+
- 已安装并认证所选后端的 CLI：Grok、Cursor 或 OpenCode
- 一个允许所选 agent 操作的本地 worktree 或其他工作目录

### 安装、检查与构建

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

构建产物为 `dist/cli.js`。将它注册为 Codex 的 MCP server 时，请使用本机绝对路径：

```toml
[mcp_servers.codex_agent_relay]
command = "node"
args = ["/ABSOLUTE/PATH/codex-agent-relay/dist/cli.js"]
startup_timeout_sec = 10
tool_timeout_sec = 3660
```

`tool_timeout_sec` 应覆盖 relay 默认的 3600 秒总调用上限。relay 的标准输出只承载 MCP 协议，诊断信息写入标准错误。

启用 Cursor 时，在同一个 MCP server 配置中显式指定其可执行文件：

```toml
[mcp_servers.codex_agent_relay.env]
CODEX_AGENT_RELAY_CURSOR_COMMAND = "/ABSOLUTE/PATH/TO/cursor-agent"
```

请填写实际 Cursor CLI 的路径，不限文件名。不要假定 `agent` 就是 Cursor，Grok 也可能使用该命令名。未配置 Cursor 时仍注册三个工具，仅 Cursor 调用返回配置错误。委派前单独执行 Cursor 的 `login`，或通过 relay 环境提供 `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`；不要把凭据放入工具参数。

OpenCode 默认使用 `opencode` 可执行文件。仅在二进制不在 `PATH` 时覆盖：

```toml
[mcp_servers.codex_agent_relay.env]
CODEX_AGENT_RELAY_OPENCODE_COMMAND = "/ABSOLUTE/PATH/TO/opencode"
```

委派前用 `opencode auth login` 完成 OpenCode 认证。relay 不会启动登录界面，也不会从工具参数读取凭据。

可选：将三个工具的推荐委派说明添加到 Codex 全局指令中：

```bash
pnpm setup:codex-instructions
```

脚本会更新 `$CODEX_HOME/AGENTS.md`；未设置 `CODEX_HOME` 时则更新 `~/.codex/AGENTS.md`。它保留其他指令，将现有 `CODEX-AGENT-RELAY` 受管理块（或旧的 `GROK-BUILD` 块）替换为三个 agent 的说明，不会重复插入。如果同一目录存在非空的 `AGENTS.override.md`，Codex 会改为加载该文件，脚本也会输出警告。

## 基本用法

首次调用 `grok_delegate` 时只需要提供任务和工作目录：

```json
{
  "task": "检查当前改动，运行相关测试，并总结发现的问题。",
  "cwd": "/absolute/path/to/worktree"
}
```

成功响应示例：

```json
{
  "sessionId": "opaque-session-id",
  "stopReason": "end_turn",
  "text": "已完成检查，测试全部通过。",
  "truncated": false
}
```

后续调用可以把上一次返回的 `sessionId` 与同一个 `cwd` 一起传回，以恢复同一 Grok 会话：

```json
{
  "task": "基于上一轮结果继续修复发现的问题。",
  "cwd": "/absolute/path/to/worktree",
  "sessionId": "opaque-session-id"
}
```

委派任务应明确说明允许修改的范围、验收标准以及需要运行的检查。相互独立的任务可以放入不同 worktree 并行执行。

委派 Cursor 进行专项分析时，调用 `cursor_delegate`：

```json
{
  "task": "审查认证流程并报告缺陷，不修改文件。",
  "cwd": "/absolute/path/to/worktree",
  "mode": "ask"
}
```

新建实现会话时可省略 `mode`（默认 `agent`）。可选的 `model` 在进程启动时选择模型，省略则使用 Cursor 默认值。通过同一工具传回 `sessionId` 可恢复会话；省略模型和模式会继承保存的选择，显式指定不同值则需要新建会话。

委派 OpenCode 时调用 `opencode_delegate`。新会话继承 OpenCode 自身默认值。可选的 `model`、`effort` 和 `agent` 在创建/恢复/加载之后通过 ACP `session/set_config_option` 应用（`agent` 对应 OpenCode 的 `mode` 选项）。省略的字段保留原生恢复或默认状态，后续调用可以改动它们。传回 `sessionId` 以继续同一会话。存在 `sessionId` 时 `resume` 默认为 true；`resume: false` 强制 `session/load`。没有 `sessionId` 却指定 `resume` 属于输入错误。

## 工具契约

relay 注册三个 MCP 工具：`grok_delegate`、`cursor_delegate` 和 `opencode_delegate`。

### 输入

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `task` | 非空字符串 | 要交给所选 agent 的任务。首尾空白会被去除。 |
| `cwd` | 字符串 | 已存在的绝对目录。relay 会先执行 `realpath`，后续状态绑定和锁使用规范化路径。 |
| `sessionId` | 可选字符串 | relay 先前返回、且绑定到同一个规范化 `cwd` 的会话 ID。 |

Cursor 额外接受 `model?: string` 和 `mode?: "agent" | "ask"`，不开放 Plan 模式。OpenCode 额外接受 `resume?: boolean`、`model?: string`、`effort?: string` 和 `agent?: string`。Grok 和 Cursor 的输入、输出契约保持不变。

### 输出

文本响应和 `structuredContent` 使用同一个 JSON 对象：

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

- `sessionId`：新建会话后返回；发生部分失败时也会尽量保留已取得的 ID。
- `stopReason`：agent 返回的停止原因；relay 不会在 prompt 失败时臆造该字段。
- `text`：收到的 agent 文本，最多保留 256 KiB。
- `truncated`：文本超过上限时为 `true`。即使达到上限，relay 仍会继续读取 ACP 流并完成清理。
- `error`：失败时包含稳定的错误码和可读消息。

基础设施、认证、状态、锁、ACP 或子进程失败会同时设置 MCP `isError: true`。如果已经取得会话 ID 或部分文本，错误响应会尽量保留这些信息。prompt 失败不会自动重发。

Cursor 结果额外包含 `provider: "cursor"`，以及可选、有界的摘要数组：`toolCalls`、`todos`、`subagents`、`interactions` 和 `images`。这些数组共用独立于文本的预算，取 64 KiB 与 `CODEX_AGENT_RELAY_TEXT_LIMIT_BYTES` 中较大值。达到预算会设置 `summariesTruncated` 和 `truncated`；收集过程不会读取生成的图像文件。权限失败会在 `interactions` 中保留经过截断的请求摘要，必要时移除旧摘要，供调用方审查被拒绝的操作。

OpenCode 结果包含 `provider: "opencode"`、可选 `usage`（`used`、`size` 以及服务端累计的可选 `cost`；relay 不会自行加总），以及可选、有界的 `toolCalls` 数组。`usage` 取当前 prompt 最新一次 `usage_update`；回放和其他会话的更新会被忽略。达到摘要预算会设置 `summariesTruncated` 和 `truncated`。错误结果会尽量保留已取得的这些 provider 字段。

## 会话、并发与生命周期

一次调用的大致流程是：

```text
规范化 cwd → 获取 cwd 锁 → 启动 agent → ACP initialize/authenticate
→ session/new、session/resume 或 session/load → 可选 session/set_config_option
→ session/prompt → 回收子进程并释放锁
```

### 会话恢复

- 新会话会在发送 prompt 前写入 relay 元数据。
- Grok 元数据保留现有格式和路径。Cursor 元数据使用独立命名空间，并记录启动时的模型选择和模式。OpenCode 元数据使用 `opencode` 命名空间，只保存会话 ID、cwd 和时间戳。记录使用私有权限和哈希会话文件名。
- 实际对话历史由各后端保存。Grok 和 Cursor 通过 `session/load` 恢复。OpenCode 在 initialize 声明 `sessionCapabilities.resume` 时优先 `session/resume`；否则仅在声明 `loadSession` 时使用 `session/load`。`resume: false` 强制 load。resume/load 失败不会回退到新建或替代会话。Grok、Cursor 和 OpenCode 的会话 ID 不能互用。
- 未知 ID、损坏记录、不同 `cwd`、缺少 resume/load 能力或 resume/load 失败都会明确报错，不会静默创建替代会话。

### 并发与清理

- 同一规范化 `cwd` 使用所有后端和所有 relay 进程共用的排他锁；不同 worktree 可以并行。
- 已存在的锁一律视为活跃，避免竞争者误删新 owner 的锁。
- 正常完成、取消、超时、断连和父进程信号都会回收 agent 子进程并释放锁。
- 如果 relay 被 `SIGKILL` 终止而留下锁文件，先确认没有对应 agent 子进程，再手工删除状态目录 `locks/` 下的对应文件。

## 配置

所有配置通过环境变量传入。测试可以直接构造 `RelayConfig` 注入 fake 命令和较短超时；生产环境不能覆盖固定的 Grok sandbox 参数。

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CODEX_AGENT_RELAY_GROK_COMMAND` | `grok` | Grok 可执行文件路径或命令名。 |
| `CODEX_AGENT_RELAY_CURSOR_COMMAND` | 未设置 | 显式指定 Cursor 可执行文件路径或命令名，仅 Cursor 调用需要。 |
| `CODEX_AGENT_RELAY_OPENCODE_COMMAND` | `opencode` | OpenCode 可执行文件路径或命令名。relay 以 `shell: false` 启动 `opencode acp --cwd <规范化 cwd>`，进程 cwd 与 ACP cwd 相同。 |
| `CODEX_AGENT_RELAY_STATE_DIR` | `~/.local/codex-agent-relay` | 会话元数据和 cwd 锁的根目录。 |
| `CODEX_AGENT_RELAY_PHASE_TIMEOUT_MS` | `30000` | 启动、initialize、认证、新建和加载阶段的单阶段超时。 |
| `CODEX_AGENT_RELAY_TOTAL_TIMEOUT_MS` | `3600000` | 单次调用的总超时，即 3600 秒。 |
| `CODEX_AGENT_RELAY_CANCEL_GRACE_MS` | `5000` | 取消时等待 ACP `session/cancel` 和子进程退出的时间。 |
| `CODEX_AGENT_RELAY_TERM_GRACE_MS` | `2000` | 发送 SIGTERM 后等待，再升级为 SIGKILL 的时间。 |
| `CODEX_AGENT_RELAY_TEXT_LIMIT_BYTES` | `262144` | 单次响应保留的 agent 文本上限。 |
| `CODEX_AGENT_RELAY_STDERR_LIMIT_BYTES` | `65536` | 保留的 agent stderr 上限。 |
| `CODEX_AGENT_RELAY_PROGRESS_INTERVAL_MS` | `1000` | 工具调用进度通知的最小间隔。 |

## 认证、权限与安全边界

### 认证

relay 不启动交互式登录，也不从工具参数读取凭据。认证顺序为：

1. 如果 Grok 声明支持 `xai.api_key` 且环境中存在 `XAI_API_KEY`，使用 API key。
2. 否则，如果 Grok 声明支持 `cached_token`，使用 Grok 已缓存的 token。
3. 两者都不可用时返回认证错误。

Cursor 需要声明 `cursor_login`。OpenCode 在声明 `opencode-login` 时进行非交互认证；`authMethods` 为空则跳过认证；仅有未知方法时返回 `AUTH_UNAVAILABLE`。Grok 和 Cursor 的认证行为保持不变。

relay 固定以以下参数启动 Grok：

```text
grok --no-auto-update --sandbox workspace agent --always-approve --no-leader stdio
```

### 重要边界

- `workspace` sandbox 允许读取主机文件系统，写入范围包括当前 `cwd`、`~/.grok` 和临时目录，并允许网络访问。
- 这是 OS 级写入限制，不是完整的主机文件读取隔离或网络隔离；worktree 不能被当作安全边界。
- 如果 sandbox 启动失败，relay 不降级为无 sandbox 模式。
- relay 不自动创建 worktree，不生成 Git patch 或 `task_id`，也不向任一后端暴露客户端文件或 terminal ACP 能力。
- 即使使用了 `--always-approve`，Grok 仍意外请求权限时，relay 会返回 cancelled，并将本次调用标记为错误。
- relay 不为 OpenCode 声称 OS sandbox。OpenCode 原生 subagent 和项目 MCP 仍保持启用。

上述 Grok sandbox 细节不代表 Cursor 或 OpenCode 的隔离行为。Codex 应在委派前选择合适的 worktree，委派后检查实际 diff、运行相关测试并完成最终 review。不要仅根据 worker 的自然语言总结判断修改是否符合预期。

### Cursor 权限与交互

Cursor 使用 `--sandbox enabled` 启动，沿用其已有 sandbox 和权限配置。relay 不修改这些文件，不添加 `--force`、`--yolo` 或 `--approve-mcps`，也不开放 `full-access`。Cursor 原生 allow/deny 规则先执行，deny 优先。例如，项目 `.cursor/cli.json` 可允许特定读取并拒绝访问敏感文件：

```json
{
  "permissions": {
    "allow": ["Read(src/**/*.ts)"],
    "deny": ["Read(.env*)", "Write(**/*.key)"]
  }
}
```

额外的 `session/request_permission` 请求会通过其中的 `reject_once` 选项拒绝；不存在该选项则返回 cancelled。relay 取消任务并返回 `PERMISSION_REQUIRED`，保留部分输出和请求信息。恢复前应审查请求，并协调必要的策略调整；重复调用不构成绕过拒绝的授权。

bridge 不启动交互式登录，也不向用户追问。`cursor/ask_question` 返回 `skipped`，`cursor/create_plan` 返回 `rejected`，两者都会进入返回摘要。任务前缀要求 Cursor 保守处理小歧义，遇到重大决策停止并报告。

Ask 模式是 agent 行为设置，不代表 OS 级只读保证。实际文件系统和网络边界取决于 Cursor 生效的 sandbox 配置，包括用户和项目覆盖。sandbox 失败不会自动降级为无 sandbox 重试。参考 [Cursor ACP](https://cursor.com/cn/docs/cli/acp)、[CLI 参数](https://cursor.com/docs/cli/reference/parameters)、[权限](https://cursor.com/docs/cli/reference/permissions)和 [sandbox 配置](https://cursor.com/docs/reference/sandbox)。

### OpenCode 权限与配置

OpenCode 以 `opencode acp --cwd <规范化 cwd>` 启动，进程 cwd 与该路径相同。relay 不写入 `OPENCODE_CONFIG_CONTENT` 或任何用户/项目 OpenCode 配置文件。仅对子进程叠加 `OPENCODE_PERMISSION`，设置 `question: "deny"`，并保留该环境变量中已有的其他键。如果已经设置了 `OPENCODE_PERMISSION`，它必须是 JSON 对象；否则返回配置错误，且不会回显其内容。

该叠加不是硬隔离。OpenCode 1.18.29 会把 `OPENCODE_PERMISSION` 合并进配置，全局 `question: deny` 仍可能被 agent 级权限规则覆盖。prompt 会说明这是非交互委派任务：不要向用户提问，保守处理小歧义，遇到重大未决决策则停止并报告。如果问题仍然阻塞，调用会超时。relay 不为 OpenCode 声称 OS sandbox 或文件系统隔离。

当 OpenCode 发送 `session/request_permission` 时，relay 选择 kind 为 `allow_once` 的选项，并返回该选项的实际 `optionId`。绝不会选择 `allow_always`。缺少 `allow_once` 时权限请求会被 cancelled，任务以 `PERMISSION_REQUIRED` 失败，并保留部分输出。取消后不会再批准。其他会话的权限请求会被 cancelled 且不批准。

可选的 `model`、`effort` 和 `agent` 会对照最新返回的 `configOptions`（包括分组选项）校验，并按该顺序应用。每次 `session/set_config_option` 后都会刷新选项列表。无效或不支持的值返回稳定错误，且不会发送 prompt。relay 不会套用 Cursor 的锁定模型/模式规则，也不会单独保存一份 OpenCode 选项副本。

### 防止递归委派

不要把本 relay 配置为下游 Cursor、Grok 或 OpenCode 的 MCP server。特别是 Cursor 会读取项目和用户 `.cursor/mcp.json`；ACP 的空 `mcpServers` 列表并不禁用这些配置。OpenCode 同样会保留原生项目 MCP。worker 会继承内部标记 `CODEX_AGENT_RELAY_DELEGATED=1`，在该标记环境下调用 relay 会被拒绝。这只是基于环境继承的循环保护，不是隔离机制；清除标记的包装脚本会使保护失效。

## 测试与验证

常规质量检查：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

真实 Grok 集成测试会产生 API 调用成本，需要显式 opt-in，并依赖 Grok CLI、认证和可用配额：

```bash
pnpm test:real
```

Cursor 真实测试单独 opt-in，需要配置 `CODEX_AGENT_RELAY_CURSOR_COMMAND`、认证和可用配额：

```bash
pnpm test:real:cursor
```

OpenCode 真实测试单独 opt-in，需要 OpenCode CLI、认证和可用配额：

```bash
pnpm test:real:opencode
```

常规 `pnpm test` 跳过全部真实集成测试套件。自动化测试覆盖会话创建与恢复、后端隔离、模型/模式绑定、认证、cwd 锁、超时与取消、进程组清理、有界输出、进度、Cursor 扩展和权限拒绝、Grok 异常权限行为，以及 OpenCode 的 resume/load 分发、动态配置、`allow_once` 批准、usage 和权限叠加。真实测试不能证明完整 sandbox 隔离，跳过的联调场景应单独说明。
