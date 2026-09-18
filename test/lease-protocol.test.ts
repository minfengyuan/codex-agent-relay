import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Fs from "node:fs/promises";
import { SessionStore, type WorkspaceLockRecord } from "../src/store.js";
import type { ProcessTreeReference } from "../src/runner/process-tree.js";
import { cleanupDirs, tempDir } from "./helpers.js";

const faults = vi.hoisted(() => ({
  rename: undefined as undefined | ((from: string, to: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof Fs>();
  return { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => {
    await faults.rename?.(String(args[0]), String(args[1]));
    return fs.rename(...args);
  } };
});

const dirs: string[] = [];
afterEach(async () => {
  faults.rename = undefined;
  vi.restoreAllMocks();
  await cleanupDirs(dirs);
});
const failure = (code: string) => Object.assign(new Error(code), { code });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function setup(phase: WorkspaceLockRecord["phase"] = "locked") {
  const root = await tempDir(dirs);
  const cwd = await tempDir(dirs);
  const store = new SessionStore(root);
  await store.init();
  const hash = createHash("sha256").update(cwd).digest("hex");
  const path = join(store.locksDir, `${hash}.lock`);
  const record: WorkspaceLockRecord = {
    version: 1, cwd, owner: { pid: 987654, token: randomUUID(), hostname: hostname() }, phase,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const publish = async () => {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "owner.json"), JSON.stringify(record));
  };
  const retired = join(store.locksDir, `${hash}.retired.${record.owner.token}`);
  return { root, cwd, store, path, record, publish, retired };
}
function deadOwner() {
  vi.spyOn(process, "kill").mockImplementation(() => { throw failure("ESRCH"); });
}

describe("workspace lease protocol acceptance", () => {
  it("serializes repeated transitions and rejects premature release and phase rollback", async () => {
    const s = await setup(); const lease = await s.store.acquire(s.cwd);
    await expect(lease.release()).rejects.toMatchObject({ code: "LOCK_IO" });
    await Promise.all([lease.markSpawning(), lease.markSpawning(), lease.markTerminating()]);
    expect(JSON.parse(await readFile(join(s.path, "owner.json"), "utf8")).phase).toBe("terminating");
    await expect(lease.markSpawning()).rejects.toMatchObject({ code: "LOCK_IO" });
    await lease.markReaped("no-worker-created"); await lease.release();
    await expect(lease.markOrphaned()).rejects.toMatchObject({ code: "LOCK_OWNERSHIP_LOST" });
  });

  it("preserves an unverified directory if initial publication fails", async () => {
    const s = await setup();
    faults.rename = async (_from, to) => { if (to === join(s.path, "owner.json")) throw failure("EIO"); };
    await expect(s.store.acquire(s.cwd)).rejects.toMatchObject({ code: "LOCK_IO" });
    faults.rename = undefined;
    await expect(s.store.acquire(s.cwd)).rejects.toMatchObject({ code: "STALE_LOCK_UNVERIFIED" });
  });

  it("rejects malformed worker references without poisoning the lease", async () => {
    const s = await setup(); const lease = await s.store.acquire(s.cwd);
    await lease.markSpawning();
    const ref = process.platform === "win32"
      ? { kind: "windows-process-tree", pid: 0 }
      : { kind: "posix-process-group", pid: 0, pgid: 0 };
    await expect(lease.bindWorker(ref as ProcessTreeReference)).rejects.toMatchObject({ code: "LOCK_IO" });
    expect(JSON.parse(await readFile(join(s.path, "owner.json"), "utf8")).phase).toBe("spawning");
    await lease.markReaped("no-worker-created"); await lease.release();
  });

  it.each(["version", "token", "pid", "running", "cwd"])("preserves invalid %s records", async (field) => {
    const s = await setup();
    const bad = JSON.parse(JSON.stringify(s.record));
    if (field === "version") bad.version = 2;
    if (field === "token") bad.owner.token = "../not-a-token";
    if (field === "pid") bad.owner.pid = 0;
    if (field === "running") bad.phase = "running";
    if (field === "cwd") bad.cwd = s.root;
    await mkdir(s.path); const bytes = JSON.stringify(bad);
    await writeFile(join(s.path, "owner.json"), bytes); deadOwner();
    await expect(s.store.acquire(s.cwd)).rejects.toMatchObject({ code: "STALE_LOCK_UNVERIFIED" });
    expect(await readFile(join(s.path, "owner.json"), "utf8")).toBe(bytes);
  });

  it.each(["alive", "gone", "unknown"])("never migrates a legacy lock with %s owner", async (probe) => {
    const s = await setup();
    const bytes = JSON.stringify({ pid: s.record.owner.pid, cwd: s.cwd, createdAt: s.record.createdAt });
    await writeFile(s.path, bytes);
    vi.spyOn(process, "kill").mockImplementation(() => {
      if (probe === "alive") return true;
      throw failure(probe === "gone" ? "ESRCH" : "EPERM");
    });
    await expect(s.store.acquire(s.cwd)).rejects.toMatchObject({ code: probe === "alive" ? "WORKSPACE_BUSY" : "STALE_LOCK_UNVERIFIED" });
    expect(await readFile(s.path, "utf8")).toBe(bytes);
  });

  it("blocks a live owner even when reaped metadata is old", async () => {
    const s = await setup("reaped"); s.record.createdAt = "2000-01-01T00:00:00.000Z"; await s.publish();
    vi.spyOn(process, "kill").mockReturnValue(true);
    await expect(s.store.acquire(s.cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  });

  it("does not trust a worker reference from another platform", async () => {
    const s = await setup("running");
    s.record.worker = process.platform === "win32"
      ? { kind: "posix-process-group", pid: 1234, pgid: 1234 }
      : { kind: "windows-process-tree", pid: 1234 };
    await s.publish(); deadOwner();
    await expect(s.store.acquire(s.cwd)).rejects.toMatchObject({ code: "STALE_LOCK_UNVERIFIED" });
  });

  it.runIf(process.platform === "win32")("keeps a Windows tree orphaned when both recorded PIDs are gone", async () => {
    const s = await setup("running"); s.record.worker = { kind: "windows-process-tree", pid: 1234 };
    await s.publish(); deadOwner();
    await expect(s.store.acquire(s.cwd)).rejects.toMatchObject({ code: "WORKSPACE_ORPHANED" });
    expect(process.kill).toHaveBeenCalledTimes(1); // Never infer tree death from the root PID.
  });

  it.runIf(process.platform !== "win32").each(["gone", "alive", "unknown"])("recovers a POSIX tree only when the group is %s", async (group) => {
    const s = await setup("running"); s.record.worker = { kind: "posix-process-group", pid: 1234, pgid: 1234 };
    await s.publish();
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid > 0 || group === "gone") throw failure("ESRCH");
      if (group === "unknown") throw failure("EPERM");
      return true;
    });
    if (group === "gone") {
      const lease = await s.store.acquire(s.cwd); await lease.markReaped("no-worker-created"); await lease.release();
    } else await expect(s.store.acquire(s.cwd)).rejects.toMatchObject({ code: "WORKSPACE_ORPHANED" });
  });
  it.each(["locked", "reaped"] as const)("recovers a dead %s owner and preserves its tombstone", async (phase) => {
    const s = await setup(phase);
    await s.publish(); deadOwner();
    const lease = await s.store.acquire(s.cwd);
    expect(JSON.parse(await readFile(join(s.retired, "owner.json"), "utf8"))).toEqual(s.record);
    expect(JSON.parse(await readFile(join(s.path, "owner.json"), "utf8")).owner.token).not.toBe(s.record.owner.token);
    await lease.markReaped("no-worker-created"); await lease.release();
  });

  it.each(["spawning", "terminating", "orphaned"] as const)("retains dead %s without a worker reference", async (phase) => {
    const s = await setup(phase); await s.publish(); deadOwner();
    await expect(s.store.acquire(s.cwd)).rejects.toMatchObject({ code: "WORKSPACE_ORPHANED" });
    expect(JSON.parse(await readFile(join(s.path, "owner.json"), "utf8"))).toEqual(s.record);
  });

  it.each(["EPERM", "EACCES", "EIO"])("does not recover an unknown owner (%s)", async (code) => {
    const s = await setup("reaped"); await s.publish();
    vi.spyOn(process, "kill").mockImplementation(() => { throw failure(code); });
    await expect(s.store.acquire(s.cwd)).rejects.toMatchObject({ code: "STALE_LOCK_UNVERIFIED" });
  });

  it("rejects a foreign host without probing its PID", async () => {
    const s = await setup("reaped"); s.record.owner.hostname += "-foreign"; await s.publish();
    const probe = vi.spyOn(process, "kill");
    await expect(s.store.acquire(s.cwd)).rejects.toMatchObject({ code: "STALE_LOCK_UNVERIFIED" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not move a new generation when an old reclaimer resumes", async () => {
    const s = await setup("reaped"); await s.publish(); deadOwner();
    const entered = gate(), resume = gate();
    let paused = false;
    faults.rename = async (from, to) => {
      if (from === s.path && to === s.retired && !paused) {
        paused = true; entered.resolve(); await resume.promise;
      }
    };
    const delayed = s.store.acquire(s.cwd);
    const outcome = delayed.then(() => "unexpected success", (e: unknown) => e);
    await entered.promise;
    const winner = await new SessionStore(s.root).acquire(s.cwd);
    // The newly published owner is live. Only the old synthetic PID is gone.
    vi.mocked(process.kill).mockImplementation((pid) => {
      if (pid === process.pid) return true;
      throw failure("ESRCH");
    });
    const before = await readFile(join(s.path, "owner.json"), "utf8");
    resume.resolve();
    expect(await outcome).toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(await readFile(join(s.path, "owner.json"), "utf8")).toBe(before);
    await winner.markReaped("no-worker-created"); await winner.release();
  });

  it("uses real nonempty tombstones to block delayed rename after normal release", async () => {
    const s = await setup();
    const first = await s.store.acquire(s.cwd);
    const old = JSON.parse(await readFile(join(s.path, "owner.json"), "utf8")) as WorkspaceLockRecord;
    const retired = s.path.replace(/\.lock$/, `.retired.${old.owner.token}`);
    await first.markReaped("no-worker-created"); await first.release();
    const next = await s.store.acquire(s.cwd);
    const bytes = await readFile(join(s.path, "owner.json"), "utf8");
    await expect(rename(s.path, retired)).rejects.toBeDefined();
    await first.release();
    expect(await readFile(join(s.path, "owner.json"), "utf8")).toBe(bytes);
    expect(JSON.parse(await readFile(join(retired, "owner.json"), "utf8")).owner.token).toBe(old.owner.token);
    await next.markReaped("no-worker-created"); await next.release();
  });

  it("allows retry after a genuine retirement I/O failure", async () => {
    const s = await setup(); const lease = await s.store.acquire(s.cwd);
    await lease.markReaped("no-worker-created");
    faults.rename = async (from) => { if (from === s.path) throw failure("EIO"); };
    await expect(lease.release()).rejects.toMatchObject({ code: "LOCK_IO" });
    faults.rename = undefined;
    await lease.release(); await lease.release();
  });

  it("does not overwrite a replacement owner during lease updates", async () => {
    const s = await setup(); const lease = await s.store.acquire(s.cwd);
    const replacement = { ...s.record, owner: { ...s.record.owner, token: randomUUID() } };
    const bytes = JSON.stringify(replacement);
    await writeFile(join(s.path, "owner.json"), bytes);
    await expect(lease.markSpawning()).rejects.toMatchObject({ code: "LOCK_OWNERSHIP_LOST" });
    await expect(lease.release()).rejects.toMatchObject({ code: "LOCK_OWNERSHIP_LOST" });
    expect(await readFile(join(s.path, "owner.json"), "utf8")).toBe(bytes);
  });

  it("retains the last published state after an atomic update failure", async () => {
    const s = await setup(); const lease = await s.store.acquire(s.cwd);
    faults.rename = async (_from, to) => { if (to === join(s.path, "owner.json")) throw failure("EIO"); };
    await expect(lease.markSpawning()).rejects.toMatchObject({ code: "LOCK_IO" });
    expect(JSON.parse(await readFile(join(s.path, "owner.json"), "utf8")).phase).toBe("locked");
    faults.rename = undefined;
    await lease.markReaped("no-worker-created"); await lease.release();
  });
});
