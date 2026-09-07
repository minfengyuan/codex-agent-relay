# codex-grok-relay

[English](README.md) | [简体中文](README.zh-CN.md)

一个本地 stdio MCP relay，让 Codex 通过唯一工具 `grok_delegate` 把任务交给 Grok CLI 执行。每次调用都会启动独立的 Grok 子进程，并通过 ACP v1 完成认证、创建或恢复会话以及一次 prompt。

relay 负责协议转换、会话元数据、同一工作目录的并发控制和进程清理；Codex 仍负责选择 worktree、审查 diff、运行测试以及整合结果。

## 快速开始

### 前置条件

- Node.js 22+
- pnpm 11+
- 已安装 Grok CLI，并已配置可用于非交互调用的认证方式
- 一个允许 Grok 操作的本地 worktree 或其他工作目录

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
[mcp_servers.grok-build]
command = "node"
args = ["/ABSOLUTE/PATH/codex-grok-relay/dist/cli.js"]
startup_timeout_sec = 10
tool_timeout_sec = 3660
```

`tool_timeout_sec` 应覆盖 relay 默认的 3600 秒总调用上限。relay 的标准输出只承载 MCP 协议，诊断信息写入标准错误。

## 基本用法

首次调用时只需要提供任务和工作目录：

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

## 工具契约

relay 只注册一个 MCP 工具：`grok_delegate`。

### 输入

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `task` | 非空字符串 | 要交给 Grok 的任务。首尾空白会被去除。 |
| `cwd` | 字符串 | 已存在的绝对目录。relay 会先执行 `realpath`，后续状态绑定和锁使用规范化路径。 |
| `sessionId` | 可选字符串 | relay 先前返回、且绑定到同一个规范化 `cwd` 的会话 ID。 |

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
- `stopReason`：Grok 返回的停止原因；relay 不会在 prompt 失败时臆造该字段。
- `text`：收到的 Grok 文本，最多保留 256 KiB。
- `truncated`：文本超过上限时为 `true`。即使达到上限，relay 仍会继续读取 ACP 流并完成清理。
- `error`：失败时包含稳定的错误码和可读消息。

基础设施、认证、状态、锁、ACP 或子进程失败会同时设置 MCP `isError: true`。如果已经取得会话 ID 或部分文本，错误响应会尽量保留这些信息。prompt 失败不会自动重发。

## 会话、并发与生命周期

一次调用的大致流程是：

```text
规范化 cwd → 获取 cwd 锁 → 启动 Grok → ACP initialize/authenticate
→ session/new 或 session/load → session/prompt → 回收子进程并释放锁
```

### 会话恢复

- 新会话会在发送 prompt 前写入 relay 元数据。
- relay 只保存版本、会话 ID、规范化 `cwd` 和时间戳；文件名是会话 ID 的 SHA-256，文件权限为私有权限。
- 实际对话历史由 Grok 保存；恢复时 relay 读取元数据并调用 Grok `session/load`。
- 未知 ID、损坏记录、不同 `cwd`、缺少 load 能力或 load 失败都会明确报错，不会静默创建替代会话。

### 并发与清理

- 同一规范化 `cwd` 使用跨 relay 进程的排他锁；不同 worktree 可以并行。
- 已存在的锁一律视为活跃，避免竞争者误删新 owner 的锁。
- 正常完成、取消、超时、断连和父进程信号都会回收 Grok 子进程并释放锁。
- 如果 relay 被 `SIGKILL` 终止而留下锁文件，先确认没有对应 Grok 子进程，再手工删除状态目录 `locks/` 下的对应文件。

## 配置

所有配置通过环境变量传入。测试可以直接构造 `RelayConfig` 注入 fake 命令和较短超时；生产环境不能覆盖固定的 Grok sandbox 参数。

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `GROK_RELAY_GROK_COMMAND` | `grok` | Grok 可执行文件路径或命令名。 |
| `GROK_RELAY_STATE_DIR` | `~/.local/state/codex-grok-relay` | 会话元数据和 cwd 锁的根目录。 |
| `GROK_RELAY_PHASE_TIMEOUT_MS` | `30000` | 启动、initialize、认证、新建和加载阶段的单阶段超时。 |
| `GROK_RELAY_TOTAL_TIMEOUT_MS` | `3600000` | 单次调用的总超时，即 3600 秒。 |
| `GROK_RELAY_CANCEL_GRACE_MS` | `5000` | 取消时等待 ACP `session/cancel` 和子进程退出的时间。 |
| `GROK_RELAY_TERM_GRACE_MS` | `2000` | 发送 SIGTERM 后等待，再升级为 SIGKILL 的时间。 |
| `GROK_RELAY_TEXT_LIMIT_BYTES` | `262144` | 单次响应保留的 Grok 文本上限。 |
| `GROK_RELAY_STDERR_LIMIT_BYTES` | `65536` | 保留的 Grok stderr 上限。 |
| `GROK_RELAY_PROGRESS_INTERVAL_MS` | `1000` | 工具调用进度通知的最小间隔。 |

## 认证、权限与安全边界

### 认证

relay 不启动交互式登录。认证顺序为：

1. 如果 Grok 声明支持 `xai.api_key` 且环境中存在 `XAI_API_KEY`，使用 API key。
2. 否则，如果 Grok 声明支持 `cached_token`，使用 Grok 已缓存的 token。
3. 两者都不可用时返回认证错误。

relay 固定以以下参数启动 Grok：

```text
grok --no-auto-update --sandbox workspace agent --always-approve --no-leader stdio
```

### 重要边界

- `workspace` sandbox 允许读取主机文件系统，写入范围包括当前 `cwd`、`~/.grok` 和临时目录，并允许网络访问。
- 这是 OS 级写入限制，不是完整的主机文件读取隔离或网络隔离；worktree 不能被当作安全边界。
- 如果 sandbox 启动失败，relay 不降级为无 sandbox 模式。
- relay 不自动创建 worktree，不生成 Git patch 或 `task_id`，不提供多 backend，也不向 Grok 暴露客户端文件或 terminal ACP 能力。
- 即使使用了 `--always-approve`，Grok 仍意外请求权限时，relay 会返回 cancelled，并将本次调用标记为错误。

Codex 应在委派前选择合适的 worktree，委派后检查实际 diff、运行相关测试并完成最终 review。不要仅根据 Grok 的自然语言总结判断修改是否符合预期。

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

常规 `pnpm test` 不会运行 `test/real-smoke.test.ts`。测试覆盖会话创建与恢复、认证选择、状态绑定、cwd 锁、超时与取消、进程组清理、输出截断、进度通知以及异常权限请求。
