import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { dshSpawnSpec, resolveWindowsDshLauncher } from "../src/adapters/dsh.js";
import { loadConfig } from "../src/config.js";
import { DshRunner, GrokRunner, OpenCodeRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";
import { baseConfig as config, dshFixture, tempDir as makeTempDir, useRunnerCleanup, waitForLog } from "./helpers.js";

const dirs: string[] = [];
vi.setConfig({ testTimeout: 15_000 });
useRunnerCleanup(dirs);
const tempDir = () => makeTempDir(dirs);

function launcherEnv(pathValue: string, pathext = ".com;.exe;.cmd;.js"): NodeJS.ProcessEnv {
  return { PATH: pathValue, PATHEXT: pathext };
}

function npmCmdShim(relativeEntry: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeEntry}" %*`,
    "",
  ].join("\r\n");
}

function pnpmCmdShim(relativeEntry: string): string {
  return [
    "@SETLOCAL",
    "@IF NOT DEFINED NODE_PATH (",
    '  @SET "NODE_PATH=C:\\unrelated\\node_modules"',
    ") ELSE (",
    '  @SET "NODE_PATH=C:\\unrelated\\node_modules;%NODE_PATH%"',
    ")",
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${relativeEntry}" %*`,
    ") ELSE (",
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
    `  node  "%~dp0\\${relativeEntry}" %*`,
    ")",
    "",
  ].join("\r\n");
}

async function writeDshPackage(
  pkgRoot: string,
  options: { name?: string; bin?: unknown; source?: string } = {},
): Promise<string> {
  const entry = join(pkgRoot, "lib", "bin.js");
  await mkdir(join(pkgRoot, "lib"), { recursive: true });
  await writeFile(join(pkgRoot, "package.json"), `${JSON.stringify({
    name: options.name ?? "@deepseek-ai/dsh",
    bin: options.bin ?? { dsh: "lib/bin.js" },
  })}\n`);
  await writeFile(entry, options.source ?? "console.log('dsh');\n");
  return entry;
}

function expectAcpFailure(run: () => unknown, needle: string): void {
  try {
    run();
    expect.fail("expected ACP_FAILURE");
  } catch (error) {
    expect(error).toMatchObject({ code: "ACP_FAILURE", message: expect.stringContaining(needle) });
  }
}

