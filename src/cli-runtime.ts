import type { McpServer } from "@modelcontextprotocol/server";
import {
  serveStdio as defaultServeStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import type { RelayConfig } from "./config.js";
import { beginRunnerShutdown } from "./runner.js";
import { createRelayServer } from "./server.js";

export type CliShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
export type CliShutdownReason = CliShutdownSignal | "EOF";

type ErrorListener = (error: Error) => void;
type CliInput = {
  on(event: "end", listener: () => void): unknown;
  pause(): unknown;
};
type CliErrorStream = {
  on(event: "error", listener: ErrorListener): unknown;
  off?(event: "error", listener: ErrorListener): unknown;
};
type CliErrorOutput = CliErrorStream & {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
};
type CliProcess = {
  on(event: CliShutdownSignal, listener: () => void): unknown;
  exit(code: number): unknown;
};

export type CliDependencies = {
  serveStdio?: (
    factory: () => McpServer,
    options: { onerror: (error: Error) => void },
  ) => StdioServerHandle;
  createServer?: (config: RelayConfig) => McpServer;
  beginShutdown?: () => Promise<void>;
  stdin?: CliInput;
  stdout?: CliErrorStream;
  stderr?: CliErrorOutput;
  process?: CliProcess;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  closeTimeoutMs?: number;
};

export type CliRuntime = {
  shutdown(reason: CliShutdownReason): Promise<void>;
  completion: Promise<number>;
};

type ShutdownErrorKind = "cleanup" | "transport" | "runtime";
type ShutdownError = { kind: ShutdownErrorKind; message: string };

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const SHUTDOWN_DIAGNOSTIC_BYTES = 8 * 1_024;
const SHUTDOWN_DIAGNOSTIC_LIMIT = 16;
const RETAINED_ERROR_MESSAGE_BYTES = 384;
const shutdownKindPriority: readonly ShutdownErrorKind[] = ["cleanup", "transport", "runtime"];

export function runCli(config: RelayConfig, dependencies: CliDependencies = {}): CliRuntime {
  const serve = dependencies.serveStdio ?? defaultServeStdio;
  const createServer = dependencies.createServer ?? createRelayServer;
  const beginShutdown = dependencies.beginShutdown ?? beginRunnerShutdown;
  const stdin = dependencies.stdin ?? process.stdin;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const processControl = dependencies.process ?? process;
  const setTimer = dependencies.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  const closeTimeoutMs = Math.max(1, dependencies.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
  const shutdownErrors: ShutdownError[] = [];
  const shutdownErrorKeys = new Set<string>();
  let shutdownErrorCount = 0;
  let shutdownErrorsOmitted = 0;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  let shutdownBytes = 0;
  let resolveCompletion: (code: number) => void = () => {};
  const completion = new Promise<number>((resolve) => { resolveCompletion = resolve; });

  const recordError = (kind: ShutdownErrorKind, error: unknown): void => {
    const message = errorMessage(error);
    const key = `${kind}\u0000${message}`;
    if (shutdownErrorKeys.has(key)) return;
    shutdownErrorCount += 1;
    if (shutdownErrors.length >= SHUTDOWN_DIAGNOSTIC_LIMIT) {
      const newPriority = shutdownKindPriority.indexOf(kind);
      let replacement = -1;
      let worstPriority = newPriority;
      for (let index = 0; index < shutdownErrors.length; index += 1) {
        const candidatePriority = shutdownKindPriority.indexOf(shutdownErrors[index]!.kind);
        if (candidatePriority > worstPriority) {
          replacement = index;
          worstPriority = candidatePriority;
        }
      }
      if (replacement >= 0) {
        const removed = shutdownErrors[replacement]!;
        shutdownErrorKeys.delete(`${removed.kind}\u0000${removed.message}`);
        shutdownErrors[replacement] = { kind, message };
        shutdownErrorKeys.add(key);
        shutdownErrorsOmitted += 1;
        return;
      }
      shutdownErrorsOmitted += 1;
      return;
    }
    shutdownErrorKeys.add(key);
    shutdownErrors.push({ kind, message });
  };
  const writeOrdinaryError = (message: string): void => {
    try { stderr.write(`${boundedText(message, SHUTDOWN_DIAGNOSTIC_BYTES)}\n`); } catch { /* reporting must not recurse */ }
  };
  const onSdkError = (error: Error): void => {
    if (shuttingDown) recordError("transport", error);
    else writeOrdinaryError(`[codex-agent-relay] ${error.message}`);
  };
  const onStdoutError = (error: Error): void => {
    if (shuttingDown) recordError("transport", error);
    else writeOrdinaryError(`[codex-agent-relay] ${error.message}`);
  };
  const onStderrError = (error: Error): void => {
    if (shuttingDown) recordError("runtime", error);
  };

  stdout.on("error", onStdoutError);
  stderr.on("error", onStderrError);
  const handle = serve(() => createServer(config), { onerror: onSdkError });

  const takeShutdownText = (value: string): string => {
    const remaining = Math.max(0, SHUTDOWN_DIAGNOSTIC_BYTES - shutdownBytes);
    const bounded = boundedText(value, remaining);
    shutdownBytes += Buffer.byteLength(bounded);
    return bounded;
  };
  const writeShutdownText = (value: string): Promise<Error | undefined> => {
    const output = takeShutdownText(value);
    if (!output) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let settled = false;
      const timerRef: { value?: unknown } = {};
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimer(timerRef.value);
        resolve(error);
      };
      const timer = setTimer(() => finish(new Error("stderr flush timed out")), closeTimeoutMs);
      timerRef.value = timer;
      if (settled) clearTimer(timer);
      try {
        stderr.write(output, (error) => finish(error ?? undefined));
      } catch (error) {
        finish(asError(error));
      }
    });
  };

  const shutdown = (reason: CliShutdownReason): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    let resolveShutdown: () => void = () => {};
    shutdownPromise = new Promise<void>((resolve) => { resolveShutdown = resolve; });
    shuttingDown = true;

    const cleanupResult = captureOperation(beginShutdown);
    let pauseError: Error | undefined;
    try { stdin.pause(); } catch (error) { pauseError = asError(error); }
    const closeResult = captureOperation(() => handle.close());
    const closeWithTimeout = withOperationTimeout(
      closeResult,
      closeTimeoutMs,
      "MCP transport close timed out",
      setTimer,
      clearTimer,
    );
    const initialWrite = writeShutdownText(`[codex-agent-relay] received ${reason}; cleaning up\n`);

    void (async () => {
      const [cleanupError, closeError, logError] = await Promise.all([
        cleanupResult,
        closeWithTimeout,
        initialWrite,
      ]);
      if (cleanupError) recordError("cleanup", cleanupError);
      if (closeError) recordError("transport", closeError);
      if (pauseError) recordError("runtime", pauseError);
      if (logError) recordError("runtime", logError);

      const errors = orderedUniqueErrors(shutdownErrors);
      if (shutdownErrorCount > 0) {
        const finalWriteError = await writeShutdownText(formatShutdownErrors(
          errors,
          shutdownErrorCount,
          shutdownErrorsOmitted,
          Math.max(0, SHUTDOWN_DIAGNOSTIC_BYTES - shutdownBytes),
        ));
        if (finalWriteError) recordError("runtime", finalWriteError);
      }
      const exitCode = shutdownErrorCount > 0 ? 1 : 0;
      resolveCompletion(exitCode);
      resolveShutdown();
      processControl.exit(exitCode);
    })().catch((error) => {
      recordError("runtime", error);
      resolveCompletion(1);
      resolveShutdown();
      processControl.exit(1);
    });

    return shutdownPromise;
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    processControl.on(signal, () => { void shutdown(signal); });
  }
  stdin.on("end", () => { void shutdown("EOF"); });

  return { shutdown, completion };
}

