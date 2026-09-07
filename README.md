# codex-grok-relay

一个只提供单一 MCP 工具的本地 stdio relay：Codex 调用 `grok_delegate`，relay 为每次调用启动独立的 Grok CLI 子进程，并通过 ACP v1 完成认证、创建或加载会话以及一次 prompt。

## 构建与接入

要求 Node.js 22+、pnpm，以及已安装并可完成非交互认证的 Grok CLI。

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

构建产物为 `dist/cli.js`。Codex MCP 配置示例（请使用本机绝对路径）：

```toml
[mcp_servers.grok-build]
command = "node"
args = ["/ABSOLUTE/PATH/codex-grok-relay/dist/cli.js"]
startup_timeout_sec = 10
tool_timeout_sec = 3660
```

标准输出只承载 MCP 协议；诊断写入标准错误。`GROK_RELAY_GROK_COMMAND` 可指定 Grok 可执行文件。`GROK_RELAY_STATE_DIR` 可指定 relay 状态目录，默认 `~/.local/state/codex-grok-relay`。测试可直接构造 `RelayConfig` 注入 fake 命令和较短超时；生产环境不能覆盖强制 sandbox 参数。

## 工具契约

`grok_delegate` 输入：

- `task`：非空字符串。
- `cwd`：已存在目录的绝对路径；relay 使用 `realpath` 后的路径。
- `sessionId`：可选，只能使用 relay 先前返回并绑定到同一 `cwd` 的会话。

返回的文本内容是以下对象的 JSON，`structuredContent` 是同一个对象：

```json
{
  "sessionId": "opaque-id-or-null",
  "stopReason": "end_turn-or-null",
  "text": "Grok response",
  "truncated": false,
  "error": { "code": "OPTIONAL_CODE", "message": "optional message" }
}
```

基础设施、认证、状态、锁、ACP 或子进程失败会设置 MCP `isError: true`，并尽量保留已经取得的 `sessionId` 和部分文本。relay 不臆造 `stopReason`，prompt 失败也不会自动重发。文本最多保留 256 KiB，但超限后仍继续读取 ACP 流，并用 `truncated` 标记。

新会话在发送 prompt 前保存绑定记录。恢复只读取 relay 元数据并调用 Grok `session/load`；实际对话由 Grok 保存。未知 ID、损坏记录、不同 `cwd`、缺少 load 能力或 load 失败都会明确报错，不会静默新建替代会话。状态记录只包含版本、会话 ID、规范化 cwd 和时间戳，文件名是 ID 的 SHA-256。

同一规范化 cwd 使用跨 relay 进程的排他锁，不同 worktree 可并行。已有锁一律视为活跃，以避免竞争者误删新 owner 的锁；若 relay 被 `SIGKILL` 后留下锁文件，需先确认没有对应 Grok 子进程，再手工删除状态目录 `locks/` 下对应文件。正常完成、取消、超时、断连和父进程信号都会回收子进程并释放锁。

## 认证、权限和边界

relay 优先使用环境中的 `XAI_API_KEY` 和 Grok 声明的 `xai.api_key`；否则使用 Grok 已缓存的 `cached_token`。两者都不可用时直接失败，不启动交互登录。Grok 命令固定为：

```text
grok --no-auto-update --sandbox workspace agent --always-approve --no-leader stdio
```

`workspace` sandbox 可读取主机文件系统，写入范围包括当前 cwd、`~/.grok` 和临时目录，并允许网络访问。这属于 OS 级写入限制，但不提供完整的主机文件读取或网络隔离，也不应把 worktree 当成安全边界。若 sandbox 启动失败，relay 不降级运行。

Codex 仍负责创建或选择 worktree、审查 diff、运行测试及整合结果。relay 不自动创建 worktree，不生成 Git patch 或 `task_id`，不提供多 backend，也不向 Grok 暴露客户端文件或 terminal ACP 能力。若 Grok 意外请求权限，relay 返回 cancelled 并把本次调用标记为错误。

委派时应给 Grok 完整任务、允许修改的范围和可验证的验收标准。相互独立的任务可放入不同 worktree 并行执行；完成后由 Codex 检查实际 diff、运行相关测试并完成最终 review。

总调用限时 3600 秒；initialize、认证、新建和加载各 30 秒。取消时先发送 ACP `session/cancel`，最多等待 5 秒，再终止整个子进程组，2 秒后仍未退出则强制杀死。真实集成测试会产生 Grok 调用成本，仅在明确执行 `pnpm test:real` 时运行。

本实现已通过独立真实 MCP 两轮验收：新建会话后由全新 relay/Grok 进程加载同一会话，恢复仅存在于对话历史的标记，并验证 Grok 内建文件与 shell 工具；workspace 之外的专用目录写入被 sandbox 拒绝。另已通过真实 Codex 宿主临时 MCP 配置的工具发现、调用和同 session 续接验收。Vitest 中的 `real-smoke.test.ts` 仍由环境变量控制，常规 `pnpm test` 会跳过它。