describe("DshRunner", () => {
  it("constructs default dsh argv when dshCommandArgs is omitted", () => {
    if (process.platform !== "win32") {
      expect(dshSpawnSpec(loadConfig({}))).toEqual({ command: "dsh", args: ["--profile", "acp"] });
      expect(dshSpawnSpec(loadConfig({ CODEX_AGENT_RELAY_DSH_COMMAND: "  /opt/dsh  " }))).toEqual({
        command: "/opt/dsh",
        args: ["--profile", "acp"],
      });
    }
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
    expect(events.indexOf("prompt:fake-session-1")).toBeLessThan(events.indexOf("close-start:fake-session-1"));
    expect(events).toContain("close-complete:fake-session-1");
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
    vi.stubEnv("FAKE_ACP_MODE", "resume-timeout");
    await expect(new DshRunner(config(state, { phaseTimeoutMs: 1_500 }), store).delegate({
      task: "three",
      cwd,
      sessionId: created.sessionId as string,
    })).rejects.toMatchObject({ code: "RESUME_TIMEOUT" });
    const events = await readFile(log, "utf8");
    expect(events).toContain("resume:fake-session-1");
    expect(events).not.toContain("load:");
    expect(events.match(/new:/g)).toHaveLength(1);
    expect(events.match(/close-complete:fake-session-1/g)).toHaveLength(2);
    expect(events.match(/close-start:fake-session-1/g)).toHaveLength(2);
  });

  it("requires session close capability before creating or resuming a session", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "no-close");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "no-close.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await expect(new DshRunner(config(state), new SessionStore(state, "dsh")).delegate({
      task: "one",
      cwd,
    })).rejects.toMatchObject({
      code: "SESSION_CLOSE_UNSUPPORTED",
      partial: { provider: "dsh", sessionId: null },
    });
    const events = await readFile(log, "utf8");
    expect(events).not.toContain("new:");
    expect(events).not.toContain("resume:");
    expect(events).not.toContain("prompt:");
    expect(events).not.toContain("close-start:");
  });

  it("does not return success until session close completes", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "close-delay");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "close-delay.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const pending = new DshRunner(config(state), new SessionStore(state, "dsh")).delegate({ task: "one", cwd });
    await waitForLog(log, "close-start:fake-session-1");
    const early = await Promise.race([
      pending.then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 30)),
    ]);
    expect(early).toBe("pending");
    await expect(pending).resolves.toMatchObject({ stopReason: "end_turn", text: "fresh answer" });
    expect(await readFile(log, "utf8")).toContain("close-complete:fake-session-1");
  });

  it.each([
    ["close-timeout", "SESSION_CLOSE_TIMEOUT"],
    ["close-fail", "SESSION_CLOSE_FAILED"],
  ] as const)("returns partial output when %s prevents a confirmed close", async (mode, code) => {
    vi.stubEnv("FAKE_ACP_MODE", mode);
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, `${mode}.log`);
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "dsh");
    await expect(new DshRunner(config(state, { phaseTimeoutMs: 1_500 }), store).delegate({ task: "one", cwd }))
      .rejects.toMatchObject({
        code,
        partial: {
          provider: "dsh",
          sessionId: "fake-session-1",
          text: "fresh answer",
          toolCalls: expect.arrayContaining([expect.objectContaining({ toolCallId: "t1" })]),
          usage: { used: 42, size: 128, cost: { amount: 3.5, currency: "USD" } },
        },
      });
    const events = await readFile(log, "utf8");
    expect(events.indexOf("prompt:fake-session-1")).toBeLessThan(events.indexOf("close-start:fake-session-1"));
    expect(events).not.toContain("cancel:fake-session-1");
    const lease = await store.acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });

  it.each([
    ["new-fail", "ACP_FAILURE"],
    ["new-timeout", "NEW_SESSION_TIMEOUT"],
  ] as const)("does not close when %s never activates a session", async (mode, code) => {
    vi.stubEnv("FAKE_ACP_MODE", mode);
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, `${mode}.log`);
    vi.stubEnv("FAKE_ACP_LOG", log);
    await expect(new DshRunner(config(state, { phaseTimeoutMs: 1_500 }), new SessionStore(state, "dsh"))
      .delegate({ task: mode, cwd })).rejects.toMatchObject({ code });
    const events = await readFile(log, "utf8");
    expect(events).toContain("new:");
    expect(events).not.toContain("close-start:");
  });

  it.each([
    ["partial-fail-close-fail", "SESSION_CLOSE_FAILED"],
    ["partial-fail-close-timeout", "SESSION_CLOSE_TIMEOUT"],
  ] as const)("keeps prompt failure primary when abnormal close reports %s", async (mode, closeCode) => {
    vi.stubEnv("FAKE_ACP_MODE", mode);
    vi.stubEnv("FAKE_SESSION_ID", `${mode}-session`);
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, `${mode}.log`);
    vi.stubEnv("FAKE_ACP_LOG", log);
    await expect(new DshRunner(config(state, { phaseTimeoutMs: 1_500 }), new SessionStore(state, "dsh"))
      .delegate({ task: mode, cwd })).rejects.toMatchObject({
        code: "ACP_FAILURE",
        message: expect.stringContaining(`session finalization error ${closeCode}`),
        partial: { text: "partial text" },
      });
    const events = await readFile(log, "utf8");
    expect(events).toContain(`close-start:${mode}-session`);
    expect(events).not.toContain(`cancel:${mode}-session`);
  });

  it("preserves a prompt/config failure when close hangs past the total timeout", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "config-fail-close-timeout");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "config-fail-close-timeout.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await expect(new DshRunner(config(state, {
      phaseTimeoutMs: 5_000,
      totalTimeoutMs: 3_000,
    }), new SessionStore(state, "dsh")).delegate({
      task: "configure",
      cwd,
      model: "dsh/gpt",
    })).rejects.toMatchObject({
      code: "ACP_FAILURE",
      message: expect.stringContaining("session finalization error SESSION_CLOSE_TIMEOUT"),
    });
    const events = await readFile(log, "utf8");
    expect(events).toContain("set-config:model:dsh/gpt");
    expect(events).toContain("close-start:fake-session-1");
    expect(events).not.toContain("cancel:fake-session-1");
  });

  it("keeps caller cancellation primary when abort races with normal close failure", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "close-delay-fail");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "close-abort.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const controller = new AbortController();
    const pending = new DshRunner(config(state), new SessionStore(state, "dsh"))
      .delegate({ task: "one", cwd }, controller.signal);
    await waitForLog(log, "close-start:fake-session-1");
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "CANCELLED",
      message: expect.stringContaining("session finalization error SESSION_CLOSE_FAILED"),
    });
    expect((await readFile(log, "utf8")).match(/close-start:fake-session-1/g)).toHaveLength(1);
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
    const events = await readFile(log, "utf8");
    expect(events.indexOf("cancel:lock-session")).toBeLessThan(events.indexOf("close-start:lock-session"));
    expect(events).toContain("close-complete:lock-session");
    expect(events.match(/close-start:lock-session/g)).toHaveLength(1);
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

  it.each([
    ["invalid-session", "", { model: "missing/model" }, "INVALID_CONFIG"],
    ["unsupported-session", "no-effort", { reasoningEffort: "high" }, "CONFIG_UNSUPPORTED"],
    ["rejected-session", "config-fail", { model: "dsh/gpt" }, "ACP_FAILURE"],
    ["partial-config-session", "grouped", { model: "dsh/fast", reasoningEffort: "high" }, "INVALID_CONFIG"],
    ["timeout-session", "config-timeout", { model: "dsh/gpt" }, "CONFIG_TIMEOUT"],
  ] as const)("persists and exposes %s when configuration fails", async (sessionId, mode, options, code) => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, `${sessionId}.log`);
    vi.stubEnv("FAKE_SESSION_ID", sessionId);
    vi.stubEnv("FAKE_ACP_MODE", mode);
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "dsh");
    const failure = await new DshRunner(config(state, { phaseTimeoutMs: 1_500 }), store).delegate({
      task: "one",
      cwd,
      ...options,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code, partial: { sessionId } });
    await expect(store.read(sessionId, cwd)).resolves.toMatchObject({ sessionId, cwd });
    const events = await readFile(log, "utf8");
    expect(events).toContain("new:");
    expect(events).not.toContain("prompt:");
    expect(events).toContain(`close-complete:${sessionId}`);

    if (sessionId === "invalid-session") {
      vi.stubEnv("FAKE_ACP_MODE", "");
      const resumed = await new DshRunner(config(state), store).delegate({
        task: "resume after configuration repair",
        cwd,
        sessionId,
        model: "dsh/gpt",
      });
      expect(resumed).toMatchObject({ sessionId, text: "fresh answer" });
      expect(await readFile(log, "utf8")).toContain(`resume:${sessionId}`);
    }
  });

  it("stops before configuration when the new session record conflicts", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "session-conflict.log");
    vi.stubEnv("FAKE_SESSION_ID", "conflicting-session");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "dsh");
    await store.writeNew("conflicting-session", cwd);
    await expect(new DshRunner(config(state), store).delegate({
      task: "one",
      cwd,
      model: "dsh/gpt",
    })).rejects.toMatchObject({
      code: "STATE_CONFLICT",
      partial: { sessionId: null },
    });
    const events = await readFile(log, "utf8");
    expect(events).toContain("new:");
    expect(events).not.toContain("set-config:");
    expect(events).not.toContain("prompt:");
    expect(events).toContain("close-complete:conflicting-session");
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
      partial: { sessionId: "fake-session-1" },
    });
    await expect(store.read("fake-session-1", cwd)).resolves.toMatchObject({ sessionId: "fake-session-1", cwd });
    const events = await readFile(log, "utf8");
    expect(events).toContain("set-config:model:dsh/gpt");
    expect(events).toContain("set-config:reasoning_effort:high");
    expect(events).not.toContain("prompt:");
    expect(events.indexOf("cancel:fake-session-1")).toBeLessThan(events.indexOf("close-start:fake-session-1"));
    expect(events).toContain("close-complete:fake-session-1");
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
    expect(events.indexOf("cancel:fake-session-1")).toBeLessThan(events.indexOf("close-start:fake-session-1"));
    expect(events).toContain("close-complete:fake-session-1");
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
    expect(events.indexOf("cancel:fake-session-1")).toBeLessThan(events.indexOf("close-start:fake-session-1"));
    expect(events).toContain("close-complete:fake-session-1");
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
    const hangEvents = await readFile(hangLog, "utf8");
    expect(hangEvents.indexOf("cancel:fake-session-1")).toBeLessThan(hangEvents.indexOf("close-start:fake-session-1"));
    expect(hangEvents).toContain("close-complete:fake-session-1");
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

  it.skipIf(process.platform !== "win32")("launches a Windows npm shim through Node without cmd.exe", async () => {
    const root = await tempDir();
    const state = await tempDir();
    const cwd = await tempDir();
    const pkgRoot = join(root, "node_modules", "@deepseek-ai", "dsh");
    const entry = await writeDshPackage(pkgRoot, {
      source: `import ${JSON.stringify(pathToFileURL(dshFixture).href)};\n`,
    });
    await writeFile(join(root, "dsh.cmd"), npmCmdShim("node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"));
    vi.stubEnv("PATH", root);
    vi.stubEnv("PATHEXT", ".COM;.EXE;.CMD");
    const cfg = config(state, { dshCommand: "dsh" });
    delete cfg.dshCommandArgs;
    const overrideLog = join(state, "windows-shim.log");
    vi.stubEnv("FAKE_ACP_LOG", overrideLog);
    const resolvedEntry = realpathSync(entry);
    expect(dshSpawnSpec(cfg)).toEqual({
      command: process.execPath,
      args: [resolvedEntry, "--profile", "acp"],
    });
    expect(dshSpawnSpec(cfg).command.toLowerCase()).not.toContain("cmd.exe");
    const result = await new DshRunner(cfg, new SessionStore(state, "dsh")).delegate({ task: "one", cwd });
    expect(result).toMatchObject({ provider: "dsh", sessionId: "fake-session-1", text: "fresh answer" });
    const events = await readFile(overrideLog, "utf8");
    expect(events).toContain(JSON.stringify([resolvedEntry, "--profile", "acp"]));
    expect(events).toContain("new:");
    expect(events).not.toContain("cmd.exe");
  });
});

