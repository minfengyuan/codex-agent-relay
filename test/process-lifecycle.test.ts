import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../src/store.js";
import { cleanupDirs, tempDir } from "./helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [], logs: string[] = [];
const children: ChildProcess[] = [];
vi.setConfig({ testTimeout: 20_000 });
beforeAll(() => {
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], { cwd: root });
}, 20_000);
type FixtureEvent = { event: string; pid?: number; cwd?: string; code?: string; same?: boolean };
async function events(log: string): Promise<FixtureEvent[]> {
  try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function until(check: () => Promise<boolean>, reason: string, timeout = 6000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(reason);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}
async function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { child.off("exit", done); reject(new Error("CLI did not exit")); }, 10_000);
    child.once("exit", done);
  });
}
afterEach(async () => {
  // Independently reap every recorded process, even when the assertions fail.
  const pids = new Set<number>();
  for (const log of logs.splice(0)) for (const event of await events(log)) if (event.pid) pids.add(event.pid);
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = waitExit(child); child.kill("SIGKILL"); await exited;
  }
  for (const pid of [...pids].reverse()) {
    if (gone(pid)) continue;
    process.kill(pid, "SIGKILL");
    await until(async () => gone(pid), `Fixture ${pid} survived independent teardown`);
  }
  await cleanupDirs(dirs);
});

async function start(mode = "normal", actualEntry = false) {
  const state = await tempDir(dirs), cwd = await tempDir(dirs), log = join(state, "processes.jsonl");
  logs.push(log);
  const child = spawn(process.execPath, actualEntry ? [join(root, "dist/cli.js")]
    : [join(root, "test/fixtures/cli-runtime-holder.mjs"), state, log, mode], {
    cwd, shell: false, windowsHide: true,
    env: { ...process.env, CODEX_AGENT_RELAY_STATE_DIR: state, CODEX_AGENT_RELAY_DELEGATED: "" },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  let stderr = "", pending = "";
  const messages: Array<Record<string, unknown>> = [], ipc: FixtureEvent[] = [], invalid: string[] = [];
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  child.stdout?.on("data", (chunk) => {
    pending += String(chunk); const lines = pending.split("\n"); pending = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) { try { messages.push(JSON.parse(line)); } catch { invalid.push(line); } }
  });
  child.on("message", (message: FixtureEvent) => { ipc.push(message); });
  child.stdin?.on("error", () => {});
  const send = (message: unknown) => child.stdin?.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
  } });
  await until(async () => messages.some((item) => item.id === 1), "CLI initialization failed");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { state, cwd, log, child, ipc, invalid, stderr: () => stderr,
    call: (id: number, path: string) => send({ jsonrpc: "2.0", id, method: "tools/call", params: {
      name: "grok_delegate", arguments: { task: "hang", cwd: path },
    } }),
  };
}
async function assertRetired(state: string, cwd: string) {
  expect((await readdir(join(state, "locks"))).filter((entry) => entry.endsWith(".lock"))).toEqual([]);
  const lease = await new SessionStore(state).acquire(cwd);
  await lease.markReaped("no-worker-created"); await lease.release();
}

describe("CLI cross-process shutdown", () => {
  it("wires the actual CLI entry to an idle EOF shutdown", async () => {
    const h = await start("normal", true); h.child.stdin?.end(); await waitExit(h.child);
    expect(h.child.exitCode).toBe(0); expect(h.stderr()).toContain("EOF"); expect(h.invalid).toEqual([]);
  });
  it("cleans simultaneous EOF tasks and writing descendants before retiring leases", async () => {
    const h = await start("writer"), other = await tempDir(dirs);
    h.call(2, h.cwd); h.call(3, other);
    await until(async () => (await events(h.log)).filter((item) => item.event === "prompt").length === 2, "workers not ready");
    await expect(new SessionStore(h.state).acquire(h.cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    h.child.stdin?.end(); await waitExit(h.child);
    expect(h.child.exitCode, h.stderr()).toBe(0);
    const recorded = await events(h.log);
    for (const event of recorded) if (event.pid) expect(gone(event.pid)).toBe(true);
    expect(recorded.filter((item) => item.event === "cancel")).toHaveLength(2);
    const before = await Promise.all([h.cwd, other].map((cwd) => stat(join(cwd, "writes.txt")).then((s) => s.size)));
    await assertRetired(h.state, h.cwd); await assertRetired(h.state, other);
    const after = await Promise.all([h.cwd, other].map((cwd) => stat(join(cwd, "writes.txt")).then((s) => s.size)));
    expect(after).toEqual(before); expect(h.invalid).toEqual([]);
  });
  it("still cleans a real worker when transport close throws", async () => {
    const h = await start("close-failure"); h.call(2, h.cwd);
    await until(async () => (await events(h.log)).some((item) => item.event === "prompt"), "worker not ready");
    h.child.stdin?.end(); await waitExit(h.child);
    expect(h.child.exitCode).toBe(1); expect(h.stderr()).toContain("injected close failure");
    for (const event of await events(h.log)) if (event.pid) expect(gone(event.pid)).toBe(true);
    await assertRetired(h.state, h.cwd);
  });
  it("rejects post-gate work and shares repeated IPC shutdown requests", async () => {
    const h = await start("gate"); h.call(2, h.cwd);
    await until(async () => (await events(h.log)).some((item) => item.event === "prompt"), "worker not ready");
    h.child.send({ action: "shutdown", cwd: h.cwd });
    await until(async () => h.ipc.some((item) => item.event === "gate-result"), "gate probe not returned");
    expect(h.ipc.find((item) => item.event === "gate-result")).toMatchObject({ code: "CANCELLED", same: true });
    h.child.send({ action: "finish" }); await waitExit(h.child);
    expect(h.child.exitCode, h.stderr()).toBe(0);
    expect((await events(h.log)).filter((item) => item.event === "worker")).toHaveLength(1);
    await assertRetired(h.state, h.cwd);
  });
  it("exits 1 and preserves an orphan lease while its descendant still writes", async () => {
    const h = await start("unconfirmed"); h.call(2, h.cwd);
    await until(async () => (await events(h.log)).some((item) => item.event === "prompt"), "writer not ready");
    h.child.send({ action: "shutdown", cwd: h.cwd }); await waitExit(h.child);
    expect(h.child.exitCode).toBe(1); expect(h.stderr()).toContain("PROCESS_CLEANUP_FAILED");
    await expect(new SessionStore(h.state).acquire(h.cwd)).rejects.toMatchObject({ code: "WORKSPACE_ORPHANED" });
    const output = join(h.cwd, "writes.txt"), before = (await stat(output)).size;
    await until(async () => (await stat(output)).size > before, "orphan writer unexpectedly stopped");
  });
  it.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("cleans real workers on %s", async (signal) => {
    const h = await start(); h.call(2, h.cwd);
    await until(async () => (await events(h.log)).some((item) => item.event === "prompt"), "worker not ready");
    h.child.kill(signal); await waitExit(h.child);
    expect(h.child.exitCode, h.stderr()).toBe(0); await assertRetired(h.state, h.cwd);
  });
});
