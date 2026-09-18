import { createHash } from "node:crypto";
import { chmod, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore, resolveCwd } from "../src/store.js";
import { RelayFailure } from "../src/types.js";
import { cleanupDirs, tempDir as makeTempDir } from "./helpers.js";

const dirs: string[] = [];
const tempDir = () => makeTempDir(dirs);
afterEach(async () => cleanupDirs(dirs));

describe("SessionStore", () => {
  it("writes private hashed records and validates cwd binding", async () => {
    const root = await tempDir();
    const cwd = await tempDir();
    const store = new SessionStore(root);
    await store.writeNew("secret/session", cwd);
    const files = await import("node:fs/promises").then((fs) => fs.readdir(join(root, "sessions")));
    expect(files).toEqual([`${createHash("sha256").update("secret/session").digest("hex")}.json`]);
    expect(await store.read("secret/session", cwd)).toMatchObject({ version: 1, sessionId: "secret/session", cwd });
    await expect(store.read("secret/session", root)).rejects.toMatchObject({ code: "CWD_MISMATCH" });
    await expect(store.read("missing", cwd)).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
  });

  it("rejects corrupt records", async () => {
    const root = await tempDir();
    const cwd = await tempDir();
    const store = new SessionStore(root);
    await store.init();
    const hash = createHash("sha256").update("bad").digest("hex");
    await writeFile(join(root, "sessions", `${hash}.json`), "not json");
    await expect(store.read("bad", cwd)).rejects.toMatchObject({ code: "CORRUPT_SESSION" });
  });

  it("never replaces an existing session binding", async () => {
    const root = await tempDir();
    const a = await tempDir();
    const b = await tempDir();
    const store = new SessionStore(root);
    await store.writeNew("duplicate", a);
    await expect(store.writeNew("duplicate", b)).rejects.toMatchObject({ code: "STATE_CONFLICT" });
    expect(await store.read("duplicate", a)).toMatchObject({ cwd: a });
  });

  it("publishes only one binding when duplicate session IDs race", async () => {
    const root = await tempDir();
    const a = await tempDir();
    const b = await tempDir();
    const store = new SessionStore(root);
    const results = await Promise.allSettled([
      store.writeNew("raced", a),
      store.writeNew("raced", b),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "STATE_CONFLICT" } });
    const winner = results[0]?.status === "fulfilled" ? a : b;
    expect(await store.read("raced", winner)).toMatchObject({ cwd: winner });
  });

  it("repairs permissions on existing state subdirectories", async () => {
    const root = await tempDir();
    const store = new SessionStore(root);
    await store.init();
    await chmod(store.sessionsDir, 0o755);
    await chmod(store.locksDir, 0o755);
    await store.init();
    const sessions = await stat(store.sessionsDir);
    const locks = await stat(store.locksDir);
    expect(sessions.isDirectory()).toBe(true);
    expect(locks.isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(sessions.mode & 0o777).toBe(0o700);
      expect(locks.mode & 0o777).toBe(0o700);
    }
  });

  it("locks the same real cwd across store instances and permits different cwd", async () => {
    const root = await tempDir();
    const a = await tempDir();
    const b = await tempDir();
    const one = new SessionStore(root);
    const two = new SessionStore(root);
    const releaseA = await one.acquire(a);
    await expect(two.acquire(a)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    const releaseB = await two.acquire(b);
    await releaseB.markReaped("no-worker-created");
    await releaseB.release();
    await releaseA.markReaped("no-worker-created");
    await releaseA.release();
    await expect(two.acquire(a)).resolves.toMatchObject({ release: expect.any(Function) });
  });
});

describe("resolveCwd", () => {
  it("requires an existing absolute directory", async () => {
    const cwd = await tempDir();
    expect(await resolveCwd(cwd)).toBe(await import("node:fs/promises").then((fs) => fs.realpath(cwd)));
    const file = join(cwd, "file");
    await writeFile(file, "x");
    await expect(resolveCwd(file)).rejects.toBeInstanceOf(RelayFailure);
    await expect(resolveCwd("relative")).rejects.toMatchObject({ code: "INVALID_CWD" });
  });
});
