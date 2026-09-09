import { homedir } from "node:os";
import { join } from "node:path";

export type RelayConfig = {
  command: string;
  commandArgs: string[];
  cursorCommand?: string;
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
    command: env.GROK_RELAY_GROK_COMMAND ?? "grok",
    commandArgs: ["--no-auto-update", "--sandbox", "workspace", "agent", "--always-approve", "--no-leader", "stdio"],
    ...(env.GROK_RELAY_CURSOR_COMMAND?.trim() ? { cursorCommand: env.GROK_RELAY_CURSOR_COMMAND.trim() } : {}),
    stateDir: env.GROK_RELAY_STATE_DIR ?? join(homedir(), ".local", "state", "codex-grok-relay"),
    phaseTimeoutMs: positiveInt(env.GROK_RELAY_PHASE_TIMEOUT_MS, 30_000),
    totalTimeoutMs: positiveInt(env.GROK_RELAY_TOTAL_TIMEOUT_MS, 3_600_000),
    cancelGraceMs: positiveInt(env.GROK_RELAY_CANCEL_GRACE_MS, 5_000),
    termGraceMs: positiveInt(env.GROK_RELAY_TERM_GRACE_MS, 2_000),
    textLimitBytes: positiveInt(env.GROK_RELAY_TEXT_LIMIT_BYTES, 256 * 1024),
    stderrLimitBytes: positiveInt(env.GROK_RELAY_STDERR_LIMIT_BYTES, 64 * 1024),
    progressIntervalMs: positiveInt(env.GROK_RELAY_PROGRESS_INTERVAL_MS, 1_000),
  };
}
