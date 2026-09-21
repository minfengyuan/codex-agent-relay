import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { win32 } from "node:path";
import { delay } from "./limits.js";

export type ProcessTreeReference =
  | { kind: "posix-process-group"; pid: number; pgid: number }
  | { kind: "windows-process-tree"; pid: number };

export type TerminationReport = {
  forced: boolean;
  confirmed: boolean;
  reason?: string;
};

export interface ProcessTreeController {
  reference(): ProcessTreeReference | undefined;
  terminate(): Promise<TerminationReport>;
}

export type ProcessProbe = "alive" | "gone" | "unknown";

export function probeProcess(pid: number): ProcessProbe {
  return probePid(pid);
}

export function probePosixProcessGroup(pgid: number): ProcessProbe {
  return probePid(-pgid);
}

type ControllerOptions = {
  termGraceMs: number;
  killConfirmMs: number;
};

export function processTreeSpawnOptions(): Pick<SpawnOptionsWithoutStdio, "detached"> {
  return { detached: process.platform !== "win32" };
}

export function createProcessTreeController(
  child: ChildProcessWithoutNullStreams,
  options: ControllerOptions,
): ProcessTreeController {
  let termination: Promise<TerminationReport> | undefined;
  const reference = (): ProcessTreeReference | undefined => {
    if (child.pid === undefined) return undefined;
    return process.platform === "win32"
      ? { kind: "windows-process-tree", pid: child.pid }
      : { kind: "posix-process-group", pid: child.pid, pgid: child.pid };
  };
  return {
    reference,
    terminate(): Promise<TerminationReport> {
      termination ??= process.platform === "win32"
        ? terminateWindows(child, reference(), options.killConfirmMs)
        : terminatePosix(child, reference(), options.termGraceMs, options.killConfirmMs);
      return termination;
    },
  };
}

function exited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminatePosix(
  child: ChildProcessWithoutNullStreams,
  reference: ProcessTreeReference | undefined,
  termGraceMs: number,
  killConfirmMs: number,
): Promise<TerminationReport> {
  if (!reference || reference.kind !== "posix-process-group") {
    return { forced: false, confirmed: false, reason: "The worker process has no process-group reference" };
  }
  const group = -reference.pgid;
  const initial = probePosixGroup(group);
  if (initial === "unknown") {
    return { forced: false, confirmed: false, reason: "Cannot determine whether the worker process group is alive" };
  }
  if (initial === "gone") {
    return exited(child) || await waitForChildExit(child, killConfirmMs)
      ? { forced: false, confirmed: true }
      : { forced: false, confirmed: false, reason: "The process group disappeared but the worker exit was not observed" };
  }

  const termError = signalPosixGroup(group, "SIGTERM");
  if (termError && termError !== "gone") {
    return { forced: false, confirmed: false, reason: `Cannot terminate the worker process group: ${termError}` };
  }
  const graceful = await waitForPosixExit(child, group, termGraceMs);
  if (graceful === "confirmed") return { forced: false, confirmed: true };
  if (graceful === "unknown") {
    return { forced: false, confirmed: false, reason: "Cannot confirm whether the worker process group exited after SIGTERM" };
  }

  const killError = signalPosixGroup(group, "SIGKILL");
  if (killError && killError !== "gone") {
    return { forced: true, confirmed: false, reason: `Cannot force-kill the worker process group: ${killError}` };
  }
  const forced = await waitForPosixExit(child, group, killConfirmMs);
  if (forced === "confirmed") return { forced: true, confirmed: true };
  return {
    forced: true,
    confirmed: false,
    reason: forced === "unknown"
      ? "Cannot confirm whether the worker process group exited after SIGKILL"
      : "The worker process group did not exit after SIGKILL",
  };
}

function probePid(pid: number): ProcessProbe {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown";
  }
}

function probePosixGroup(group: number): ProcessProbe {
  return probePid(group);
}

function signalPosixGroup(group: number, signal: NodeJS.Signals): "gone" | string | undefined {
  try {
    process.kill(group, signal);
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "gone" : code ?? String(error);
  }
}

async function waitForPosixExit(
  child: ChildProcessWithoutNullStreams,
  group: number,
  timeoutMs: number,
): Promise<"confirmed" | "alive" | "unknown"> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const probe = probePosixGroup(group);
    if (probe === "gone" && exited(child)) return "confirmed";
    if (Date.now() >= deadline) return probe === "unknown" ? "unknown" : probe === "gone" ? "alive" : probe;
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (exited(child)) return true;
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off("exit", onExit); resolve(exited(child)); }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function terminateWindows(
  child: ChildProcessWithoutNullStreams,
  reference: ProcessTreeReference | undefined,
  killConfirmMs: number,
): Promise<TerminationReport> {
  if (!reference || reference.kind !== "windows-process-tree") {
    return { forced: true, confirmed: false, reason: "The worker process has no process-tree reference" };
  }
  if (exited(child)) {
    return {
      forced: true,
      confirmed: false,
      reason: "The worker root exited before tree termination, so descendant cleanup cannot be confirmed",
    };
  }
  const systemRoot = process.env.SystemRoot?.trim();
  if (!systemRoot || !win32.isAbsolute(systemRoot)) {
    return { forced: true, confirmed: false, reason: "SystemRoot is unavailable or not absolute; cannot locate taskkill.exe" };
  }
  const taskkill = win32.join(systemRoot, "System32", "taskkill.exe");
  const deadline = Date.now() + killConfirmMs;
  const helper = spawn(taskkill, ["/PID", String(reference.pid), "/T", "/F"], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  const helperResult = await waitForHelper(helper, Math.max(1, deadline - Date.now()), killConfirmMs);
  if (helperResult !== "success") {
    return { forced: true, confirmed: false, reason: helperResult };
  }
  const remaining = Math.max(0, deadline - Date.now());
  if (!exited(child) && (remaining === 0 || !await waitForChildExit(child, remaining))) {
    return { forced: true, confirmed: false, reason: "taskkill.exe succeeded but the worker exit was not observed" };
  }
  return { forced: true, confirmed: true };
}

function waitForHelper(
  helper: ChildProcess,
  timeoutMs: number,
  drainTimeoutMs: number,
): Promise<"success" | string> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const finish = (result: "success" | string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      helper.removeListener("error", onError);
      helper.removeListener("exit", onExit);
      resolve(result);
    };
    const onError = (error: Error) => finish(`Cannot run taskkill.exe: ${error.message}`);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) {
        finish("taskkill.exe timed out before worker cleanup could be confirmed");
        return;
      }
      if (code === 0) finish("success");
      else finish(`taskkill.exe failed with ${code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`}`);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try { helper.kill("SIGKILL"); } catch { /* reported as an unconfirmed timeout below */ }
      forceTimer = setTimeout(() => {
        finish("taskkill.exe timed out and its exit could not be confirmed");
      }, drainTimeoutMs);
    }, timeoutMs);
    helper.once("error", onError);
    helper.once("exit", onExit);
  });
}
