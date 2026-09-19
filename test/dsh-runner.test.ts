import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dshSpawnSpec } from "../src/adapters/dsh.js";
import { loadConfig } from "../src/config.js";
import { DshRunner, GrokRunner, OpenCodeRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";
import { baseConfig as config, dshFixture, tempDir as makeTempDir, useRunnerCleanup, waitForLog } from "./helpers.js";

const dirs: string[] = [];
vi.setConfig({ testTimeout: 15_000 });
useRunnerCleanup(dirs);
const tempDir = () => makeTempDir(dirs);

describe("DshRunner", () => {
  it("constructs default dsh argv when dshCommandArgs is omitted", () => {
    expect(dshSpawnSpec(loadConfig({}))).toEqual({ command: "dsh", args: ["--profile", "acp"] });
    expect(dshSpawnSpec(loadConfig({ CODEX_AGENT_RELAY_DSH_COMMAND: "  /opt/dsh  " }))).toEqual({
      command: "/opt/dsh",
      args: ["--profile", "acp"],
    });
    expect(dshSpawnSpec(config("/tmp/state", { dshCommandArgs: [dshFixture] }))).toEqual({
      command: process.execPath,
      args: [dshFixture],
    });
  });

  it("starts DSH ACP without authenticate and with skipped client capabilities", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const overrideLog = join(state, "override.log");
    vi.stubEnv("FAKE_ACP_LOG", overrideLog);
    const first = await new DshRunner(config(state), new SessionStore(state, "dsh")).delegate({
      task: "one",
      cwd,
    });
    expect(first).toMatchObject({
      provider: "dsh",
      sessionId: "fake-session-1",
      stopReason: "end_turn",
      text: "fresh answer",
      truncated: false,
      usage: { used: 42, size: 128, cost: { amount: 3.5, currency: "USD" } },
      toolCalls: [
        expect.objectContaining({ toolCallId: "t1", title: "Fake tool", status: "in_progress" }),
        expect.objectContaining({ toolCallId: "t1", status: "completed" }),
      ],
    });
    expect(first.text).not.toContain("OTHER SESSION");
    expect(first.toolCalls?.some((call) => call.toolCallId === "other-tool")).toBe(false);
    const events = await readFile(overrideLog, "utf8");
    expect(events).toContain(JSON.stringify([dshFixture]).slice(1, -1));
    expect(events).not.toContain("--profile");
    expect(events).toContain("delegated:1");
    expect(events).not.toContain("auth:");
    expect(events).toContain("new:");
    expect(events).toContain("This is a noninteractive delegated task.");
    expect(events).not.toContain("set-config:");
    expect(events).not.toContain('"readTextFile":true');
    expect(events).not.toContain('"terminal":true');
  });

  it("uses a complete dshCommandArgs override including profile tokens", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "profile.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await new DshRunner(config(state, { dshCommandArgs: [dshFixture, "--profile", "acp"] }), new SessionStore(state, "dsh"))
      .delegate({ task: "one", cwd });
    const events = await readFile(log, "utf8");
    expect(events).toContain("--profile");
    expect(events).toContain("acp");
  });

  it("fails closed for a missing DSH executable", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    await expect(new DshRunner(config(state, {
      dshCommand: join(state, "missing-dsh-binary"),
      dshCommandArgs: [],
    }), new SessionStore(state, "dsh")).delegate({ task: "one", cwd }))
      .rejects.toMatchObject({ code: "ACP_FAILURE" });
  });

  it("does not authenticate even when unknown methods are advertised", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "auth.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_ACP_MODE", "unknown-auth");
    await new DshRunner(config(state), new SessionStore(state, "dsh")).delegate({ task: "one", cwd });
    expect(await readFile(log, "utf8")).not.toContain("auth:");
  });

  it("resumes known sessions and never loads or falls back to new", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "restore.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "dsh");
    const created = await new DshRunner(config(state), store).delegate({ task: "one", cwd });
    const resumed = await new DshRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
    });
    expect(resumed.text).toBe("fresh answer");
    vi.stubEnv("FAKE_ACP_MODE", "resume-fail");
    await expect(new DshRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
    })).rejects.toMatchObject({ code: "ACP_FAILURE" });
    const events = await readFile(log, "utf8");
    expect(events).toContain("resume:fake-session-1");
    expect(events).not.toContain("load:");
    expect(events.match(/new:/g)).toHaveLength(1);
  });

  it("fails RESUME_UNSUPPORTED without load or replacement session", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const store = new SessionStore(state, "dsh");
    const created = await new DshRunner(config(state), store).delegate({ task: "one", cwd });
    const log = join(state, "caps.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_ACP_MODE", "no-resume");
    await expect(new DshRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
    })).rejects.toMatchObject({ code: "RESUME_UNSUPPORTED" });
    const events = await readFile(log, "utf8");
    expect(events).not.toContain("resume:");
    expect(events).not.toContain("load:");
    expect(events).not.toContain("new:");
    expect(events).not.toContain("prompt:");
  });

  it("rejects unknown sessions, cwd mismatch, and provider namespace mixing", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const other = await tempDir();
    const store = new SessionStore(state, "dsh");
    const created = await new DshRunner(config(state), store).delegate({ task: "one", cwd });
    await expect(new DshRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: "missing-session",
    })).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
    await expect(new DshRunner(config(state), store).delegate({
      task: "two",
      cwd: other,
      sessionId: created.sessionId as string,
    })).rejects.toMatchObject({ code: "CWD_MISMATCH" });
    await expect(new DshRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
    })).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
    })).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
    vi.stubEnv("CODEX_AGENT_RELAY_DELEGATED", "1");
    await expect(new DshRunner(config(state), store).delegate({ task: "nested", cwd }))
      .rejects.toMatchObject({ code: "NESTED_DELEGATION" });
  });

  it("shares cwd locks across providers while isolating DSH session records", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const state = await tempDir();
    const cwd = await tempDir();
    const dsh = await new DshRunner(config(state), new SessionStore(state, "dsh")).delegate({ task: "dsh", cwd });
    const grok = await new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "grok", cwd });
    expect(dsh.sessionId).toBe(grok.sessionId);
    await expect(new SessionStore(state, "dsh").read("fake-session-1", cwd)).resolves.toMatchObject({
      sessionId: "fake-session-1",
      cwd,
    });
    expect(await new SessionStore(state, "dsh").read("fake-session-1", cwd)).not.toHaveProperty("model");
    expect(await new SessionStore(state, "dsh").read("fake-session-1", cwd)).not.toHaveProperty("mode");

    vi.stubEnv("FAKE_ACP_MODE", "hang");
    const log = join(state, "lock.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_SESSION_ID", "lock-session");
    const active = new DshRunner(config(state), new SessionStore(state, "dsh")).delegate({ task: "hang", cwd });
    await waitForLog(log, "prompt:lock-session");
    await expect(new GrokRunner(config(state), new SessionStore(state)).delegate({ task: "blocked", cwd }))
      .rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    const { cleanupAllChildren } = await import("../src/runner.js");
    await cleanupAllChildren();
    await expect(active).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("configures model then reasoning_effort, including grouped values and post-model option refresh", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "config.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_ACP_MODE", "grouped");
    const store = new SessionStore(state, "dsh");
    await new DshRunner(config(state), store).delegate({
      task: "one",
      cwd,
      model: "dsh/gpt",
      reasoningEffort: "high",
    });
    await new DshRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: "fake-session-1",
      model: "dsh/fast",
    });
    const events = await readFile(log, "utf8");
    expect(events).toContain("set-config:model:dsh/gpt");
    expect(events).toContain("set-config:reasoning_effort:high");
    expect(events).toContain("set-config:model:dsh/fast");
    expect(events.indexOf("set-config:model:dsh/gpt"))
      .toBeLessThan(events.indexOf("set-config:reasoning_effort:high"));
    expect(events.indexOf("set-config:reasoning_effort:high")).toBeLessThan(events.indexOf("prompt:fake-session-1"));

    vi.stubEnv("FAKE_ACP_MODE", "");
    vi.stubEnv("FAKE_SESSION_ID", "effort-session");
    vi.stubEnv("FAKE_ACP_LOG", join(state, "effort-only.log"));
    await new DshRunner(config(state), store).delegate({
      task: "effort-only",
      cwd,
      reasoningEffort: "low",
    });
    expect(await readFile(join(state, "effort-only.log"), "utf8")).toContain("set-config:reasoning_effort:low");
    expect(await readFile(join(state, "effort-only.log"), "utf8")).not.toContain("set-config:model:");
  });

  it("rejects missing, invalid, and timed-out config without prompting", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "invalid.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await expect(new DshRunner(config(state), new SessionStore(state, "dsh")).delegate({
      task: "one",
      cwd,
      model: "missing/model",
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });

    vi.stubEnv("FAKE_ACP_MODE", "no-effort");
    await expect(new DshRunner(config(state), new SessionStore(state, "dsh")).delegate({
      task: "one",
      cwd,
      reasoningEffort: "high",
    })).rejects.toMatchObject({ code: "CONFIG_UNSUPPORTED" });

    vi.stubEnv("FAKE_ACP_MODE", "grouped");
    await expect(new DshRunner(config(state), new SessionStore(state, "dsh")).delegate({
      task: "one",
      cwd,
      model: "dsh/fast",
      reasoningEffort: "high",
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });

    vi.stubEnv("FAKE_ACP_MODE", "config-timeout");
    await expect(new DshRunner(config(state, { phaseTimeoutMs: 1_500 }), new SessionStore(state, "dsh")).delegate({
      task: "one",
      cwd,
      model: "dsh/gpt",
    })).rejects.toMatchObject({ code: "CONFIG_TIMEOUT" });

    const events = await readFile(log, "utf8");
    expect(events).not.toContain("prompt:");
    expect(events).not.toContain("set-config:model:missing/model");
    expect(events).not.toContain("set-config:reasoning_effort:high");
    expect(events).toContain("set-config:model:dsh/fast");
    expect(events).toContain("set-config:model:dsh/gpt");
  });

  it("does not send the prompt after abort during the reasoning_effort request", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "config-hang-effort");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "config-cancel.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "dsh");
    const controller = new AbortController();
    const pending = new DshRunner(config(state, { cancelGraceMs: 500 }), store).delegate({
      task: "configure",
      cwd,
      model: "dsh/gpt",
      reasoningEffort: "high",
    }, controller.signal);
    await waitForLog(log, "set-config:reasoning_effort:high");
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "CANCELLED",
      message: "MCP request was cancelled",
    });
    const events = await readFile(log, "utf8");
    expect(events).toContain("set-config:model:dsh/gpt");
    expect(events).toContain("set-config:reasoning_effort:high");
    expect(events).not.toContain("prompt:");
    const lease = await store.acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });

  it("selects reject_once and still reports PERMISSION_REQUIRED after a fast completion", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "permission-continue");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "reject.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await expect(new DshRunner(config(state), new SessionStore(state, "dsh")).delegate({
      task: "permission",
      cwd,
    })).rejects.toMatchObject({
      code: "PERMISSION_REQUIRED",
      message: expect.stringContaining("Edit"),
      partial: {
        provider: "dsh",
        sessionId: "fake-session-1",
      },
    });
    const events = await readFile(log, "utf8");
    expect(events).toContain(
      'permission-response:{"outcome":{"outcome":"selected","optionId":"reject-actual"}}',
    );
    expect(events).not.toContain("allow-once-actual");
    expect(events).not.toContain("always-actual");
  });

  it("cancels when reject_once is missing", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "permission-missing");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "missing.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await expect(new DshRunner(config(state), new SessionStore(state, "dsh")).delegate({
      task: "permission",
      cwd,
    })).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" });
    expect(await readFile(log, "utf8")).toContain('permission-response:{"outcome":{"outcome":"cancelled"}}');
  });

  it("cancels a permission request from another session and a repeated request after failure", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "permission-other-session");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "other-permission.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const result = await new DshRunner(config(state), new SessionStore(state, "dsh")).delegate({
      task: "other",
      cwd,
    });
    expect(result.stopReason).toBe("end_turn");
    expect(await readFile(log, "utf8")).toContain(
      'permission-other-response:{"outcome":{"outcome":"cancelled"}}',
    );

    vi.stubEnv("FAKE_ACP_MODE", "permission-repeat");
    vi.stubEnv("FAKE_SESSION_ID", "repeat-session");
    const repeatLog = join(state, "repeat.log");
    vi.stubEnv("FAKE_ACP_LOG", repeatLog);
    await expect(new DshRunner(config(state), new SessionStore(state, "dsh")).delegate({
      task: "repeat",
      cwd,
    })).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" });
    expect(await readFile(repeatLog, "utf8")).toContain(
      'permission-repeat-response:{"outcome":{"outcome":"cancelled"}}',
    );
  });

  it("cancels a late permission request after caller abort", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "permission-after-cancel");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "late-permission.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "dsh");
    const controller = new AbortController();
    const pending = new DshRunner(config(state, { cancelGraceMs: 500 }), store).delegate({
      task: "hang",
      cwd,
    }, controller.signal);
    await waitForLog(log, "prompt:fake-session-1");
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "CANCELLED",
      message: "MCP request was cancelled",
    });
    const events = await readFile(log, "utf8");
    expect(events).toContain("cancel:fake-session-1");
    expect(events).toContain('permission-response:{"outcome":{"outcome":"cancelled"}}');
    expect(events).not.toContain('"outcome":"selected"');
    const lease = await store.acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });

  it("keeps latest usage, bounds tool summaries, and preserves partial provider fields", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const result = await new DshRunner(config(state), new SessionStore(state, "dsh")).delegate({
      task: "usage",
      cwd,
    });
    expect(result.usage).toEqual({ used: 42, size: 128, cost: { amount: 3.5, currency: "USD" } });

    vi.stubEnv("FAKE_ACP_MODE", "summary-large");
    vi.stubEnv("FAKE_SESSION_ID", "summary-session");
    const large = await new DshRunner(config(state, { textLimitBytes: 100 }), new SessionStore(state, "dsh"))
      .delegate({ task: "large", cwd });
    expect(large.summariesTruncated).toBe(true);
    expect(large.truncated).toBe(true);
    expect(large.provider).toBe("dsh");

    vi.stubEnv("FAKE_ACP_MODE", "partial-fail");
    vi.stubEnv("FAKE_SESSION_ID", "partial-session");
    await expect(new DshRunner(config(state), new SessionStore(state, "dsh")).delegate({ task: "fail", cwd }))
      .rejects.toMatchObject({
        code: "ACP_FAILURE",
        partial: {
          provider: "dsh",
          sessionId: "partial-session",
          text: "partial text",
          toolCalls: expect.arrayContaining([expect.objectContaining({ toolCallId: "t1" })]),
          usage: { used: 42, size: 128, cost: { amount: 3.5, currency: "USD" } },
        },
      });
  });

  it("cancels a hung prompt and kills leftover descendants", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const hangLog = join(state, "hang.log");
    vi.stubEnv("FAKE_ACP_LOG", hangLog);
    vi.stubEnv("FAKE_ACP_MODE", "hang");
    await expect(new DshRunner(config(state, { totalTimeoutMs: 1_500 }), new SessionStore(state, "dsh"))
      .delegate({ task: "hang", cwd })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(await readFile(hangLog, "utf8")).toContain("cancel:fake-session-1");
    const lease = await new SessionStore(state, "dsh").acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();

    vi.stubEnv("FAKE_ACP_MODE", "descendant");
    vi.stubEnv("FAKE_SESSION_ID", "descendant-session");
    const descendantLog = join(state, "descendant.log");
    vi.stubEnv("FAKE_ACP_LOG", descendantLog);
    await new DshRunner(config(state), new SessionStore(state, "dsh")).delegate({ task: "descendant", cwd });
    const match = /descendant:(\d+)/.exec(await readFile(descendantLog, "utf8"));
    expect(match).not.toBeNull();
    expect(() => process.kill(Number(match?.[1]), 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it.each(["exit", "malformed"])("reports %s child failure without claiming Windows cleanup success", async (mode) => {
    vi.stubEnv("FAKE_ACP_MODE", mode);
    const state = await tempDir();
    const cwd = await tempDir();
    await expect(new DshRunner(config(state), new SessionStore(state, "dsh")).delegate({ task: mode, cwd }))
      .rejects.toMatchObject({ code: process.platform === "win32" ? "PROCESS_CLEANUP_FAILED" : "ACP_FAILURE" });
    if (process.platform === "win32") {
      await expect(new SessionStore(state).acquire(cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    }
  });
});
