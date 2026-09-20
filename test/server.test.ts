import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { cleanupAllChildren } from "../src/runner.js";
import { createRelayServer } from "../src/server.js";
import { RelayFailure } from "../src/types.js";
import { SessionStore } from "../src/store.js";
import { clearDelegatedEnv, dshFixture, grokFixture, waitForLog } from "./helpers.js";

const dirs: string[] = [];
beforeEach(() => {
  clearDelegatedEnv();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  try {
    await cleanupAllChildren();
  } finally {
    await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  }
});

async function harness(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "relay-server-"));
  dirs.push(stateDir);
  const server = createRelayServer({ ...loadConfig({}), stateDir, ...overrides });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const responses = new Map<number, (message: JSONRPCMessage) => void>();
  const notifications: JSONRPCMessage[] = [];
  clientTransport.onmessage = (message) => {
    if ("id" in message && typeof message.id === "number") responses.get(message.id)?.(message);
    else notifications.push(message);
  };
  await clientTransport.start();
  await server.connect(serverTransport);
  const request = async (id: number, method: string, params: Record<string, unknown> = {}) => {
    const answer = new Promise<JSONRPCMessage>((resolve) => responses.set(id, resolve));
    await clientTransport.send({ jsonrpc: "2.0", id, method, params });
    return answer;
  };
  const notify = async (method: string, params: Record<string, unknown> = {}) => {
    await clientTransport.send({ jsonrpc: "2.0", method, params });
  };
  const init = await request(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { server, clientTransport, request, notify, notifications, init, stateDir };
}

