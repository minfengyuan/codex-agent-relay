import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupAllChildren, CursorRunner, GrokRunner, OpenCodeRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";
import { baseConfig, tempDir, useRunnerCleanup, waitForLog } from "./helpers.js";

const dirs: string[] = [];
useRunnerCleanup(dirs);

describe("workspace locks", () => {
  it("keeps Cursor and Grok sessions separate while sharing cwd locks", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const state = await tempDir(dirs);
    const cwd = await tempDir(dirs);
    const grok = await new GrokRunner(baseConfig(state), new SessionStore(state)).delegate({ task: "grok", cwd });
    const cursor = await new CursorRunner(baseConfig(state), new SessionStore(state, "cursor")).delegate({ task: "cursor", cwd });
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
    const active = new CursorRunner(baseConfig(state), new SessionStore(state, "cursor")).delegate({ task: "hang", cwd });
    await waitForLog(log, "prompt:lock-session");
    await expect(new GrokRunner(baseConfig(state), new SessionStore(state)).delegate({ task: "blocked", cwd }))
      .rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    await cleanupAllChildren();
    await expect(active).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("isolates OpenCode metadata while sharing cwd locks across providers", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const state = await tempDir(dirs);
    const cwd = await tempDir(dirs);
    const grok = await new GrokRunner(baseConfig(state), new SessionStore(state)).delegate({ task: "grok", cwd });
    const cursor = await new CursorRunner(baseConfig(state), new SessionStore(state, "cursor")).delegate({
      task: "cursor",
      cwd,
    });
    const opencode = await new OpenCodeRunner(baseConfig(state), new SessionStore(state, "opencode")).delegate({
      task: "opencode",
      cwd,
    });
    expect(grok.sessionId).toBe(opencode.sessionId);
    expect(cursor.sessionId).toBe(opencode.sessionId);
    await expect(new SessionStore(state).read("fake-session-1", cwd)).resolves.toMatchObject({ sessionId: "fake-session-1" });
    await expect(new SessionStore(state, "cursor").read("fake-session-1", cwd)).resolves.toMatchObject({ mode: "agent" });
    await expect(new SessionStore(state, "opencode").read("fake-session-1", cwd)).resolves.toMatchObject({
      sessionId: "fake-session-1",
      cwd,
    });
    expect(await new SessionStore(state, "opencode").read("fake-session-1", cwd)).not.toHaveProperty("model");
    expect(await new SessionStore(state, "opencode").read("fake-session-1", cwd)).not.toHaveProperty("mode");

    vi.stubEnv("FAKE_ACP_MODE", "hang");
    const log = join(state, "lock.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_SESSION_ID", "lock-session");
    const active = new OpenCodeRunner(baseConfig(state), new SessionStore(state, "opencode")).delegate({ task: "hang", cwd });
    await waitForLog(log, "prompt:lock-session");
    await expect(new GrokRunner(baseConfig(state), new SessionStore(state)).delegate({ task: "blocked", cwd }))
      .rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    await expect(new CursorRunner(baseConfig(state), new SessionStore(state, "cursor")).delegate({ task: "blocked", cwd }))
      .rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    await cleanupAllChildren();
    await expect(active).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
