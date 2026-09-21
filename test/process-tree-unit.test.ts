import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ChildProcessModule from "node:child_process";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof ChildProcessModule>(),
  spawn: spawnMock,
}));

type FakeChild = EventEmitter & {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(pid = 123): FakeChild {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  });
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;

function platform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { ...originalPlatform, value });
}

async function controller(child: FakeChild, options = { termGraceMs: 1, killConfirmMs: 10 }) {
  const module = await import("../src/runner/process-tree.js");
  return module.createProcessTreeController(child as never, options);
}

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  spawnMock.mockReset();
  vi.useRealTimers();
});

describe("process-tree system-call failures", () => {
  it("uses the absolute taskkill path and refuses success without observed worker exit", async () => {
    platform("win32");
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const helper = fakeChild();
    spawnMock.mockReturnValue(helper);
    const pending = (await controller(fakeChild(41))).terminate();
    helper.emit("exit", 0, null);
    const report = await pending;
    expect(report).toMatchObject({ forced: true, confirmed: false });
    expect(report.reason).toContain("taskkill.exe succeeded");
    expect(spawnMock).toHaveBeenCalledWith("C:\\Windows\\System32\\taskkill.exe", ["/PID", "41", "/T", "/F"], {
      shell: false, windowsHide: true, stdio: "ignore",
    });
  });

  it("returns an unconfirmed result for nonzero taskkill exit", async () => {
    platform("win32"); vi.stubEnv("SystemRoot", "C:\\Windows");
    const helper = fakeChild(); spawnMock.mockReturnValue(helper);
    const pending = (await controller(fakeChild())).terminate();
    helper.emit("exit", 1, null);
    await expect(pending).resolves.toMatchObject({ confirmed: false, reason: "taskkill.exe failed with exit code 1" });
  });

  it("returns unconfirmed when taskkill cannot spawn and shares one termination promise", async () => {
    platform("win32"); vi.stubEnv("SystemRoot", "C:\\Windows");
    const helper = fakeChild(); spawnMock.mockReturnValue(helper);
    const tree = await controller(fakeChild());
    const first = tree.terminate();
    const second = tree.terminate();
    expect(first).toBe(second);
    helper.emit("error", new Error("ENOENT"));
    await expect(first).resolves.toMatchObject({ confirmed: false, reason: expect.stringContaining("Cannot run taskkill.exe") });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not accept a late zero exit after taskkill timed out", async () => {
    platform("win32"); vi.stubEnv("SystemRoot", "C:\\Windows");
    const helper = fakeChild();
    helper.kill.mockImplementation(() => setTimeout(() => helper.emit("exit", 0, null), 0));
    spawnMock.mockReturnValue(helper);
    await expect((await controller(fakeChild(), { termGraceMs: 1, killConfirmMs: 5 })).terminate())
      .resolves.toMatchObject({ confirmed: false, reason: "taskkill.exe timed out before worker cleanup could be confirmed" });
    expect(helper.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("returns unconfirmed when timing out helper termination itself throws", async () => {
    platform("win32"); vi.stubEnv("SystemRoot", "C:\\Windows");
    const helper = fakeChild(); helper.kill.mockImplementation(() => { throw new Error("denied"); });
    spawnMock.mockReturnValue(helper);
    await expect((await controller(fakeChild(), { termGraceMs: 1, killConfirmMs: 5 })).terminate())
      .resolves.toMatchObject({ confirmed: false, reason: "taskkill.exe timed out and its exit could not be confirmed" });
  });

  it("treats POSIX ESRCH as confirmed only with an observed child exit", async () => {
    platform("linux");
    const child = fakeChild(); child.exitCode = 0;
    vi.spyOn(process, "kill").mockImplementation(() => { const error = Object.assign(new Error(), { code: "ESRCH" }); throw error; });
    await expect((await controller(child)).terminate()).resolves.toEqual({ forced: false, confirmed: true });
  });

  it("treats POSIX EPERM probe and TERM-to-KILL escalation conservatively", async () => {
    platform("linux");
    const unknown = fakeChild();
    vi.spyOn(process, "kill").mockImplementation(() => { const error = Object.assign(new Error(), { code: "EPERM" }); throw error; });
    await expect((await controller(unknown)).terminate()).resolves.toMatchObject({
      forced: false,
      confirmed: false,
      reason: "Cannot determine whether the worker process group is alive",
    });
    vi.restoreAllMocks();
    const child = fakeChild();
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") child.exitCode = 0;
      if (signal === 0 && child.exitCode !== null) { const error = Object.assign(new Error(), { code: "ESRCH" }); throw error; }
      return true;
    });
    await expect((await controller(child, { termGraceMs: 1, killConfirmMs: 10 })).terminate())
      .resolves.toEqual({ forced: true, confirmed: true });
  });

  it("retries a transient EPERM after SIGTERM and confirms only when the group is gone and the child exited", async () => {
    platform("linux");
    vi.useFakeTimers();
    const child = fakeChild();
    let signaledTerm = false;
    let postTermProbes = 0;
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") throw new Error("must not escalate after graceful confirmation");
      if (signal === "SIGTERM") {
        signaledTerm = true;
        return true;
      }
      if (signal === 0) {
        if (!signaledTerm) return true;
        postTermProbes += 1;
        if (postTermProbes === 1) throw Object.assign(new Error(), { code: "EPERM" });
        child.exitCode = 0;
        throw Object.assign(new Error(), { code: "ESRCH" });
      }
      return true;
    });
    const pending = (await controller(child, { termGraceMs: 200, killConfirmMs: 10 })).terminate();
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toEqual({ forced: false, confirmed: true });
    vi.useRealTimers();
  });

  it("does not escalate or confirm when EPERM persists after SIGTERM through the confirmation deadline", async () => {
    platform("linux");
    vi.useFakeTimers();
    const child = fakeChild();
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      signals.push(signal as NodeJS.Signals | number | undefined);
      if (signal === "SIGKILL") throw new Error("must not escalate on persistent unknown");
      if (signal === "SIGTERM") return true;
      if (!signals.includes("SIGTERM")) return true;
      throw Object.assign(new Error(), { code: "EPERM" });
    });
    const pending = (await controller(child, { termGraceMs: 80, killConfirmMs: 10 })).terminate();
    await vi.advanceTimersByTimeAsync(80);
    await expect(pending).resolves.toMatchObject({
      forced: false,
      confirmed: false,
      reason: "Cannot confirm whether the worker process group exited after SIGTERM",
    });
    expect(signals).not.toContain("SIGKILL");
    expect(child.exitCode).toBeNull();
    vi.useRealTimers();
  });

  it("retries a transient unknown after SIGKILL and confirms only after disappearance plus direct-child exit", async () => {
    platform("linux");
    vi.useFakeTimers();
    const child = fakeChild();
    let signaledKill = false;
    let postKillProbes = 0;
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGTERM") return true;
      if (signal === "SIGKILL") {
        signaledKill = true;
        return true;
      }
      if (signal === 0) {
        if (!signaledKill) return true;
        postKillProbes += 1;
        if (postKillProbes === 1) throw Object.assign(new Error(), { code: "EPERM" });
        child.exitCode = 0;
        throw Object.assign(new Error(), { code: "ESRCH" });
      }
      return true;
    });
    const pending = (await controller(child, { termGraceMs: 5, killConfirmMs: 200 })).terminate();
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toEqual({ forced: true, confirmed: true });
    vi.useRealTimers();
  });

  it("does not confirm POSIX cleanup when the group remains after SIGKILL", async () => {
    platform("linux");
    const child = fakeChild();
    vi.spyOn(process, "kill").mockImplementation(() => true);
    await expect((await controller(child, { termGraceMs: 1, killConfirmMs: 1 })).terminate())
      .resolves.toMatchObject({ forced: true, confirmed: false, reason: expect.stringContaining("did not exit") });
  });
});