describe("Windows DSH launcher resolution", () => {
  it("parses npm-style .cmd shims and keeps default --profile acp ordering", async () => {
    const root = await tempDir();
    const pkgRoot = join(root, "node_modules", "@deepseek-ai", "dsh");
    const entry = realpathSync(await writeDshPackage(pkgRoot));
    await writeFile(join(root, "dsh.cmd"), npmCmdShim("node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"));
    const env = launcherEnv(root);
    expect(resolveWindowsDshLauncher("dsh", env)).toEqual({
      command: process.execPath,
      prefixArgs: [entry],
    });
    expect(resolveWindowsDshLauncher("dsh", env).command.toLowerCase()).not.toContain("cmd.exe");
    const spec = dshSpawnSpec({ ...loadConfig({}), dshCommand: "dsh" }, env);
    if (process.platform === "win32") {
      expect(spec).toEqual({ command: process.execPath, args: [entry, "--profile", "acp"] });
    } else {
      expect(spec).toEqual({ command: "dsh", args: ["--profile", "acp"] });
    }
  });

  it("parses pnpm-style .cmd shims from node_modules/.bin", async () => {
    const root = await tempDir();
    const binDir = join(root, "node_modules", ".bin");
    const pkgRoot = join(root, "node_modules", "@deepseek-ai", "dsh");
    const entry = realpathSync(await writeDshPackage(pkgRoot));
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "dsh.cmd"), pnpmCmdShim("..\\@deepseek-ai\\dsh\\lib\\bin.js"));
    expect(resolveWindowsDshLauncher("dsh", launcherEnv(binDir))).toEqual({
      command: process.execPath,
      prefixArgs: [entry],
    });
  });

  it("resolves PATH/PATHEXT order, prefers native .exe, and ignores later PATH entries", async () => {
    const first = await tempDir();
    const second = await tempDir();
    const pkgRoot = join(first, "node_modules", "@deepseek-ai", "dsh");
    await writeDshPackage(pkgRoot);
    await writeFile(join(first, "dsh.cmd"), npmCmdShim("node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"));
    const exe = join(first, "dsh.exe");
    await writeFile(exe, "native");
    await writeFile(join(second, "dsh.cmd"), "malformed");
    expect(resolveWindowsDshLauncher("dsh", launcherEnv(`${first}${delimiter}${second}`, ".com;.exe;.cmd"))).toEqual({
      command: exe,
      prefixArgs: [],
    });
    expect(resolveWindowsDshLauncher("dsh", launcherEnv(first, ".cmd;.exe")).command).toBe(process.execPath);
  });

  it("resolves launchers in directories with spaces", async () => {
    const root = await tempDir();
    const spaced = join(root, "my bin");
    const pkgRoot = join(spaced, "node_modules", "@deepseek-ai", "dsh");
    const entry = realpathSync(await writeDshPackage(pkgRoot));
    await writeFile(join(spaced, "dsh.cmd"), npmCmdShim("node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"));
    expect(resolveWindowsDshLauncher("dsh", launcherEnv(spaced))).toEqual({
      command: process.execPath,
      prefixArgs: [entry],
    });
    expect(resolveWindowsDshLauncher(join(spaced, "dsh.cmd"))).toEqual({
      command: process.execPath,
      prefixArgs: [entry],
    });
  });

  it("launches direct .js/.mjs files via process.execPath and preserves native .com", async () => {
    const root = await tempDir();
    const js = join(root, "dsh.js");
    const mjs = join(root, "dsh.mjs");
    const com = join(root, "dsh.com");
    await writeFile(js, "console.log('js');\n");
    await writeFile(mjs, "console.log('mjs');\n");
    await writeFile(com, "native");
    expect(resolveWindowsDshLauncher(js)).toEqual({ command: process.execPath, prefixArgs: [js] });
    expect(resolveWindowsDshLauncher(mjs)).toEqual({ command: process.execPath, prefixArgs: [mjs] });
    expect(resolveWindowsDshLauncher(com)).toEqual({ command: com, prefixArgs: [] });
    expect(resolveWindowsDshLauncher(process.execPath)).toEqual({ command: process.execPath, prefixArgs: [] });
  });

  it("preserves dshCommandArgs after the resolved entry", async () => {
    const root = await tempDir();
    const pkgRoot = join(root, "node_modules", "@deepseek-ai", "dsh");
    const entry = realpathSync(await writeDshPackage(pkgRoot));
    await writeFile(join(root, "dsh.cmd"), npmCmdShim("node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"));
    const env = launcherEnv(root);
    const help = dshSpawnSpec({ ...loadConfig({}), dshCommand: "dsh", dshCommandArgs: ["--help"] }, env);
    const profileHelp = dshSpawnSpec({
      ...loadConfig({}),
      dshCommand: "dsh",
      dshCommandArgs: ["--profile", "acp", "--help"],
    }, env);
    if (process.platform === "win32") {
      expect(help).toEqual({ command: process.execPath, args: [entry, "--help"] });
      expect(profileHelp).toEqual({
        command: process.execPath,
        args: [entry, "--profile", "acp", "--help"],
      });
    } else {
      expect(help).toEqual({ command: "dsh", args: ["--help"] });
      expect(profileHelp).toEqual({ command: "dsh", args: ["--profile", "acp", "--help"] });
    }
  });

  it("rejects arbitrary shim content without executing it or selecting cmd.exe", async () => {
    const root = await tempDir();
    const pkgRoot = join(root, "node_modules", "@deepseek-ai", "dsh");
    await writeDshPackage(pkgRoot);
    const victim = join(root, "this-must-not-run.txt");
    await writeFile(victim, "safe\n");
    await writeFile(join(root, "dsh.cmd"), [
      "@echo off",
      `del /q "${victim}"`,
      `node "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*`,
      "",
    ].join("\r\n"));
    expectAcpFailure(
      () => resolveWindowsDshLauncher("dsh", launcherEnv(root)),
      "not a supported npm/pnpm .cmd shim",
    );
    expect(await readFile(victim, "utf8")).toBe("safe\n");
    expectAcpFailure(
      () => resolveWindowsDshLauncher(join(root, "missing.cmd")),
      "Cannot find the DSH command",
    );
    const interpolated = join(root, "env.cmd");
    await writeFile(interpolated, 'node "%USERPROFILE%\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n');
    expectAcpFailure(() => resolveWindowsDshLauncher(interpolated), "unsupported environment placeholder");
  });

  it("fails closed for unsupported .bat, malformed shim, missing entry, and mismatched package", async () => {
    const root = await tempDir();
    const bat = join(root, "dsh.bat");
    await writeFile(bat, "@echo off\r\n");
    expectAcpFailure(() => resolveWindowsDshLauncher(bat), ".bat script");
    await writeFile(join(root, "dsh.cmd"), "@echo off\r\necho not a shim\r\n");
    expectAcpFailure(
      () => resolveWindowsDshLauncher(join(root, "dsh.cmd")),
      "not a supported npm/pnpm .cmd shim",
    );

    const missingRoot = await tempDir();
    await writeFile(
      join(missingRoot, "dsh.cmd"),
      npmCmdShim("node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"),
    );
    expectAcpFailure(() => resolveWindowsDshLauncher(join(missingRoot, "dsh.cmd")), "missing entry");

    const mismatched = await tempDir();
    const otherPkg = join(mismatched, "node_modules", "@deepseek-ai", "dsh");
    await writeDshPackage(otherPkg, { name: "@other/dsh" });
    await writeFile(join(mismatched, "dsh.cmd"), npmCmdShim("node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"));
    expectAcpFailure(() => resolveWindowsDshLauncher(join(mismatched, "dsh.cmd")), "not the bin.dsh");

    const wrongBin = await tempDir();
    const wrongPkg = join(wrongBin, "node_modules", "@deepseek-ai", "dsh");
    await writeDshPackage(wrongPkg, { bin: { dsh: "lib/other.js" } });
    await writeFile(join(wrongPkg, "lib", "other.js"), "console.log('other');\n");
    await writeFile(join(wrongBin, "dsh.cmd"), npmCmdShim("node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"));
    expectAcpFailure(() => resolveWindowsDshLauncher(join(wrongBin, "dsh.cmd")), "not the bin.dsh");
  });
});
