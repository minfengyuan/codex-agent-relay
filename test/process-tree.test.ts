import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessTreeController, processTreeSpawnOptions } from "../src/runner/process-tree.js";

const children = new Set<ChildProcessWithoutNullStreams>();
const orphanPids = new Set<number>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all([...children].map((child) => waitForExit(child).catch(() => undefined)));
  children.clear();
  await Promise.all([...orphanPids].map((pid) => killOwnedTree(pid)));
  orphanPids.clear();
  vi.unstubAllEnvs();
});

function startNode(source: string, detached = false): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ["-e", source], {
    detached,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function waitForLine(child: ChildProcessWithoutNullStreams, timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => finish(new Error("child did not report ready")), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const line = buffered.split("\n")[0];
      if (line) finish(undefined, line);
    };
    const finish = (error?: Error, line?: string) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      if (error) reject(error); else resolve(line as string);
    };
    child.stdout.on("data", onData);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child ${child.pid} did not exit`)), timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function killOwnedTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (systemRoot) {
      await new Promise<void>((resolve) => {
        const helper = execFile(`${systemRoot}\\System32\\taskkill.exe`, ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
        });
        helper.once("exit", () => resolve());
        helper.once("error", () => resolve());
      });
      return;
    }
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* the exact test child already exited */ }
}

describe("process-tree controller", () => {
  it("uses a platform-appropriate worker spawn shape", () => {
    expect(processTreeSpawnOptions()).toEqual({ detached: process.platform !== "win32" });
  });

  it.runIf(process.platform === "win32")("terminates a live Windows worker tree once, including its descendant", async () => {
    const child = startNode([
      "const { spawn } = require('node:child_process');",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "console.log(descendant.pid);",
      "setInterval(() => {}, 1000);",
    ].join(" "));
    await waitForSpawn(child);
    const descendantPid = Number(await waitForLine(child));
    orphanPids.add(descendantPid);
    const controller = createProcessTreeController(child, { termGraceMs: 20, killConfirmMs: 5_000 });
    expect(controller.reference()).toEqual({ kind: "windows-process-tree", pid: child.pid });
    const [first, second] = await Promise.all([controller.terminate(), controller.terminate()]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ forced: true, confirmed: true });
    await waitForExit(child);
    expect(() => process.kill(descendantPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    orphanPids.delete(descendantPid);
  });

  it.runIf(process.platform === "win32")("keeps Windows cleanup conservative when the root already exited", async () => {
    const child = startNode([
      "const { spawn } = require('node:child_process');",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "process.stdout.write(`${descendant.pid}\\n`, () => process.exit(19));",
    ].join(" "));
    await waitForSpawn(child);
    const descendantPid = Number(await waitForLine(child));
    orphanPids.add(descendantPid);
    await waitForExit(child);
    const report = await createProcessTreeController(child, { termGraceMs: 20, killConfirmMs: 50 }).terminate();
    expect(report).toMatchObject({ forced: true, confirmed: false });
    expect(report.reason).toContain("root exited");
  });

  it.runIf(process.platform === "win32")("does not invoke an untrusted taskkill location", async () => {
    vi.stubEnv("SystemRoot", "");
    const child = startNode("setInterval(() => {}, 1000)");
    await waitForSpawn(child);
    const report = await createProcessTreeController(child, { termGraceMs: 20, killConfirmMs: 50 }).terminate();
    expect(report).toMatchObject({ forced: true, confirmed: false });
    expect(report.reason).toContain("SystemRoot");
  });

  it.runIf(process.platform !== "win32")("forces an uncooperative POSIX process group and confirms it exits", async () => {
    const child = startNode("process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)", true);
    await waitForSpawn(child);
    await waitForLine(child);
    const report = await createProcessTreeController(child, { termGraceMs: 20, killConfirmMs: 2_000 }).terminate();
    expect(report).toEqual({ forced: true, confirmed: true });
    await waitForExit(child);
  });
});
