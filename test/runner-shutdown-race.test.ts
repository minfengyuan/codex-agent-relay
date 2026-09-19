import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";
import { beginRunnerShutdown, cleanupAllChildren, GrokRunner } from "../src/runner.js";
import { createRelayServer } from "../src/server.js";
import { SessionStore } from "../src/store.js";
import type * as Store from "../src/store.js";
import { RelayFailure } from "../src/types.js";
import { baseConfig, cleanupDirs, clearDelegatedEnv, tempDir } from "./helpers.js";

const state = vi.hoisted(() => ({ beforeResolve: async () => {} }));
vi.mock("../src/store.js", async (load) => {
  const actual = await load<typeof Store>();
  return { ...actual, resolveCwd: async (cwd: string) => {
    await state.beforeResolve(); return actual.resolveCwd(cwd);
  } };
});
function barrier() {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), release: () => resolve() };
}

it("snapshots blocked acquisition, rejects delayed cwd resolution, and caches a failed shutdown", async () => {
  clearDelegatedEnv();
  const dirs: string[] = [];
  const acquired = barrier(), acquireGate = barrier(), resolving = barrier(), resolveGate = barrier();
  const stages: string[] = [];
  const root = await tempDir(dirs), cwd = await tempDir(dirs), laterCwd = await tempDir(dirs);
  const config = baseConfig(root, { command: "fixture-must-never-spawn" });
  class DelayedStore extends SessionStore {
    override async acquire(path: string) {
      const lease = await super.acquire(path);
      const spawn = lease.markSpawning, reaped = lease.markReaped;
      lease.markSpawning = async () => { stages.push("spawning"); await spawn(); };
      lease.markReaped = async (evidence) => { stages.push(evidence); await reaped(evidence); };
      lease.release = async () => { stages.push("release"); throw new RelayFailure("LOCK_IO", "fixture release failed"); };
      acquired.release(); await acquireGate.promise;
      return lease;
    }
  }
  const acquireSpy = vi.spyOn(SessionStore.prototype, "acquire");
  const task = new GrokRunner(config, new DelayedStore(root)).delegate({ task: "cancel before spawn", cwd });
  const taskOutcome = task.catch((error: unknown) => error);
  const server = createRelayServer(config);
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const responses = new Map<number, (message: JSONRPCMessage) => void>();
  client.onmessage = (message) => { if ("id" in message && typeof message.id === "number") responses.get(message.id)?.(message); };
  const request = async (id: number, method: string, params: Record<string, unknown>) => {
    const response = new Promise<JSONRPCMessage>((resolve) => responses.set(id, resolve));
    await client.send({ jsonrpc: "2.0", id, method, params }); return response;
  };
  try {
    await acquired.promise;
    await client.start(); await server.connect(transport);
    await request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    state.beforeResolve = async () => { resolving.release(); await resolveGate.promise; };
    const late = request(2, "tools/call", { name: "grok_delegate", arguments: { task: "late", cwd: laterCwd } });
    await resolving.promise;
    let settled = false;
    const first = beginRunnerShutdown();
    const outcome = first.catch((error: unknown) => error).finally(() => { settled = true; });
    expect(beginRunnerShutdown()).toBe(first);
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveGate.release();
    const response = await late as { result?: { structuredContent?: { error?: { code: string } }; content?: Array<{ text: string }> } };
    expect(response.result?.structuredContent?.error?.code).toBe("CANCELLED");
    expect(JSON.parse(response.result?.content?.[0]?.text ?? "null")).toEqual(response.result?.structuredContent);
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    acquireGate.release();
    const failure = await outcome;
    expect(failure).toMatchObject({ primaryCode: "LOCK_IO", taskCount: 1, failureCount: 1 });
    expect(await taskOutcome).toMatchObject({ code: "LOCK_IO" });
    expect(stages).toEqual(["no-worker-created", "release"]);
    expect(beginRunnerShutdown()).toBe(first);
    await expect(beginRunnerShutdown()).rejects.toBe(failure);
    await expect(cleanupAllChildren()).resolves.toBeUndefined();
  } finally {
    acquireGate.release(); resolveGate.release();
    await taskOutcome;
    await cleanupAllChildren().catch(() => undefined);
    await client.close(); await server.close();
    acquireSpy.mockRestore(); await cleanupDirs(dirs);
  }
}, 10_000);
