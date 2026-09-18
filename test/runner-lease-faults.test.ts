import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ProcessTree from "../src/runner/process-tree.js";
import { SessionStore, type WorkspaceLease } from "../src/store.js";
import { RelayFailure } from "../src/types.js";
import { GrokRunner, cleanupAllChildren } from "../src/runner.js";
import { baseConfig, cleanupDirs, tempDir } from "./helpers.js";

const state = vi.hoisted(() => ({
  children: [] as ChildProcessWithoutNullStreams[],
  reports: [] as boolean[],
  unconfirmed: false,
}));
vi.mock("../src/runner/process-tree.js", async (original) => {
  const actual = await original<typeof ProcessTree>();
  return { ...actual, createProcessTreeController: (...args: Parameters<typeof actual.createProcessTreeController>) => {
    state.children.push(args[0]);
    const real = actual.createProcessTreeController(...args);
    let pending: Promise<ProcessTree.TerminationReport> | undefined;
    return { reference: real.reference, terminate: () => pending ??= (async () => {
      const result = await real.terminate(); state.reports.push(result.confirmed);
      return state.unconfirmed ? { ...result, confirmed: false, reason: "injected uncertainty" } : result;
    })() };
  } };
});
const dirs: string[] = [];
vi.setConfig({ testTimeout: 15_000 });
afterEach(async () => {
  await cleanupAllChildren();
  for (const child of state.children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture survived independent cleanup")), 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGKILL");
    });
  }
  const reports = state.reports.splice(0);
  state.unconfirmed = false;
  vi.unstubAllEnvs();
  await cleanupDirs(dirs);
  expect(reports.every(Boolean)).toBe(true);
});

class FaultStore extends SessionStore {
  calls: string[] = [];
  constructor(root: string, readonly fail: keyof WorkspaceLease, readonly onFailure?: () => void) { super(root); }
  override async acquire(cwd: string): Promise<WorkspaceLease> {
    const real = await super.acquire(cwd);
    return new Proxy(real, { get: (target, key: keyof WorkspaceLease) => {
      const method = target[key];
      if (typeof method !== "function") return method;
      return async (...args: never[]) => {
        this.calls.push(key);
        if (key === this.fail) {
          this.onFailure?.(); throw new RelayFailure("LOCK_IO", `injected ${key} failure`);
        }
        return (method as (...values: never[]) => Promise<void>)(...args);
      };
    } });
  }
}
async function setup(fail: keyof WorkspaceLease, onFailure?: () => void) {
  vi.stubEnv("XAI_API_KEY", "");
  const root = await tempDir(dirs), cwd = await tempDir(dirs);
  const store = new FaultStore(root, fail, onFailure);
  const runner = new GrokRunner(baseConfig(root), store);
  const owner = join(root, "locks", `${createHash("sha256").update(cwd).digest("hex")}.lock`, "owner.json");
  return { root, cwd, store, runner, owner };
}

describe("runner lease persistence faults", () => {
  it("does not spawn when markSpawning fails, even if cancellation arrives simultaneously", async () => {
    const abort = new AbortController();
    const s = await setup("markSpawning", () => abort.abort());
    await expect(s.runner.delegate({ task: "never spawn", cwd: s.cwd }, abort.signal))
      .rejects.toMatchObject({ code: "LOCK_IO", message: expect.stringContaining("markSpawning") });
    expect(state.children).toHaveLength(0);
    expect(s.store.calls).toContain("release");
  });

  it.each(["bindWorker", "markTerminating", "markReaped"] as const)("cleans the real worker despite %s failure", async (method) => {
    const s = await setup(method);
    await expect(s.runner.delegate({ task: "test", cwd: s.cwd }))
      .rejects.toMatchObject({ code: "LOCK_IO", message: expect.stringContaining(method) });
    expect(state.reports).toEqual([true]);
    expect(state.children).toHaveLength(1);
    if (method === "markReaped") {
      expect(s.store.calls).not.toContain("release");
      expect(JSON.parse(await readFile(s.owner, "utf8")).phase).toBe("terminating");
    } else expect(s.store.calls).toContain("release");
  });

  it("retains the prior lock and partial result if writing orphaned also fails", async () => {
    const s = await setup("markOrphaned"); state.unconfirmed = true;
    await expect(s.runner.delegate({ task: "test", cwd: s.cwd })).rejects.toMatchObject({
      code: "PROCESS_CLEANUP_FAILED", message: expect.stringContaining("markOrphaned"),
      partial: { text: "fresh answer", sessionId: "fake-session-1" },
    });
    expect(state.reports).toEqual([true]);
    expect(s.store.calls).not.toContain("release");
    expect(JSON.parse(await readFile(s.owner, "utf8")).phase).toBe("terminating");
    await expect(new SessionStore(s.root).acquire(s.cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  });
});
