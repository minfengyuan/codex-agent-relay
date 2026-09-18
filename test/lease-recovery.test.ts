import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SessionStore } from "../src/store.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const holder = join(root, "test", "fixtures", "lease-holder.mjs");
const dirs: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

beforeAll(() => {
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], { cwd: root });
}, 20_000);
afterEach(async () => {
  await Promise.all([...children].map((child) => new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => reject(new Error("holder did not exit")), 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGKILL");
  })));
  children.clear();
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(prefix: string): Promise<string> {
  const path = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(tmpdir(), prefix)));
  dirs.push(path); return path;
}

function waitReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("holder not ready")), 3_000);
    child.stdout.once("data", (value: Buffer) => {
      clearTimeout(timer);
      if (value.toString("utf8").includes("ready")) resolve();
      else reject(new Error("bad holder ready"));
    });
    child.once("error", reject);
  });
}

describe("cross-process lease recovery", () => {
  it("keeps a live owner busy, then observes normal reaped release without deleting its tombstone", async () => {
    const state = await directory("relay-lease-state-");
    const cwd = await directory("relay-lease-cwd-");
    const child = spawn(process.execPath, [holder, pathToFileURL(join(root, "dist", "store.js")).href, state, cwd, "locked"], { stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    await waitReady(child);
    await expect(new SessionStore(state).acquire(cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    child.stdin.write("release\n");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const lease = await new SessionStore(state).acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
    expect((await readdir(join(state, "locks"))).some((entry) => entry.includes("retired"))).toBe(true);
  });
});
