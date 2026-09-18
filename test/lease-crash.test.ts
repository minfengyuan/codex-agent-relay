import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../src/store.js";
import { cleanupDirs, tempDir } from "./helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
const children: ChildProcess[] = [];
const workers: number[] = [];
type Event = { event: string; pid?: number; code?: string };
vi.setConfig({ testTimeout: 15_000 });
beforeAll(() => {
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], { cwd: root });
}, 20_000);

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture did not exit")), 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGKILL");
  });
}
afterEach(async () => {
  for (const child of children.splice(0)) await stop(child);
  for (const pid of workers.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
    const deadline = Date.now() + 3000;
    while (true) {
      try { process.kill(pid, 0); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") break;
        throw e;
      }
      if (Date.now() >= deadline) throw new Error(`Orphan fixture ${pid} survived cleanup`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  await cleanupDirs(dirs);
});
function holder(state: string, cwd: string, mode: string) {
  const child = spawn(process.execPath, [join(root, "test/fixtures/lease-crash-holder.mjs"),
    pathToFileURL(join(root, "dist/store.js")).href, state, cwd, mode], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  const events: Event[] = [];
  const waiters = new Set<() => void>();
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  child.on("message", (message: Event) => {
    events.push(message);
    if (message.event === "worker" && message.pid) workers.push(message.pid);
    for (const wake of waiters) wake();
  });
  const wait = (event: string): Promise<Event> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`No ${event}: ${stderr} ${JSON.stringify(events)}`)); }, 5000);
    const check = () => {
      const value = events.find((item) => item.event === event);
      if (value) { clearTimeout(timer); waiters.delete(check); resolve(value); }
    };
    waiters.add(check); check();
  });
  return { child, wait };
}
async function setup() {
  const state = await tempDir(dirs), cwd = await tempDir(dirs);
  const store = new SessionStore(state);
  const lock = join(state, "locks", `${createHash("sha256").update(cwd).digest("hex")}.lock`);
  return { state, cwd, store, lock };
}

describe("real lease crash windows and IPC competition", () => {
  it.each([
    ["mkdir", "STALE_LOCK_UNVERIFIED"], ["locked", null], ["spawning", "WORKSPACE_ORPHANED"],
    ["spawned", "WORKSPACE_ORPHANED"], ["running", "WORKSPACE_ORPHANED"], ["reaped", null],
  ] as const)("restarts after an owner crash at %s", async (mode, code) => {
    const s = await setup(); const h = holder(s.state, s.cwd, mode);
    await h.wait("ready"); await stop(h.child);
    if (code) {
      await expect(s.store.acquire(s.cwd)).rejects.toMatchObject({ code });
      expect((await stat(s.lock)).isDirectory()).toBe(true);
    } else {
      const lease = await s.store.acquire(s.cwd);
      await lease.markReaped("no-worker-created"); await lease.release();
      expect((await readdir(s.store.locksDir)).filter((file) => file.includes(".retired.")).length).toBe(2);
    }
    if (mode === "spawned" || mode === "running") {
      const writer = join(s.cwd, "orphan-writes.txt");
      const before = (await stat(writer)).size;
      // Observe actual writes after the owner died; acquisition above must stay blocked.
      const deadline = Date.now() + 2000;
      while ((await stat(writer)).size === before && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect((await stat(writer)).size).toBeGreaterThan(before);
    }
  });

  it("admits exactly one IPC-synchronized contender for a cwd", async () => {
    const s = await setup(); const one = holder(s.state, s.cwd, "race"), two = holder(s.state, s.cwd, "race");
    await Promise.all([one.wait("waiting"), two.wait("waiting")]);
    one.child.send("go"); two.child.send("go");
    const first = await Promise.race([one.wait("ready").then(() => one), two.wait("ready").then(() => two)]);
    const loser = first === one ? two : one;
    const result = await loser.wait("failure");
    expect(["WORKSPACE_BUSY", "STALE_LOCK_UNVERIFIED"]).toContain(result.code);
    await expect(s.store.acquire(s.cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  });

  it("keeps different workspaces independent across processes", async () => {
    const s = await setup(); const other = await tempDir(dirs);
    const one = holder(s.state, s.cwd, "locked"), two = holder(s.state, other, "locked");
    await Promise.all([one.wait("ready"), two.wait("ready")]);
  });

  it("protects the new owner from an IPC-paused stale reclaimer", async () => {
    const s = await setup(); const old = holder(s.state, s.cwd, "reaped");
    await old.wait("ready"); await stop(old.child);
    const delayed = holder(s.state, s.cwd, "paused-reclaim"); await delayed.wait("paused");
    const winner = await s.store.acquire(s.cwd);
    const bytes = await readFile(join(s.lock, "owner.json"), "utf8");
    delayed.child.send("resume");
    expect(await delayed.wait("failure")).toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(await readFile(join(s.lock, "owner.json"), "utf8")).toBe(bytes);
    await winner.markReaped("no-worker-created"); await winner.release();
  });
});
