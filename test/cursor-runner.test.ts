import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelayConfig } from "../src/config.js";
import { cleanupAllChildren, CursorRunner, GrokRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-grok");
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "relay-cursor-"));
  dirs.push(path);
  return path;
}

function config(stateDir: string, overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    command: process.execPath,
    commandArgs: [join(dirname(fixture), "fake-agent.mjs")],
    cursorCommand: fixture,
    stateDir,
    phaseTimeoutMs: 2_000,
    totalTimeoutMs: 5_000,
    cancelGraceMs: 100,
    termGraceMs: 100,
    textLimitBytes: 256 * 1024,
    stderrLimitBytes: 64 * 1024,
    progressIntervalMs: 1,
    ...overrides,
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupAllChildren();
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CursorRunner", () => {
  it("starts Cursor ACP with disabled client capabilities, authenticates, and resumes saved options", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "cursor.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "cursor");
    const first = await new CursorRunner(config(state), store).delegate({
      task: "one",
      cwd,
      model: "test-model",
      mode: "ask",
    });
    expect(first).toMatchObject({
      provider: "cursor",
      sessionId: "fake-session-1",
      stopReason: "end_turn",
      text: "fresh answer",
      truncated: false,
    });
    await new CursorRunner(config(state), store).delegate({ task: "two", cwd, sessionId: "fake-session-1" });
    const events = await readFile(log, "utf8");
    expect(events).toContain('argv:["--sandbox","enabled","--model","test-model","--mode","ask","acp"]');
    expect(events).toContain('"fs":{"readTextFile":false,"writeTextFile":false}');
    expect(events).toContain('"terminal":false');
    expect(events).toContain("auth:cursor_login");
    expect(events).toContain("load:fake-session-1");
    expect(events).toContain("delegated:1");
    expect(events).toContain("Work non-interactively.");
  });

  it("requires an explicit Cursor command and rejects nested delegation", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const settings = config(state);
    delete settings.cursorCommand;
    await expect(new CursorRunner(settings, new SessionStore(state, "cursor")).delegate({ task: "one", cwd }))
      .rejects.toMatchObject({ code: "CURSOR_COMMAND_REQUIRED" });
    vi.stubEnv("GROK_RELAY_DELEGATED", "1");
    await expect(new CursorRunner(config(state), new SessionStore(state, "cursor")).delegate({ task: "one", cwd }))
      .rejects.toMatchObject({ code: "NESTED_DELEGATION" });
  });

  it("keeps Cursor and Grok sessions separate while sharing cwd locks", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const state = await tempDir();
    const cwd = await tempDir();
    const grok = await new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "grok", cwd });
    const cursor = await new CursorRunner(config(state), new SessionStore(state, "cursor")).delegate({ task: "cursor", cwd });
    expect(grok.sessionId).toBe(cursor.sessionId);
    await expect(new SessionStore(state).read("fake-session-1", cwd)).resolves.toMatchObject({ sessionId: "fake-session-1" });
    await expect(new SessionStore(state, "cursor").read("fake-session-1", cwd)).resolves.toMatchObject({
      sessionId: "fake-session-1",
      mode: "agent",
    });

    vi.stubEnv("FAKE_ACP_MODE", "hang");
    const log = join(state, "lock.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_SESSION_ID", "lock-session");
    const active = new CursorRunner(config(state), new SessionStore(state, "cursor")).delegate({ task: "hang", cwd });
    while (true) {
      try { if ((await readFile(log, "utf8")).includes("prompt:lock-session")) break; } catch { /* wait */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expect(new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "blocked", cwd }))
      .rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    await cleanupAllChildren();
    await expect(active).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("rejects option conflicts before spawning and restores the saved session mode", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "mode.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "cursor");
    await new CursorRunner(config(state), store).delegate({ task: "one", cwd, model: "m1", mode: "ask" });
    await expect(new CursorRunner(config(state), store).delegate({ task: "two", cwd, sessionId: "fake-session-1", model: "m2" }))
      .rejects.toMatchObject({ code: "SESSION_OPTION_CONFLICT" });
    vi.stubEnv("FAKE_CURSOR_CURRENT_MODE", "agent");
    await new CursorRunner(config(state), store).delegate({ task: "two", cwd, sessionId: "fake-session-1" });
    expect(await readFile(log, "utf8")).toContain("set-mode:fake-session-1:ask");
  });

  it("fails closed for unavailable auth, ask mode, and malformed Cursor metadata", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const store = new SessionStore(state, "cursor");
    vi.stubEnv("FAKE_ACP_MODE", "no-auth");
    await expect(new CursorRunner(config(state), store).delegate({ task: "auth", cwd }))
      .rejects.toMatchObject({ code: "AUTH_UNAVAILABLE" });

    vi.stubEnv("FAKE_ACP_MODE", "normal");
    vi.stubEnv("FAKE_CURSOR_CURRENT_MODE", "agent");
    vi.stubEnv("FAKE_CURSOR_NO_ASK", "1");
    await expect(new CursorRunner(config(state), store).delegate({ task: "ask", cwd, mode: "ask" }))
      .rejects.toMatchObject({ code: "MODE_UNAVAILABLE" });

    vi.stubEnv("FAKE_CURSOR_NO_ASK", "0");
    await store.writeNew("metadata-without-mode", cwd);
    await expect(new CursorRunner(config(state), store).delegate({ task: "resume", cwd, sessionId: "metadata-without-mode" }))
      .rejects.toMatchObject({ code: "CORRUPT_SESSION" });
  });

  it.each([
    ["permission", "selected", "deny-actual", "touch denied.txt"],
    ["permission-basic", "selected", "deny-actual", "Permission requested for Shell"],
    ["permission-no-reject", "cancelled", undefined, "touch denied.txt"],
  ])("rejects Cursor permissions for %s and sends the response before cancellation", async (mode, outcome, optionId, summary) => {
    vi.stubEnv("FAKE_ACP_MODE", mode);
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, `${mode}.log`);
    vi.stubEnv("FAKE_ACP_LOG", log);
    await expect(new CursorRunner(config(state), new SessionStore(state, "cursor")).delegate({ task: "permission", cwd }))
      .rejects.toMatchObject({
        code: "PERMISSION_REQUIRED",
        partial: {
          provider: "cursor",
          sessionId: "fake-session-1",
          truncated: false,
          interactions: [expect.objectContaining({ type: "permission", outcome: "rejected", summary: expect.stringContaining(summary) })],
        },
      });
    const events = await readFile(log, "utf8");
    const response = optionId
      ? `permission-response:{"outcome":{"outcome":"${outcome}","optionId":"${optionId}"}}`
      : `permission-response:{"outcome":{"outcome":"${outcome}"}}`;
    expect(events.indexOf(response)).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("cancel:fake-session-1")).toBeGreaterThan(events.indexOf(response));
  });

  it("collects Cursor extensions and keeps current merged todo state", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "extensions");
    const state = await tempDir();
    const cwd = await tempDir();
    const result = await new CursorRunner(config(state), new SessionStore(state, "cursor")).delegate({ task: "extensions", cwd });
    expect(result.interactions).toEqual([
      expect.objectContaining({ type: "question", outcome: "skipped", summary: "Pick one" }),
      expect.objectContaining({ type: "plan", outcome: "rejected", summary: "Do the work" }),
    ]);
    expect(result.todos).toEqual([{ id: "one", content: "Work", status: "completed" }]);
    expect(result.subagents).toEqual([expect.objectContaining({ agentId: "agent-1", subagentType: "explore" })]);
    expect(result.images).toEqual([expect.objectContaining({ filePath: "/tmp/icon.png", referenceImageCount: 1 })]);
  });

  it("bounds Cursor summaries and exposes truncation", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "summary-large");
    const state = await tempDir();
    const cwd = await tempDir();
    const result = await new CursorRunner(config(state, { textLimitBytes: 100 }), new SessionStore(state, "cursor"))
      .delegate({ task: "large", cwd });
    expect(result.summariesTruncated).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.subagents))).toBeLessThan(64 * 1_024);
  });
});
