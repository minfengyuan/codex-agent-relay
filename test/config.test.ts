import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

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
    expect(defaults.killConfirmMs).toBe(2_000);
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

    expect(loadConfig({ CODEX_AGENT_RELAY_KILL_CONFIRM_MS: "17" }).killConfirmMs).toBe(17);
    expect(loadConfig({ CODEX_AGENT_RELAY_KILL_CONFIRM_MS: "0" }).killConfirmMs).toBe(2_000);

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