function captureOperation(operation: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    return Promise.resolve(operation()).then(
      () => undefined,
      (error: unknown) => asError(error),
    );
  } catch (error) {
    return Promise.resolve(asError(error));
  }
}

function withOperationTimeout(
  operation: Promise<Error | undefined>,
  timeoutMs: number,
  message: string,
  setTimer: (callback: () => void, ms: number) => unknown,
  clearTimer: (timer: unknown) => void,
): Promise<Error | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const timerRef: { value?: unknown } = {};
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimer(timerRef.value);
      resolve(error);
    };
    const timer = setTimer(() => finish(new Error(message)), timeoutMs);
    timerRef.value = timer;
    if (settled) clearTimer(timer);
    operation.then((error) => finish(error), (error: unknown) => finish(asError(error)));
  });
}

function orderedUniqueErrors(errors: readonly ShutdownError[]): ShutdownError[] {
  const seen = new Set<string>();
  return [...errors]
    .sort((left, right) => shutdownKindPriority.indexOf(left.kind) - shutdownKindPriority.indexOf(right.kind))
    .filter((error) => {
      const key = `${error.kind}\u0000${error.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function formatShutdownErrors(
  errors: readonly ShutdownError[],
  totalCount: number,
  omitted: number,
  limitBytes: number,
): string {
  const included = errors.slice(0, SHUTDOWN_DIAGNOSTIC_LIMIT);
  const header = `[codex-agent-relay] shutdown failed with ${totalCount} error${totalCount === 1 ? "" : "s"}: `;
  const rawDetails = included.map((error) => `${error.kind}: ${error.message}`).join("; ");
  const baseFooter = omitted > 0 ? `; diagnostics truncated; ${omitted} omitted` : "";
  const initialAvailable = Math.max(0, limitBytes - Buffer.byteLength(header) - Buffer.byteLength(baseFooter) - 1);
  const truncated = omitted > 0 || Buffer.byteLength(rawDetails) > initialAvailable;
  const marker = truncated ? `; diagnostics truncated${omitted > 0 ? `; ${omitted} omitted` : ""}` : "";
  const available = Math.max(0, limitBytes - Buffer.byteLength(header) - Buffer.byteLength(marker) - 1);
  const details = boundedText(rawDetails, available);
  return `${header}${details}${marker}\n`;
}

function boundedText(value: string, limitBytes: number): string {
  if (limitBytes <= 0) return "";
  const bytes = Buffer.from(value);
  if (bytes.length <= limitBytes) return value;
  let end = limitBytes;
  let result = bytes.subarray(0, end).toString("utf8");
  while (end > 0 && (result.endsWith("�") || Buffer.byteLength(result) > limitBytes)) {
    end -= 1;
    result = bytes.subarray(0, end).toString("utf8");
  }
  return result;
}

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  if (Buffer.byteLength(value) <= RETAINED_ERROR_MESSAGE_BYTES) return value;
  const marker = " [truncated]";
  return boundedText(value, RETAINED_ERROR_MESSAGE_BYTES - Buffer.byteLength(marker)) + marker;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