describe("MCP server", () => {
  it.each(["WORKSPACE_ORPHANED", "STALE_LOCK_UNVERIFIED", "LOCK_OWNERSHIP_LOST"] as const)(
    "preserves %s in matching text and structured errors", async (code) => {
      vi.spyOn(SessionStore.prototype, "acquire").mockRejectedValue(new RelayFailure(code, "lease failure"));
      const { server, clientTransport, request } = await harness();
      try {
        const response = await request(3, "tools/call", {
          name: "grok_delegate", arguments: { task: "test", cwd: process.cwd() },
        }) as { result?: { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: unknown } };
        expect(response.result?.isError).toBe(true);
        expect(response.result?.structuredContent).toMatchObject({ error: { code } });
        expect(JSON.parse(response.result?.content?.[0]?.text ?? "null")).toEqual(response.result?.structuredContent);
      } finally { await clientTransport.close(); await server.close(); }
    },
  );
  it("discovers Grok, Cursor, OpenCode, and DSH delegation with their input contracts", async () => {
    const { server, clientTransport, request, init } = await harness();
    expect(init).toHaveProperty("result.serverInfo.name", "codex-agent-relay");
    const response = await request(2, "tools/list");
    expect(response).toHaveProperty("result.tools.0.name", "grok_delegate");
    expect(response).toHaveProperty("result.tools.0.inputSchema.required", ["task", "cwd"]);
    expect(response).toHaveProperty("result.tools.0.outputSchema.properties.sessionId");
    expect(response).toHaveProperty("result.tools.1.name", "cursor_delegate");
    expect(response).toHaveProperty("result.tools.1.inputSchema.required", ["task", "cwd"]);
    expect(response).toHaveProperty("result.tools.1.inputSchema.properties.mode.enum", ["agent", "ask"]);
    expect(response).toHaveProperty("result.tools.1.outputSchema.properties.provider.const", "cursor");
    expect(response).toHaveProperty("result.tools.2.name", "opencode_delegate");
    expect(response).toHaveProperty("result.tools.2.inputSchema.required", ["task", "cwd"]);
    expect(response).toHaveProperty("result.tools.2.inputSchema.properties.resume");
    expect(response).toHaveProperty("result.tools.2.outputSchema.properties.provider.const", "opencode");
    expect(response).toHaveProperty("result.tools.3.name", "dsh_delegate");
    expect(response).toHaveProperty("result.tools.3.inputSchema.required", ["task", "cwd"]);
    expect(response).toHaveProperty("result.tools.3.inputSchema.properties.model");
    expect(response).toHaveProperty("result.tools.3.inputSchema.properties.reasoningEffort");
    expect(response).not.toHaveProperty("result.tools.3.inputSchema.properties.resume");
    expect(response).toHaveProperty("result.tools.3.outputSchema.properties.provider.const", "dsh");
    expect(response).not.toHaveProperty("result.tools.0.outputSchema.properties.provider");
    await clientTransport.close();
    await server.close();
  });

  it("returns matching JSON and structured error output", async () => {
    const { server, clientTransport, request } = await harness();
    const response = await request(3, "tools/call", {
      name: "grok_delegate",
      arguments: { task: "hello", cwd: "relative" },
    }) as { result?: { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: unknown } };
    expect(response.result?.isError).toBe(true);
    expect(JSON.parse(response.result?.content?.[0]?.text ?? "null")).toEqual(response.result?.structuredContent);
    expect(response.result?.structuredContent).toMatchObject({
      sessionId: null,
      stopReason: null,
      text: "",
      truncated: false,
      error: { code: "INVALID_CWD" },
    });
    await clientTransport.close();
    await server.close();
  });

  it("returns a structured Cursor configuration error without affecting Grok configuration", async () => {
    const { server, clientTransport, request } = await harness();
    const response = await request(4, "tools/call", {
      name: "cursor_delegate",
      arguments: { task: "hello", cwd: process.cwd() },
    }) as { result?: { isError?: boolean; structuredContent?: unknown } };
    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({
      sessionId: null,
      stopReason: null,
      text: "",
      truncated: false,
      provider: "cursor",
      error: { code: "CURSOR_COMMAND_REQUIRED" },
    });
    await clientTransport.close();
    await server.close();
  });

  it("returns a structured OpenCode resume input error without spawning", async () => {
    const { server, clientTransport, request } = await harness();
    const response = await request(5, "tools/call", {
      name: "opencode_delegate",
      arguments: { task: "hello", cwd: process.cwd(), resume: true },
    }) as { result?: { isError?: boolean; structuredContent?: unknown } };
    expect(response.result?.isError).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({
      sessionId: null,
      stopReason: null,
      text: "",
      truncated: false,
      provider: "opencode",
      error: { code: "INVALID_INPUT" },
    });
    await clientTransport.close();
    await server.close();
  });

  it.runIf(process.platform === "win32")("returns a structured cleanup failure and retains the original partial result", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "exit");
    const cwd = await mkdtemp(join(tmpdir(), "relay-server-cwd-"));
    dirs.push(cwd);
    const { server, clientTransport, request } = await harness({
      command: process.execPath,
      commandArgs: [grokFixture],
    });
    const response = await request(6, "tools/call", {
      name: "grok_delegate",
      arguments: { task: "exit", cwd },
    }) as { result?: { isError?: boolean; structuredContent?: unknown } };
    expect(response.result).toMatchObject({
      isError: true,
      structuredContent: {
        sessionId: null,
        stopReason: null,
        text: "",
        truncated: false,
        error: { code: "PROCESS_CLEANUP_FAILED" },
      },
    });
    await clientTransport.close();
    await server.close();
  });

  it("rejects trimmed and blank DSH tool inputs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "relay-server-dsh-blank-"));
    dirs.push(cwd);
    const { server, clientTransport, request } = await harness({
      dshCommand: process.execPath,
      dshCommandArgs: [dshFixture],
    });
    const invalid = async (id: number, arguments_: Record<string, unknown>) => {
      const response = await request(id, "tools/call", {
        name: "dsh_delegate",
        arguments: arguments_,
      }) as { result?: { isError?: boolean }; error?: { message?: string } };
      expect(response.result?.isError === true || response.error !== undefined).toBe(true);
    };
    await invalid(20, { task: "   ", cwd });
    await invalid(21, { task: "ok", cwd, sessionId: "   " });
    await invalid(22, { task: "ok", cwd, model: "   " });
    await invalid(23, { task: "ok", cwd, reasoningEffort: "   " });
    await clientTransport.close();
    await server.close();
  });

  it("forwards DSH success, extras, MCP progress, model/sessionId, and cancellation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "relay-server-dsh-"));
    dirs.push(cwd);
    const { server, clientTransport, request, notify, notifications, stateDir } = await harness({
      dshCommand: process.execPath,
      dshCommandArgs: [dshFixture],
      progressIntervalMs: 1,
    });
    const log = join(stateDir, "dsh-mcp.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const success = await request(10, "tools/call", {
      name: "dsh_delegate",
      arguments: { task: "hello", cwd, model: "dsh/gpt", reasoningEffort: "high" },
      _meta: { progressToken: "dsh-progress" },
    }) as {
      result?: {
        isError?: boolean;
        structuredContent?: { provider?: string; text?: string; sessionId?: string };
      };
    };
    expect(success.result?.isError).not.toBe(true);
    expect(success.result?.structuredContent).toMatchObject({
      provider: "dsh",
      text: "fresh answer",
      sessionId: "fake-session-1",
    });
    expect(await readFile(log, "utf8")).toContain("set-config:model:dsh/gpt");
    expect(await readFile(log, "utf8")).toContain("set-config:reasoning_effort:high");
    const progress = notifications.filter((message) =>
      "method" in message && message.method === "notifications/progress",
    );
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toMatchObject({
      method: "notifications/progress",
      params: { progressToken: "dsh-progress", progress: 1, message: expect.any(String) },
    });

    const resumed = await request(11, "tools/call", {
      name: "dsh_delegate",
      arguments: { task: "again", cwd, sessionId: "fake-session-1" },
    }) as { result?: { isError?: boolean; structuredContent?: { sessionId?: string } } };
    expect(resumed.result?.isError).not.toBe(true);
    expect(resumed.result?.structuredContent?.sessionId).toBe("fake-session-1");
    expect(await readFile(log, "utf8")).toContain("resume:fake-session-1");

    vi.stubEnv("FAKE_ACP_MODE", "partial-fail");
    vi.stubEnv("FAKE_SESSION_ID", "partial-session");
    const partial = await request(12, "tools/call", {
      name: "dsh_delegate",
      arguments: { task: "fail", cwd },
    }) as { result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } } };
    expect(partial.result?.isError).toBe(true);
    expect(partial.result?.structuredContent).toMatchObject({
      provider: "dsh",
      sessionId: "partial-session",
      text: "partial text",
      toolCalls: expect.arrayContaining([expect.objectContaining({ toolCallId: "t1" })]),
      usage: { used: 42, size: 128, cost: { amount: 3.5, currency: "USD" } },
      error: { code: "ACP_FAILURE" },
    });

    vi.stubEnv("FAKE_ACP_MODE", "hang");
    vi.stubEnv("FAKE_SESSION_ID", "cancel-session");
    const hangLog = join(stateDir, "dsh-cancel.log");
    vi.stubEnv("FAKE_ACP_LOG", hangLog);
    const cancelled = request(13, "tools/call", {
      name: "dsh_delegate",
      arguments: { task: "hang", cwd },
    }) as Promise<{ result?: { isError?: boolean; structuredContent?: { error?: { code?: string }; sessionId?: string; provider?: string } } }>;
    await waitForLog(hangLog, "prompt:cancel-session");
    await notify("notifications/cancelled", { requestId: 13, reason: "test cancel" });
    await waitForLog(hangLog, "cancel:cancel-session");
    const cancelledResult = await Promise.race([
      cancelled,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1_000)),
    ]);
    if (cancelledResult) {
      expect(cancelledResult.result?.isError).toBe(true);
      expect(cancelledResult.result?.structuredContent).toMatchObject({
        provider: "dsh",
        sessionId: "cancel-session",
        error: { code: "CANCELLED" },
      });
    }
    await cleanupAllChildren();
    const lease = await new SessionStore(stateDir, "dsh").acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
    await clientTransport.close();
    await server.close();
  }, 20_000);

  it("times out a hung DSH prompt through the MCP tool", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "relay-server-dsh-hang-"));
    dirs.push(cwd);
    const { server, clientTransport, request } = await harness({
      dshCommand: process.execPath,
      dshCommandArgs: [dshFixture],
      totalTimeoutMs: 1_500,
      cancelGraceMs: 100,
    });
    vi.stubEnv("FAKE_ACP_MODE", "hang");
    vi.stubEnv("FAKE_SESSION_ID", "cancel-session");
    const hung = await request(12, "tools/call", {
      name: "dsh_delegate",
      arguments: { task: "hang", cwd },
    }) as { result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } } };
    expect(hung.result?.isError).toBe(true);
    expect(hung.result?.structuredContent?.error?.code).toBe("TIMEOUT");
    await clientTransport.close();
    await server.close();
  }, 15_000);
});
