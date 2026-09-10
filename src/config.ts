import { homedir } from "node:os";
import { join } from "node:path";

export type RelayConfig = {
  command: string;
  commandArgs: string[];
  cursorCommand?: string;
  cursorCommandArgs?: string[];
  opencodeCommand?: string;
  opencodeCommandArgs?: string[];
  stateDir: string;
  phaseTimeoutMs: number;
  totalTimeoutMs: number;
  cancelGraceMs: number;
  termGraceMs: number;
  textLimitBytes: number;
  stderrLimitBytes: number;
  progressIntervalMs: number;
};

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  return {
    command: env.CODEX_AGENT_RELAY_GROK_COMMAND ?? "grok",
    commandArgs: ["--no-auto-update", "--sandbox", "workspace", "agent", "--always-approve", "--no-leader", "stdio"],
    ...(env.CODEX_AGENT_RELAY_CURSOR_COMMAND?.trim() ? { cursorCommand: env.CODEX_AGENT_RELAY_CURSOR_COMMAND.trim() } : {}),
    opencodeCommand: env.CODEX_AGENT_RELAY_OPENCODE_COMMAND?.trim() || "opencode",
    stateDir: env.CODEX_AGENT_RELAY_STATE_DIR ?? join(homedir(), ".local", "codex-agent-relay"),
    phaseTimeoutMs: positiveInt(env.CODEX_AGENT_RELAY_PHASE_TIMEOUT_MS, 30_000),
    totalTimeoutMs: positiveInt(env.CODEX_AGENT_RELAY_TOTAL_TIMEOUT_MS, 3_600_000),
    cancelGraceMs: positiveInt(env.CODEX_AGENT_RELAY_CANCEL_GRACE_MS, 5_000),
    termGraceMs: positiveInt(env.CODEX_AGENT_RELAY_TERM_GRACE_MS, 2_000),
    textLimitBytes: positiveInt(env.CODEX_AGENT_RELAY_TEXT_LIMIT_BYTES, 256 * 1024),
    stderrLimitBytes: positiveInt(env.CODEX_AGENT_RELAY_STDERR_LIMIT_BYTES, 64 * 1024),
    progressIntervalMs: positiveInt(env.CODEX_AGENT_RELAY_PROGRESS_INTERVAL_MS, 1_000),
  };
}
