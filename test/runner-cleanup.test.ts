import { rm } from "node:fs/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import type * as ProcessTree from "../src/runner/process-tree.js";

const state = vi.hoisted(() => ({
  report: "unconfirmed" as "unconfirmed" | "throw",
  actualCalls: 0,
  realConfirmed: [] as boolean[],
  children: [] as ChildProcessWithoutNullStreams[],
}));

vi.mock("../src/runner/process-tree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessTree>();
  return {
    ...actual,
    createProcessTreeController: (...args: Parameters<typeof actual.createProcessTreeController>) => {
      state.children.push(args[0]);
      const real = actual.createProcessTreeController(...args);
      let termination: Promise<ProcessTree.TerminationReport> | undefined;
      return {
        reference: real.reference,
        terminate: () => {
          termination ??= (async () => {
            state.actualCalls += 1;
            const report = await real.terminate();
            state.realConfirmed.push(report.confirmed);
            if (!report.confirmed) throw new Error(`fixture cleanup failed: ${report.reason ?? "unknown"}`);
            if (state.report === "throw") throw new Error("test cleanup exception");
            return { forced: true, confirmed: false, reason: "test cannot confirm cleanup" };
          })();
          return termination;
        },
      };
    },
  };
});

const dirs: string[] = [];
vi.setConfig({ testTimeout: 15_000 });

beforeEach(() => {
  if (process.env.CODEX_AGENT_RELAY_DELEGATED === "1") {
    vi.stubEnv("CODEX_AGENT_RELAY_DELEGATED", "");
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  state.report = "unconfirmed";
  state.actualCalls = 0;
  const confirmed = state.realConfirmed;
  state.realConfirmed = [];
  for (const child of state.children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    // These fixtures have no descendants. Reap them independently of the fault injection.
    await new Promise<void>((resolve, reject) => {
      const onExit = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        reject(new Error("Test fixture could not be reaped"));
      }, 2_000);
      child.once("exit", onExit);
      child.kill("SIGKILL");
    });
  }
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  expect(confirmed.length).toBeGreaterThan(0);
  expect(confirmed.every(Boolean)).toBe(true);
});

describe("AcpRunner cleanup failure", () => {
  it.each(["unconfirmed", "throw"] as const)("retains partial output and the cwd lock when cleanup returns %s", async (mode) => {
    state.report = mode;
    const { GrokRunner } = await import("../src/runner.js");
    const { SessionStore } = await import("../src/store.js");
    const { baseConfig, tempDir } = await import("./helpers.js");
    vi.stubEnv("XAI_API_KEY", "");
    const stateDir = await tempDir(dirs);
    const cwd = await tempDir(dirs);
    let releaseCalls = 0;
    class CountingStore extends SessionStore {
      override async acquire(path: string) {
        const lease = await super.acquire(path);
        const release = lease.release.bind(lease);
        lease.release = async () => { releaseCalls += 1; await release(); };
        return lease;
      }
    }
    await expect(new GrokRunner(baseConfig(stateDir), new CountingStore(stateDir)).delegate({ task: "ok", cwd }))
      .rejects.toMatchObject({
        code: "PROCESS_CLEANUP_FAILED",
        partial: { sessionId: "fake-session-1", text: "fresh answer", truncated: false },
      });
    expect(releaseCalls).toBe(0);
    expect(state.actualCalls).toBe(1);
    await expect(new SessionStore(stateDir).acquire(cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  });

  it("overrides the original task error while retaining its code in the diagnostic message", async () => {
    const { GrokRunner } = await import("../src/runner.js");
    const { SessionStore } = await import("../src/store.js");
    const { baseConfig, tempDir } = await import("./helpers.js");
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("FAKE_ACP_MODE", "permission");
    const stateDir = await tempDir(dirs);
    const cwd = await tempDir(dirs);
    await expect(new GrokRunner(baseConfig(stateDir), new SessionStore(stateDir)).delegate({ task: "permission", cwd }))
      .rejects.toMatchObject({ code: "PROCESS_CLEANUP_FAILED", message: expect.stringContaining("UNEXPECTED_PERMISSION") });
    await expect(new SessionStore(stateDir).acquire(cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  });

  it.each(["unconfirmed", "throw"] as const)("shares cancellation with shutdown and retains the lock when termination is %s", async (mode) => {
    state.report = mode;
    const { GrokRunner, cleanupAllChildren } = await import("../src/runner.js");
    const { SessionStore } = await import("../src/store.js");
    const { baseConfig, tempDir, waitForLog } = await import("./helpers.js");
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("FAKE_ACP_MODE", "hang");
    const stateDir = await tempDir(dirs);
    const cwd = await tempDir(dirs);
    const log = join(stateDir, "cancel.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const abort = new AbortController();
    const pending = new GrokRunner(baseConfig(stateDir), new SessionStore(stateDir)).delegate({ task: "hang", cwd }, abort.signal);
    void pending.catch(() => undefined);
    await waitForLog(log, "prompt:fake-session-1");
    abort.abort();
    await expect(cleanupAllChildren()).rejects.toMatchObject({
      name: "CleanupAggregateError",
      primaryCode: "PROCESS_CLEANUP_FAILED",
      failureCount: 1,
    });
    await expect(pending).rejects.toMatchObject({ code: "PROCESS_CLEANUP_FAILED" });
    expect((await (await import("node:fs/promises")).readFile(log, "utf8")).match(/cancel:fake-session-1/g)).toHaveLength(1);
    expect(state.actualCalls).toBe(1);
    await expect(new SessionStore(stateDir).acquire(cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  });

  it("serializes nonempty cleanup-failure partial output through the MCP server", async () => {
    const { createRelayServer } = await import("../src/server.js");
    const { baseConfig, tempDir } = await import("./helpers.js");
    vi.stubEnv("XAI_API_KEY", "");
    const stateDir = await tempDir(dirs);
    const cwd = await tempDir(dirs);
    const server = createRelayServer(baseConfig(stateDir));
    const [client, transport] = InMemoryTransport.createLinkedPair();
    const responses = new Map<number, (message: JSONRPCMessage) => void>();
    client.onmessage = (message) => {
      if ("id" in message && typeof message.id === "number") responses.get(message.id)?.(message);
    };
    await client.start();
    await server.connect(transport);
    const request = async (id: number, method: string, params: Record<string, unknown>) => {
      const result = new Promise<JSONRPCMessage>((resolve) => responses.set(id, resolve));
      await client.send({ jsonrpc: "2.0", id, method, params });
      return result;
    };
    await request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const response = await request(2, "tools/call", { name: "grok_delegate", arguments: { task: "ok", cwd } }) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: unknown };
    };
    expect(response.result).toMatchObject({
      isError: true,
      structuredContent: { sessionId: "fake-session-1", text: "fresh answer", error: { code: "PROCESS_CLEANUP_FAILED" } },
    });
    expect(JSON.parse(response.result?.content?.[0]?.text ?? "null")).toEqual(response.result?.structuredContent);
    await client.close();
    await server.close();
  });
});
