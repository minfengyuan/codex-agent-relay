import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/store.js";
import type { ProcessTreeReference } from "../src/runner/process-tree.js";
import { tempDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const digest = (cwd: string) => createHash("sha256").update(cwd).digest("hex");
const worker: ProcessTreeReference = process.platform === "win32"
  ? { kind: "windows-process-tree", pid: process.pid }
  : { kind: "posix-process-group", pid: process.pid, pgid: process.pid };

describe("workspace leases", () => {
  it("serializes phase transitions and retires only a reaped lease", async () => {
    const state = await tempDir(dirs);
    const cwd = await tempDir(dirs);
    const store = new SessionStore(state);
    const lease = await store.acquire(cwd);
    await lease.markSpawning();
    await lease.bindWorker(worker);
    await lease.markTerminating();
    await lease.markReaped("tree-exit-confirmed");
    await lease.release();
    await lease.release();
    const locks = await import("node:fs/promises").then((fs) => fs.readdir(join(state, "locks")));
    expect(locks).toContainEqual(expect.stringMatching(new RegExp(`^${digest(cwd)}\\.retired\\.[0-9a-f-]+$`)));
    await expect(store.acquire(cwd)).resolves.toBeDefined();
  });

  it("keeps an active owner busy across stores", async () => {
    const state = await tempDir(dirs);
    const cwd = await tempDir(dirs);
    const first = new SessionStore(state);
    const second = new SessionStore(state);
    const lease = await first.acquire(cwd);
    await expect(second.acquire(cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    await lease.markReaped("no-worker-created");
    await lease.release();
  });

  it("fails closed on malformed owner records", async () => {
    const state = await tempDir(dirs);
    const cwd = await tempDir(dirs);
    const ownerDir = join(state, "locks", `${digest(cwd)}.lock`);
    await mkdir(ownerDir, { recursive: true });
    await writeFile(join(ownerDir, "owner.json"), JSON.stringify({ version: 1, cwd, owner: { pid: 1, token: randomUUID() } }));
    await expect(new SessionStore(state).acquire(cwd)).rejects.toMatchObject({ code: "STALE_LOCK_UNVERIFIED" });
    expect(JSON.parse(await readFile(join(ownerDir, "owner.json"), "utf8"))).toMatchObject({ cwd });
  });

  it("fails closed without replacing an oversized owner record", async () => {
    const state = await tempDir(dirs);
    const cwd = await tempDir(dirs);
    const ownerDir = join(state, "locks", `${digest(cwd)}.lock`);
    await mkdir(ownerDir, { recursive: true });
    await writeFile(join(ownerDir, "owner.json"), "x".repeat(16 * 1024 + 1));
    await expect(new SessionStore(state).acquire(cwd)).rejects.toMatchObject({ code: "STALE_LOCK_UNVERIFIED" });
    expect((await readFile(join(ownerDir, "owner.json"), "utf8")).length).toBe(16 * 1024 + 1);
  });

  it.skipIf(process.platform === "win32")("fails closed on a symlinked owner record", async () => {
    const state = await tempDir(dirs);
    const cwd = await tempDir(dirs);
    const ownerDir = join(state, "locks", `${digest(cwd)}.lock`);
    const target = join(state, "outside.json");
    await mkdir(ownerDir, { recursive: true });
    await writeFile(target, "{}");
    await symlink(target, join(ownerDir, "owner.json"));
    await expect(new SessionStore(state).acquire(cwd)).rejects.toMatchObject({ code: "STALE_LOCK_UNVERIFIED" });
    expect(await readFile(target, "utf8")).toBe("{}");
  });
});
