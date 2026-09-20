import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupAllChildren, GrokRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";
import { RelayFailure } from "../src/types.js";
import { backpressureFixture, baseConfig as config, tempDir as makeTempDir, useRunnerCleanup, waitForLog } from "./helpers.js";

const dirs: string[] = [];
vi.setConfig({ testTimeout: 15_000 });
useRunnerCleanup(dirs);
const tempDir = () => makeTempDir(dirs);

describe("GrokRunner", () => {
  it("rejects a pre-aborted request before acquiring a lock or spawning", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const controller = new AbortController();
    controller.abort();
    await expect(new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "cancel", cwd }, controller.signal))
      .rejects.toMatchObject({ code: "CANCELLED" });
    const lease = await new SessionStore(state).acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });

  it("creates then resumes a session in a fresh runner and filters load history", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "fake.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const first = await new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "one", cwd });
    expect(first).toEqual({ sessionId: "fake-session-1", stopReason: "end_turn", text: "fresh answer", truncated: false });
    const second = await new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "two", cwd, sessionId: first.sessionId as string });
    expect(second.text).toBe("fresh answer");
    expect(second.text).not.toContain("OLD HISTORY");
    const events = await readFile(log, "utf8");
    expect(events).toContain('"terminal":false');
    expect(events).toContain("auth:cached_token");
    expect(events).toContain("new:");
    expect(events).toContain("load:fake-session-1");
    expect(events).toContain('"name":"codex-agent-relay"');
    expect(events).toContain("delegated:1");
  });

  it("exposes only session IDs backed by relay records", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const state = await tempDir();
    const cwd = await tempDir();
    const store = new SessionStore(state);
    const writeNew = vi.spyOn(store, "writeNew").mockRejectedValueOnce(new RelayFailure("STATE_IO", "injected write failure"));
    await expect(new GrokRunner(config(state), store).delegate({ task: "new", cwd }))
      .rejects.toMatchObject({ code: "STATE_IO", partial: { sessionId: null } });

    writeNew.mockRestore();
    await store.writeNew("saved-session", cwd);
    vi.stubEnv("FAKE_ACP_MODE", "load-fail");
    await expect(new GrokRunner(config(state), store).delegate({ task: "existing", cwd, sessionId: "saved-session" }))
      .rejects.toMatchObject({ code: "ACP_FAILURE", partial: { sessionId: "saved-session" } });
  });

  it("rejects nested delegation and ignores the old loop-guard key", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const state = await tempDir();
    const cwd = await tempDir();
    vi.stubEnv("GROK_RELAY_DELEGATED", "1");
    await expect(new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "one", cwd }))
      .resolves.toMatchObject({ sessionId: "fake-session-1" });
    vi.stubEnv("CODEX_AGENT_RELAY_DELEGATED", "1");
    await expect(new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "one", cwd }))
      .rejects.toMatchObject({ code: "NESTED_DELEGATION" });
  });

  it("prefers API-key authentication when present", async () => {
    vi.stubEnv("XAI_API_KEY", "test-key");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "auth.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "one", cwd });
    expect(await readFile(log, "utf8")).toContain("auth:xai.api_key");
  });

  it("reports missing auth, missing load capability, and load failures without replacement sessions", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const state = await tempDir();
    const cwd = await tempDir();
    vi.stubEnv("FAKE_ACP_MODE", "no-auth");
    await expect(new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "one", cwd }))
      .rejects.toMatchObject({ code: "AUTH_UNAVAILABLE" });

    vi.stubEnv("FAKE_ACP_MODE", "normal");
    const created = await new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "one", cwd });
    vi.stubEnv("FAKE_ACP_MODE", "no-load");
    await expect(new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "two", cwd, sessionId: created.sessionId as string }))
      .rejects.toMatchObject({ code: "LOAD_UNSUPPORTED" });
    vi.stubEnv("FAKE_ACP_MODE", "load-fail");
    await expect(new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "two", cwd, sessionId: created.sessionId as string }))
      .rejects.toMatchObject({ code: "ACP_FAILURE" });
  });

  it("preserves partial output, caps text, and reports progress", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("FAKE_ACP_MODE", "large");
    const state = await tempDir();
    const cwd = await tempDir();
    const progress: string[] = [];
    const result = await new GrokRunner(config(state, { textLimitBytes: 100 }), new SessionStore(state))
      .delegate({ task: "large", cwd }, undefined, (message) => { progress.push(message); });
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(100);
    expect(result.truncated).toBe(true);
    expect(progress).toEqual(["Fake tool"]);
  });

  it("truncates only on UTF-8 character boundaries", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("FAKE_ACP_MODE", "unicode");
    const state = await tempDir();
    const cwd = await tempDir();
    const result = await new GrokRunner(config(state, { textLimitBytes: 101 }), new SessionStore(state))
      .delegate({ task: "unicode", cwd });
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(101);
    expect(result.text).not.toContain("�");
    expect(result.truncated).toBe(true);
  });

  it("rejects unknown client requests promptly instead of hanging", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("FAKE_ACP_MODE", "unknown-request");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "unknown.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const result = await new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "unknown", cwd });
    expect(result.stopReason).toBe("end_turn");
    expect(await readFile(log, "utf8")).toContain("unknown-rejected");
  });

  it("kills descendants left behind after the Grok leader exits", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("FAKE_ACP_MODE", "descendant");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "descendant.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "descendant", cwd });
    const match = /descendant:(\d+)/.exec(await readFile(log, "utf8"));
    expect(match).not.toBeNull();
    expect(() => process.kill(Number(match?.[1]), 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it("cancels a hung prompt before terminating the child", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("FAKE_ACP_MODE", "hang");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "cancel.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await expect(new GrokRunner(config(state, { totalTimeoutMs: 1_000 }), new SessionStore(state)).delegate({ task: "hang", cwd }))
      .rejects.toMatchObject({ code: "TIMEOUT" });
    expect((await readFile(log, "utf8")).match(/cancel:fake-session-1/g)).toHaveLength(1);
    const lease = await new SessionStore(state).acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });

  it("bounds cancellation when the ACP stdin write queue is backpressured", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const state = await tempDir();
    const cwd = await tempDir();
    const settings = config(state, {
      commandArgs: [backpressureFixture],
      totalTimeoutMs: 2_000,
      cancelGraceMs: 100,
      termGraceMs: 100,
    });
    const started = Date.now();
    await expect(new GrokRunner(settings, new SessionStore(state)).delegate({ task: "x".repeat(2 * 1024 * 1024), cwd }))
      .rejects.toMatchObject({ code: "TIMEOUT", partial: { sessionId: "backpressure-session" } });
    expect(Date.now() - started).toBeLessThan(
      settings.totalTimeoutMs + settings.cancelGraceMs + settings.termGraceMs + settings.killConfirmMs + 500,
    );
    const lease = await new SessionStore(state).acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });

  it("tracks shutdown before a child reaches the spawn event", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const state = await tempDir();
    const cwd = await tempDir();
    class SlowStore extends SessionStore {
      override async acquire(path: string) {
        const lease = await super.acquire(path);
        await new Promise((resolve) => setTimeout(resolve, 50));
        return lease;
      }
    }
    const promise = new GrokRunner(config(state), new SlowStore(state)).delegate({ task: "startup", cwd });
    const rejected = expect(promise).rejects.toMatchObject({ code: "CANCELLED" });
    await cleanupAllChildren();
    await rejected;
    const lease = await new SessionStore(state).acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });

  it("surfaces a lock release failure after cleaning the child", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const state = await tempDir();
    const cwd = await tempDir();
    class BadReleaseStore extends SessionStore {
      override async acquire(path: string) {
        const lease = await super.acquire(path);
        lease.release = async () => { throw new RelayFailure("LOCK_IO", "release failed"); };
        return lease;
      }
    }
    await expect(new GrokRunner(config(state), new BadReleaseStore(state)).delegate({ task: "release", cwd }))
      .rejects.toMatchObject({ code: "LOCK_IO", message: "release failed" });
  });

  it("does not deadlock global cleanup when lock release fails", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("FAKE_ACP_MODE", "hang");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "release-cleanup.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    class BadReleaseStore extends SessionStore {
      override async acquire(path: string) {
        const lease = await super.acquire(path);
        lease.release = async () => { throw new RelayFailure("LOCK_IO", "release failed during shutdown"); };
        return lease;
      }
    }
    const promise = new GrokRunner(config(state), new BadReleaseStore(state)).delegate({ task: "hang", cwd });
    const rejected = expect(promise).rejects.toMatchObject({ code: "LOCK_IO", partial: { sessionId: "fake-session-1" } });
    await waitForLog(log, "prompt:fake-session-1");
    await expect(cleanupAllChildren()).rejects.toMatchObject({
      name: "CleanupAggregateError",
      primaryCode: "LOCK_IO",
      failureCount: 1,
    });
    await rejected;
  });

  it.runIf(process.platform === "win32")("retains the lock after a Windows worker exits before tree cleanup", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("FAKE_ACP_MODE", "exit");
    const state = await tempDir();
    const cwd = await tempDir();
    await expect(new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "exit", cwd }))
      .rejects.toMatchObject({ code: "PROCESS_CLEANUP_FAILED" });
    await expect(new SessionStore(state).acquire(cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  }, 15_000);

  it.runIf(process.platform !== "win32")("reports an exited POSIX worker and releases its lock", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("FAKE_ACP_MODE", "exit");
    const state = await tempDir();
    const cwd = await tempDir();
    await expect(new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "exit", cwd }))
      .rejects.toMatchObject({ code: "ACP_FAILURE" });
    const lease = await new SessionStore(state).acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });

  it.each(["malformed"])("reports %s child failure without claiming Windows cleanup success", async (mode) => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("FAKE_ACP_MODE", mode);
    const state = await tempDir();
    const cwd = await tempDir();
    await expect(new GrokRunner(config(state), new SessionStore(state)).delegate({ task: mode, cwd }))
      .rejects.toMatchObject({ code: process.platform === "win32" ? "PROCESS_CLEANUP_FAILED" : "ACP_FAILURE" });
  });

  it("stops a writing descendant before releasing a successful task lock", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("FAKE_ACP_MODE", "descendant-write");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "writer.log");
    const output = join(state, "writer.out");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_DESCENDANT_OUTPUT", output);
    await new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "writer", cwd });
    const pid = Number(/descendant:(\d+)/.exec(await readFile(log, "utf8"))?.[1]);
    const lease = await new SessionStore(state).acquire(cwd);
    const first = (await readFile(output, "utf8")).length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await readFile(output, "utf8")).length).toBe(first);
    await lease.markReaped("no-worker-created");
    await lease.release();
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    const release = await new SessionStore(state).acquire(cwd);
    await release.markReaped("no-worker-created");
    await release.release();
  });

  it("rejects an unexpected permission request and keeps the session id", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("FAKE_ACP_MODE", "permission");
    const state = await tempDir();
    const cwd = await tempDir();
    await expect(new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "permission", cwd }))
      .rejects.toMatchObject({ code: "UNEXPECTED_PERMISSION", partial: { sessionId: "fake-session-1" } });
  });
});
