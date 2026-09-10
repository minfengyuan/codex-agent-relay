import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type RelayConfig } from "../src/config.js";
import { cleanupAllChildren, CursorRunner, GrokRunner, OpenCodeRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = join(fixtures, "fake-opencode-agent.mjs");
const grokFixture = join(fixtures, "fake-agent.mjs");
const cursorFixture = join(fixtures, "fake-agent.mjs");
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "relay-opencode-"));
  dirs.push(path);
  return realpath(path);
}

function config(stateDir: string, overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    command: process.execPath,
    commandArgs: [grokFixture],
    cursorCommand: process.execPath,
    cursorCommandArgs: [cursorFixture],
    opencodeCommand: process.execPath,
    opencodeCommandArgs: [fixture],
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

describe("loadConfig", () => {
  it("defaults to opencode and trims an explicit command", () => {
    expect(loadConfig({}).opencodeCommand).toBe("opencode");
    expect(loadConfig({ CODEX_AGENT_RELAY_OPENCODE_COMMAND: "  /bin/oc  " }).opencodeCommand).toBe("/bin/oc");
    expect(loadConfig({ CODEX_AGENT_RELAY_OPENCODE_COMMAND: "   " }).opencodeCommand).toBe("opencode");
  });

  it("reads new config keys and ignores old GROK_RELAY_* keys", () => {
    const defaults = loadConfig({});
    expect(defaults.command).toBe("grok");
    expect(defaults.cursorCommand).toBeUndefined();
    expect(defaults.stateDir).toBe(join(homedir(), ".local", "codex-agent-relay"));
    expect(defaults.phaseTimeoutMs).toBe(30_000);
    expect(defaults.totalTimeoutMs).toBe(3_600_000);
    expect(defaults.cancelGraceMs).toBe(5_000);
    expect(defaults.termGraceMs).toBe(2_000);
    expect(defaults.textLimitBytes).toBe(256 * 1024);
    expect(defaults.stderrLimitBytes).toBe(64 * 1024);
    expect(defaults.progressIntervalMs).toBe(1_000);

    expect(loadConfig({
      CODEX_AGENT_RELAY_GROK_COMMAND: "custom-grok",
      CODEX_AGENT_RELAY_CURSOR_COMMAND: "  /bin/cursor  ",
      CODEX_AGENT_RELAY_STATE_DIR: "/tmp/relay-state",
      CODEX_AGENT_RELAY_PHASE_TIMEOUT_MS: "10",
    })).toMatchObject({
      command: "custom-grok",
      cursorCommand: "/bin/cursor",
      stateDir: "/tmp/relay-state",
      phaseTimeoutMs: 10,
    });

    expect(loadConfig({
      GROK_RELAY_GROK_COMMAND: "old-grok",
      GROK_RELAY_CURSOR_COMMAND: "/old/cursor",
      GROK_RELAY_OPENCODE_COMMAND: "/old/opencode",
      GROK_RELAY_STATE_DIR: "/old/state",
      GROK_RELAY_PHASE_TIMEOUT_MS: "1",
      GROK_RELAY_TOTAL_TIMEOUT_MS: "2",
      GROK_RELAY_CANCEL_GRACE_MS: "3",
      GROK_RELAY_TERM_GRACE_MS: "4",
      GROK_RELAY_TEXT_LIMIT_BYTES: "5",
      GROK_RELAY_STDERR_LIMIT_BYTES: "6",
      GROK_RELAY_PROGRESS_INTERVAL_MS: "7",
    })).toEqual(defaults);
  });
});

describe("OpenCodeRunner", () => {
  it("starts OpenCode ACP with matching cwd, overlay env, and skipped client fs/terminal capabilities", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "start.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("OPENCODE_PERMISSION", JSON.stringify({ bash: "allow" }));
    const first = await new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "one",
      cwd,
    });
    expect(first).toMatchObject({
      provider: "opencode",
      sessionId: "fake-session-1",
      stopReason: "end_turn",
      text: "fresh answer",
      truncated: false,
      usage: { used: 42, size: 128, cost: { amount: 3.5, currency: "USD" } },
      toolCalls: [expect.objectContaining({ toolCallId: "t1", title: "Fake tool" })],
    });
    expect(first.text).not.toContain("OTHER SESSION");
    expect(first.toolCalls?.some((call) => call.toolCallId === "other-tool")).toBe(false);
    const events = await readFile(log, "utf8");
    expect(events).toContain(JSON.stringify(["acp", "--cwd", cwd]).slice(1, -1));
    expect(events).toContain(`process-cwd:${cwd}`);
    expect(events).toContain(`cwd-arg:${cwd}`);
    expect(events).toContain("delegated:1");
    expect(events).toContain("auth:opencode-login");
    expect(events).toContain("new:");
    expect(events).toContain('permission-env:{"bash":"allow","question":"deny"}');
    expect(events).toContain("This is a noninteractive delegated task.");
    expect(events).not.toContain("set-config:");
    expect(events).not.toContain('"readTextFile":true');
    expect(events).not.toContain('"terminal":true');
  });

  it("rejects resume without sessionId before spawning", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "resume-input.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "one",
      cwd,
      resume: true,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "one",
      cwd,
      resume: false,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(readFile(log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes by default, loads when forced, and filters load replay", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "restore.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "opencode");
    const created = await new OpenCodeRunner(config(state), store).delegate({ task: "one", cwd });
    const resumed = await new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
    });
    expect(resumed.text).toBe("fresh answer");
    expect(resumed.text).not.toContain("OLD HISTORY");
    expect(resumed.toolCalls?.some((call) => call.toolCallId === "replay-tool")).toBe(false);
    expect(resumed.usage).toEqual({ used: 42, size: 128, cost: { amount: 3.5, currency: "USD" } });
    const loaded = await new OpenCodeRunner(config(state), store).delegate({
      task: "three",
      cwd,
      sessionId: created.sessionId as string,
      resume: false,
    });
    expect(loaded.text).toBe("fresh answer");
    expect(loaded.text).not.toContain("OLD HISTORY");
    const events = await readFile(log, "utf8");
    expect(events).toContain("resume:fake-session-1");
    expect(events).toContain("load:fake-session-1");
  });

  it("does not fall back from resume or load failures", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const store = new SessionStore(state, "opencode");
    const created = await new OpenCodeRunner(config(state), store).delegate({ task: "one", cwd });
    const log = join(state, "fail.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_ACP_MODE", "resume-fail");
    await expect(new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
    })).rejects.toMatchObject({ code: "ACP_FAILURE" });
    vi.stubEnv("FAKE_ACP_MODE", "load-fail");
    await expect(new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
      resume: false,
    })).rejects.toMatchObject({ code: "ACP_FAILURE" });
    const events = await readFile(log, "utf8");
    expect(events).toContain("resume:fake-session-1");
    expect(events).toContain("load:fake-session-1");
    expect(events).not.toContain("new:");
    expect(events).not.toContain("prompt:");
  });

  it("dispatches resume/load from advertised capabilities without creating a replacement session", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const store = new SessionStore(state, "opencode");
    const created = await new OpenCodeRunner(config(state), store).delegate({ task: "one", cwd });
    const log = join(state, "caps.log");
    vi.stubEnv("FAKE_ACP_LOG", log);

    vi.stubEnv("FAKE_ACP_MODE", "no-resume");
    await new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
    });
    expect(await readFile(log, "utf8")).toContain("load:fake-session-1");
    expect(await readFile(log, "utf8")).not.toContain("resume:");

    vi.stubEnv("FAKE_ACP_MODE", "no-load");
    await expect(new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
      resume: false,
    })).rejects.toMatchObject({ code: "LOAD_UNSUPPORTED" });

    vi.stubEnv("FAKE_ACP_MODE", "no-load-no-resume");
    await expect(new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
    })).rejects.toMatchObject({ code: "LOAD_UNSUPPORTED" });
    const events = await readFile(log, "utf8");
    expect(events.match(/new:/g)).toBeNull();
  });

  it("skips empty auth, authenticates opencode-login, and rejects unknown methods", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "auth.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_ACP_MODE", "no-auth");
    await new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({ task: "one", cwd });
    expect(await readFile(log, "utf8")).not.toContain("auth:");

    vi.stubEnv("FAKE_ACP_MODE", "unknown-auth");
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({ task: "one", cwd }))
      .rejects.toMatchObject({ code: "AUTH_UNAVAILABLE" });
  });

  it("configures model, effort, then mode from grouped options and allows later changes", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "config.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_ACP_MODE", "grouped");
    const store = new SessionStore(state, "opencode");
    await new OpenCodeRunner(config(state), store).delegate({
      task: "one",
      cwd,
      model: "opencode/gpt",
      effort: "high",
      agent: "plan",
    });
    await new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: "fake-session-1",
      model: "opencode/fast",
    });
    const events = await readFile(log, "utf8");
    expect(events).toContain("set-config:model:opencode/gpt");
    expect(events).toContain("set-config:effort:high");
    expect(events).toContain("set-config:mode:plan");
    expect(events).toContain("set-config:model:opencode/fast");
    expect(events.indexOf("set-config:model:opencode/gpt"))
      .toBeLessThan(events.indexOf("set-config:effort:high"));
    expect(events.indexOf("set-config:effort:high"))
      .toBeLessThan(events.indexOf("set-config:mode:plan"));
    expect(events.indexOf("set-config:mode:plan")).toBeLessThan(events.indexOf("prompt:fake-session-1"));
  });

  it("rejects invalid or unsupported options and config timeouts without prompting", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "invalid.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "one",
      cwd,
      model: "missing/model",
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });

    vi.stubEnv("FAKE_ACP_MODE", "no-effort");
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "one",
      cwd,
      effort: "high",
    })).rejects.toMatchObject({ code: "CONFIG_UNSUPPORTED" });

    vi.stubEnv("FAKE_ACP_MODE", "grouped");
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "one",
      cwd,
      model: "opencode/fast",
      effort: "high",
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });

    vi.stubEnv("FAKE_ACP_MODE", "config-timeout");
    await expect(new OpenCodeRunner(config(state, { phaseTimeoutMs: 1_500 }), new SessionStore(state, "opencode")).delegate({
      task: "one",
      cwd,
      model: "opencode/gpt",
    })).rejects.toMatchObject({ code: "CONFIG_TIMEOUT" });

    const events = await readFile(log, "utf8");
    expect(events).not.toContain("prompt:");
    expect(events).not.toContain("set-config:model:missing/model");
    expect(events).not.toContain("set-config:effort:high");
    expect(events).toContain("set-config:model:opencode/fast");
    expect(events).toContain("set-config:model:opencode/gpt");
  });

  it("selects the actual allow_once option id and continues", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "permission");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "allow.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const result = await new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "permission",
      cwd,
    });
    expect(result).toMatchObject({
      provider: "opencode",
      stopReason: "end_turn",
      text: "fresh answer",
    });
    expect(await readFile(log, "utf8")).toContain(
      'permission-response:{"outcome":{"outcome":"selected","optionId":"allow-once-actual"}}',
    );
    expect(await readFile(log, "utf8")).not.toContain("always-actual");
  });

  it("cancels when allow_once is missing and preserves partial output", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "permission-missing");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "missing.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "permission",
      cwd,
    })).rejects.toMatchObject({
      code: "PERMISSION_REQUIRED",
      partial: {
        provider: "opencode",
        sessionId: "fake-session-1",
      },
    });
    const events = await readFile(log, "utf8");
    expect(events).toContain('permission-response:{"outcome":{"outcome":"cancelled"}}');
    expect(events.indexOf("cancel:fake-session-1")).toBeGreaterThan(events.indexOf("permission-response:"));
    expect(events).not.toContain("always-actual");
  });

  it("cancels a late permission request after caller abort and never selects allow_once", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "permission-after-cancel");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "late-permission.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "opencode");
    const controller = new AbortController();
    const pending = new OpenCodeRunner(config(state, { cancelGraceMs: 500 }), store).delegate({
      task: "hang",
      cwd,
    }, controller.signal);
    while (true) {
      try { if ((await readFile(log, "utf8")).includes("prompt:fake-session-1")) break; } catch { /* wait */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "CANCELLED",
      message: "MCP request was cancelled",
    });
    const events = await readFile(log, "utf8");
    expect(events).toContain("cancel:fake-session-1");
    expect(events).toContain('permission-response:{"outcome":{"outcome":"cancelled"}}');
    expect(events).not.toContain('"outcome":"selected"');
    expect(events).not.toContain("allow-once-actual");
    const release = await store.acquire(cwd);
    await release();
  });

  it("does not send later OpenCode config options after abort between steps", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "config-hang-effort");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "config-cancel.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "opencode");
    const controller = new AbortController();
    const pending = new OpenCodeRunner(config(state, { cancelGraceMs: 500 }), store).delegate({
      task: "configure",
      cwd,
      model: "opencode/gpt",
      effort: "high",
      agent: "plan",
    }, controller.signal);
    while (true) {
      try { if ((await readFile(log, "utf8")).includes("set-config:effort:high")) break; } catch { /* wait */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "CANCELLED",
      message: "MCP request was cancelled",
    });
    const events = await readFile(log, "utf8");
    expect(events).toContain("set-config:model:opencode/gpt");
    expect(events).toContain("set-config:effort:high");
    expect(events).not.toContain("set-config:mode:");
    expect(events).not.toContain("prompt:");
    const release = await store.acquire(cwd);
    await release();
  });

  it("cancels a permission request from another session without approving it", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "permission-other-session");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "other-permission.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const result = await new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "other",
      cwd,
    });
    expect(result.stopReason).toBe("end_turn");
    expect(await readFile(log, "utf8")).toContain(
      'permission-other-response:{"outcome":{"outcome":"cancelled"}}',
    );
  });

  it("rejects invalid OPENCODE_PERMISSION without leaking contents or spawning", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "env.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("OPENCODE_PERMISSION", "not-json {secret:1}");
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({ task: "one", cwd }))
      .rejects.toMatchObject({
        code: "OPENCODE_PERMISSION_INVALID",
        message: "OPENCODE_PERMISSION must be a JSON object",
      });
    vi.stubEnv("OPENCODE_PERMISSION", "[1,2]");
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({ task: "one", cwd }))
      .rejects.toMatchObject({ code: "OPENCODE_PERMISSION_INVALID" });
    await expect(readFile(log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps latest usage, bounds tool summaries, and preserves partial provider fields", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const result = await new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "usage",
      cwd,
    });
    expect(result.usage).toEqual({ used: 42, size: 128, cost: { amount: 3.5, currency: "USD" } });

    vi.stubEnv("FAKE_ACP_MODE", "summary-large");
    vi.stubEnv("FAKE_SESSION_ID", "summary-session");
    const large = await new OpenCodeRunner(config(state, { textLimitBytes: 100 }), new SessionStore(state, "opencode"))
      .delegate({ task: "large", cwd });
    expect(large.summariesTruncated).toBe(true);
    expect(large.truncated).toBe(true);
    expect(large.provider).toBe("opencode");

    vi.stubEnv("FAKE_ACP_MODE", "partial-fail");
    vi.stubEnv("FAKE_SESSION_ID", "partial-session");
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({ task: "fail", cwd }))
      .rejects.toMatchObject({
        code: "ACP_FAILURE",
        partial: {
          provider: "opencode",
          sessionId: "partial-session",
          text: "partial text",
          toolCalls: [expect.objectContaining({ toolCallId: "t1" })],
          usage: { used: 42, size: 128, cost: { amount: 3.5, currency: "USD" } },
        },
      });
  });

  it("isolates OpenCode metadata while sharing cwd locks across providers", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const state = await tempDir();
    const cwd = await tempDir();
    const grok = await new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "grok", cwd });
    const cursor = await new CursorRunner(config(state), new SessionStore(state, "cursor")).delegate({
      task: "cursor",
      cwd,
    });
    const opencode = await new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
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
    const active = new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({ task: "hang", cwd });
    while (true) {
      try { if ((await readFile(log, "utf8")).includes("prompt:lock-session")) break; } catch { /* wait */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expect(new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "blocked", cwd }))
      .rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    await expect(new CursorRunner(config(state), new SessionStore(state, "cursor")).delegate({ task: "blocked", cwd }))
      .rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    await cleanupAllChildren();
    await expect(active).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("rejects a cwd mismatch and nested delegation", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const other = await tempDir();
    const store = new SessionStore(state, "opencode");
    const created = await new OpenCodeRunner(config(state), store).delegate({ task: "one", cwd });
    await expect(new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd: other,
      sessionId: created.sessionId as string,
    })).rejects.toMatchObject({ code: "CWD_MISMATCH" });
    vi.stubEnv("GROK_RELAY_DELEGATED", "1");
    await expect(new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd: other,
      sessionId: created.sessionId as string,
    })).rejects.toMatchObject({ code: "CWD_MISMATCH" });
    vi.stubEnv("CODEX_AGENT_RELAY_DELEGATED", "1");
    await expect(new OpenCodeRunner(config(state), store).delegate({ task: "nested", cwd }))
      .rejects.toMatchObject({ code: "NESTED_DELEGATION" });
  });

  it("cancels a hung prompt and kills leftover descendants", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const hangLog = join(state, "hang.log");
    vi.stubEnv("FAKE_ACP_LOG", hangLog);
    vi.stubEnv("FAKE_ACP_MODE", "hang");
    await expect(new OpenCodeRunner(config(state, { totalTimeoutMs: 1_500 }), new SessionStore(state, "opencode"))
      .delegate({ task: "hang", cwd })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(await readFile(hangLog, "utf8")).toContain("cancel:fake-session-1");
    const release = await new SessionStore(state, "opencode").acquire(cwd);
    await release();

    vi.stubEnv("FAKE_ACP_MODE", "descendant");
    vi.stubEnv("FAKE_SESSION_ID", "descendant-session");
    const descendantLog = join(state, "descendant.log");
    vi.stubEnv("FAKE_ACP_LOG", descendantLog);
    await new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({ task: "descendant", cwd });
    const match = /descendant:(\d+)/.exec(await readFile(descendantLog, "utf8"));
    expect(match).not.toBeNull();
    expect(() => process.kill(Number(match?.[1]), 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it.each(["exit", "malformed"])("turns %s child failure into an ACP error", async (mode) => {
    vi.stubEnv("FAKE_ACP_MODE", mode);
    const state = await tempDir();
    const cwd = await tempDir();
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({ task: mode, cwd }))
      .rejects.toMatchObject({ code: "ACP_FAILURE" });
  });
});

describe("OpenCode permission overlay", () => {
  it("sets question deny when OPENCODE_PERMISSION is absent", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "default-env.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({ task: "one", cwd });
    expect(await readFile(log, "utf8")).toContain('permission-env:{"question":"deny"}');
  });
});
