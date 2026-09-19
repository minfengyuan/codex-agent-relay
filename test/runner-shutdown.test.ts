import { readFile } from "node:fs/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginRunnerShutdown, cleanupAllChildren, GrokRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";
import { baseConfig, cleanupDirs, clearDelegatedEnv, tempDir, waitForLog } from "./helpers.js";
import type * as ProcessTree from "../src/runner/process-tree.js";

const captured = vi.hoisted(() => ({ children: [] as ChildProcessWithoutNullStreams[] }));
vi.mock("../src/runner/process-tree.js", async (load) => {
  const actual = await load<typeof ProcessTree>();
  return { ...actual, createProcessTreeController: (...args: Parameters<typeof actual.createProcessTreeController>) => {
    captured.children.push(args[0]); return actual.createProcessTreeController(...args);
  } };
});

const dirs: string[] = [];

beforeEach(() => {
  clearDelegatedEnv();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  try {
    await cleanupAllChildren();
  } catch {
    // The assertion owns shutdown failures; teardown must still clean paths.
  } finally {
    for (const child of captured.children.splice(0)) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { child.off("exit", done); reject(new Error("Fixture survived independent cleanup")); }, 3000);
        child.once("exit", done); child.kill("SIGKILL");
      });
    }
    await cleanupDirs(dirs);
  }
});

describe("runner shutdown gate", () => {
  it("cancels an active task, shares one shutdown result, and rejects later work before it acquires a lease", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("FAKE_ACP_MODE", "hang");
    const stateDir = await tempDir(dirs);
    const activeCwd = await tempDir(dirs);
    const laterCwd = await tempDir(dirs);
    const log = join(stateDir, "shutdown.log");
    vi.stubEnv("FAKE_ACP_LOG", log);

    const active = new GrokRunner(baseConfig(stateDir), new SessionStore(stateDir))
      .delegate({ task: "hang", cwd: activeCwd });
    // Attach immediately: global shutdown intentionally waits for this rejection.
    const activeRejected = expect(active).rejects.toMatchObject({ code: "CANCELLED" });
    await waitForLog(log, "prompt:fake-session-1");

    const first = beginRunnerShutdown();
    const second = beginRunnerShutdown();
    expect(second).toBe(first);
    await activeRejected;
    await expect(first).resolves.toBeUndefined();

    await expect(new GrokRunner(baseConfig(stateDir), new SessionStore(stateDir))
      .delegate({ task: "must not spawn", cwd: laterCwd }))
      .rejects.toMatchObject({ code: "CANCELLED", message: expect.stringMatching(/shutting down/i) });
    expect((await readFile(log, "utf8")).match(/prompt:fake-session-1/g)).toHaveLength(1);
  }, 15_000);
});
