import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cli = join(root, "dist", "cli.js");
const fakeGrok = join(here, "fixtures", "fake-grok");
const lockHolder = join(here, "fixtures", "lock-holder.mjs");
const dirs: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

beforeAll(() => {
  execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json"], { cwd: root });
});
afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "relay-process-"));
  dirs.push(path);
  return path;
}

function waitForLine(child: ChildProcessWithoutNullStreams, predicate: (line: string) => boolean, timeout = 3_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let pending = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error("timed out waiting for line")); }, timeout);
    const onData = (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      const match = lines.find(predicate);
      if (match !== undefined) { cleanup(); resolve(match); }
    };
    const onExit = () => { cleanup(); reject(new Error("process exited before matching line")); };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForFileText(path: string, pattern: RegExp, timeout = 3_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const text = await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"));
        if (pattern.test(text)) return resolve();
      } catch { /* not written yet */ }
      if (Date.now() - started >= timeout) return reject(new Error("timed out waiting for fake log"));
      setTimeout(() => { void check(); }, 20);
    };
    void check();
  });
}

function waitForStderr(child: ChildProcessWithoutNullStreams, pattern: RegExp, timeout = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error("timed out waiting for stderr")); }, timeout);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (pattern.test(output)) { cleanup(); resolve(); }
    };
    const cleanup = () => { clearTimeout(timer); child.stderr.off("data", onData); };
    child.stderr.on("data", onData);
  });
}

function startCli(stateDir: string, cwd: string, log: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [cli], {
    cwd,
    env: {
      ...process.env,
      CODEX_AGENT_RELAY_STATE_DIR: stateDir,
      CODEX_AGENT_RELAY_GROK_COMMAND: fakeGrok,
      CODEX_AGENT_RELAY_TOTAL_TIMEOUT_MS: "10000",
      CODEX_AGENT_RELAY_CANCEL_GRACE_MS: "100",
      CODEX_AGENT_RELAY_TERM_GRACE_MS: "100",
      FAKE_ACP_MODE: "hang",
      FAKE_ACP_LOG: log,
      XAI_API_KEY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function initialize(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
  } })}\n`);
  await waitForLine(child, (line) => line.includes('"id":1'));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
}

function callDelegate(child: ChildProcessWithoutNullStreams, id: number, cwd: string): void {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {
    name: "grok_delegate", arguments: { task: "hang", cwd },
  } })}\n`);
}

async function waitExit(child: ChildProcessWithoutNullStreams, timeout = 3_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process did not exit")), timeout);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

describe("cross-process lifecycle", () => {
  it("enforces the cwd lock between real OS processes", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const holder = spawn(process.execPath, [lockHolder, pathToFileURL(join(root, "dist", "store.js")).href, state, cwd], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(holder);
    await waitForLine(holder, (line) => line === "ready");
    await expect(new SessionStore(state).acquire(cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    holder.kill("SIGTERM");
    await waitExit(holder);
    const release = await new SessionStore(state).acquire(cwd);
    await release();
  });

  it.each(["eof", "signal"])("cleans a running task and lock on CLI %s", async (ending) => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "fake.log");
    const child = startCli(state, cwd, log);
    await initialize(child);
    callDelegate(child, 2, cwd);
    await waitForFileText(log, /prompt:fake-session-1/);
    if (ending === "eof") child.stdin.end(); else child.kill("SIGTERM");
    await waitExit(child, 5_000);
    expect(await readdir(join(state, "locks"))).toEqual([]);
    expect(await import("node:fs/promises").then((fs) => fs.readFile(log, "utf8"))).toContain("cancel:fake-session-1");
  });

  it("stops accepting new tool calls before awaiting shutdown cleanup", async () => {
    const state = await tempDir();
    const firstCwd = await tempDir();
    const secondCwd = await tempDir();
    const log = join(state, "shutdown-gate.log");
    const child = startCli(state, firstCwd, log);
    child.stdin.on("error", () => undefined);
    await initialize(child);
    callDelegate(child, 2, firstCwd);
    await waitForFileText(log, /prompt:fake-session-1/);
    child.kill("SIGTERM");
    await waitForStderr(child, /received SIGTERM/);
    callDelegate(child, 3, secondCwd);
    await waitExit(child, 5_000);
    const events = await import("node:fs/promises").then((fs) => fs.readFile(log, "utf8"));
    expect(events.match(/prompt:fake-session-1/g)).toHaveLength(1);
    expect(await readdir(join(state, "locks"))).toEqual([]);
  });
});
