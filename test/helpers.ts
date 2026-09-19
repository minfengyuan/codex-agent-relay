import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, vi } from "vitest";
import type { RelayConfig } from "../src/config.js";
import { cleanupAllChildren } from "../src/runner.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const grokFixture = join(fixtures, "fake-agent.mjs");
export const cursorFixture = grokFixture;
export const opencodeFixture = join(fixtures, "fake-opencode-agent.mjs");
export const dshFixture = join(fixtures, "fake-dsh-agent.mjs");
export const backpressureFixture = join(fixtures, "backpressure-agent.mjs");

export async function tempDir(dirs: string[], prefix = "relay-"): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(path);
  return path;
}

export async function cleanupDirs(dirs: string[]): Promise<void> {
  await Promise.all(dirs.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  })));
}

export function baseConfig(stateDir: string, overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    command: process.execPath,
    commandArgs: [grokFixture],
    cursorCommand: process.execPath,
    cursorCommandArgs: [cursorFixture],
    opencodeCommand: process.execPath,
    opencodeCommandArgs: [opencodeFixture],
    dshCommand: process.execPath,
    dshCommandArgs: [dshFixture],
    stateDir,
    phaseTimeoutMs: 2_000,
    totalTimeoutMs: 15_000,
    cancelGraceMs: 100,
    termGraceMs: 100,
    killConfirmMs: 5_000,
    textLimitBytes: 256 * 1024,
    stderrLimitBytes: 64 * 1024,
    progressIntervalMs: 1,
    ...overrides,
  };
}

export async function waitForLog(path: string, needle: string, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, "utf8")).includes(needle)) return;
    } catch { /* wait */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(needle)} in ${path}`);
}

export function clearDelegatedEnv(): void {
  if (process.env.CODEX_AGENT_RELAY_DELEGATED === "1") {
    vi.stubEnv("CODEX_AGENT_RELAY_DELEGATED", "");
  }
}

export function useRunnerCleanup(dirs: string[]): void {
  beforeEach(() => {
    clearDelegatedEnv();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    try {
      await cleanupAllChildren();
    } finally {
      await cleanupDirs(dirs);
    }
  });
}
