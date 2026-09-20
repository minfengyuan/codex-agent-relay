import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { RelayConfig } from "../config.js";
import type { SessionStore, WorkspaceLease } from "../store.js";
import { RelayFailure, type DelegateInput, type RelayResult } from "../types.js";
import { abortFailure, hasLoadCapability } from "./helpers.js";
import { appendLimited, boundedString, withTimeout } from "./limits.js";
import {
  createProcessTreeController,
  processTreeSpawnOptions,
  type ProcessTreeController,
  type TerminationReport,
} from "./process-tree.js";
import type { ProgressReporter, ProviderAdapter } from "./types.js";

type ActiveChild = { cancel: () => Promise<TerminationReport> };

export type CleanupFailureCode =
  | "PROCESS_CLEANUP_FAILED"
  | "LOCK_OWNERSHIP_LOST"
  | "LOCK_IO"
  | "INTERNAL";

export type CleanupDiagnostic = {
  code: CleanupFailureCode;
  message: string;
};

export type CleanupReport = {
  diagnostics: readonly CleanupDiagnostic[];
};

type ActiveTask = {
  cancel: () => Promise<void>;
  settled: Promise<CleanupReport>;
  resolveSettled: (report: CleanupReport) => void;
};

const activeTasks = new Set<ActiveTask>();
let runnerAccepting = true;
let runnerShutdownPromise: Promise<void> | undefined;

const CLEANUP_DIAGNOSTIC_LIMIT = 16;
const CLEANUP_DIAGNOSTIC_BYTES = 8 * 1_024;
const cleanupPriority: readonly CleanupFailureCode[] = [
  "PROCESS_CLEANUP_FAILED",
  "LOCK_OWNERSHIP_LOST",
  "LOCK_IO",
  "INTERNAL",
];

export class CleanupAggregateError extends Error {
  constructor(
    public readonly taskCount: number,
    public readonly failureCount: number,
    public readonly primaryCode: CleanupFailureCode,
    public readonly diagnostics: readonly CleanupDiagnostic[],
    public readonly omittedCount: number,
    public readonly truncated: boolean,
  ) {
    super(cleanupAggregateMessage(taskCount, failureCount, primaryCode, diagnostics, omittedCount, truncated));
    this.name = "CleanupAggregateError";
  }
}

export class AcpRunner<I extends DelegateInput, R extends RelayResult> {
  constructor(
    private readonly config: RelayConfig,
    private readonly store: SessionStore,
    private readonly adapter: ProviderAdapter<I, R>,
  ) {}

  async delegate(input: I, signal?: AbortSignal, reportProgress?: ProgressReporter): Promise<R> {
    assertRunnerAccepting();
    if (process.env.CODEX_AGENT_RELAY_DELEGATED === "1") {
      throw new RelayFailure("NESTED_DELEGATION", "Delegation is disabled inside a delegated worker process");
    }
    this.adapter.validateInput?.(input);
    if (signal?.aborted) abortFailure(signal);
    const cwd = input.cwd;
    let lease: WorkspaceLease | undefined;
    let sessionId: string | null = input.sessionId ?? null;
    let text = "";
    let truncated = false;
    let stderr = "";
    let permissionRequested = false;
    let permissionFailure: RelayFailure | undefined;
    let promptStarted = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    let processTree: ProcessTreeController | undefined;
    const worker: { state: "not-attempted" | "pending" | "created" | "failed" } = { state: "not-attempted" };
    let active: ActiveChild | undefined;
    let operation: Promise<string> | undefined;
    let completedResult: R | undefined;
    let pendingError: RelayFailure | undefined;
    let cleanupReport: TerminationReport | undefined;
    let eagerCleanup: Promise<TerminationReport> | undefined;
    let unexpectedCleanupError: unknown;
    let hasUnexpectedCleanupError = false;
    const leaseErrors: RelayFailure[] = [];
    const summarizer = this.adapter.createSummarizer(Math.max(64 * 1_024, this.config.textLimitBytes));
    const partial = (): Partial<R> => ({
      sessionId,
      text,
      truncated: truncated || summarizer.truncated,
      ...summarizer.result(),
    });
    const totalAbort = new AbortController();
    let resolveSettled: (report: CleanupReport) => void = () => {};
    const taskEntry: ActiveTask = {
      cancel: async () => {
        totalAbort.abort(new RelayFailure("CANCELLED", "Relay is shutting down"));
        if (active) await active.cancel();
        else if (processTree) await processTree.terminate();
      },
      settled: new Promise<CleanupReport>((resolve) => { resolveSettled = resolve; }),
      resolveSettled: (report) => resolveSettled(report),
    };
    assertRunnerAccepting();
    activeTasks.add(taskEntry);
    const totalTimer = setTimeout(() => totalAbort.abort(new RelayFailure(
      "TIMEOUT",
      `${this.adapter.displayName} task exceeded the ${this.config.totalTimeoutMs / 1000} second limit`,
    )), this.config.totalTimeoutMs);
    const onCallerAbort = () => totalAbort.abort(new RelayFailure("CANCELLED", "MCP request was cancelled"));
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (signal?.aborted) onCallerAbort();

    try {
      lease = await this.store.acquire(cwd);
      if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
      const record = input.sessionId ? await this.store.read(input.sessionId, cwd) : undefined;
      const metadata = this.adapter.sessionMetadata(input, record);
      if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
      const invocation = this.adapter.command(input, record);
      const childEnv = { ...process.env, CODEX_AGENT_RELAY_DELEGATED: "1" };
      try { await lease.markSpawning(); } catch (error) {
        const failure = asLeaseFailure(error, "Cannot persist spawning workspace lease state");
        leaseErrors.push(failure);
        throw failure;
      }
      if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
      worker.state = "pending";
      try {
        child = spawn(invocation.command, invocation.args, {
          cwd,
          env: this.adapter.spawnEnv ? this.adapter.spawnEnv(childEnv) : childEnv,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          ...processTreeSpawnOptions(),
        });
      } catch (error) {
        worker.state = "failed";
        throw error;
      }
      processTree = createProcessTreeController(child, {
        termGraceMs: this.config.termGraceMs,
        killConfirmMs: this.config.killConfirmMs,
      });
      const spawned = new Promise<void>((resolve, reject) => {
        child?.once("spawn", () => { worker.state = "created"; resolve(); });
        child?.once("error", (error) => {
          worker.state = processTree?.reference() ? "created" : "failed";
          reject(error);
        });
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        const joined = stderr + chunk;
        const bytes = Buffer.from(joined);
        stderr = bytes.length > this.config.stderrLimitBytes
          ? bytes.subarray(bytes.length - this.config.stderrLimitBytes).toString("utf8")
          : joined;
      });
      await withTimeout(spawned, this.config.phaseTimeoutMs, "SPAWN_TIMEOUT", `Timed out starting ${this.adapter.displayName}`);
      const workerReference = processTree.reference();
      if (!workerReference) throw new RelayFailure("LOCK_IO", "Spawned worker has no process-tree reference");
      try { await lease.bindWorker(workerReference); } catch (error) {
        const failure = asLeaseFailure(error, "Cannot persist running workspace lease state");
        leaseErrors.push(failure);
        throw failure;
      }
      if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);

      let clientContext: acp.ClientContext | undefined;
      let cancellation: Promise<TerminationReport> | undefined;
      const cancelChild = (): Promise<TerminationReport> => {
        cancellation ??= (async () => {
          if (clientContext && sessionId) {
            const deadline = Date.now() + this.config.cancelGraceMs;
            await settleWithin(
              clientContext.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => undefined),
              Math.max(1, deadline - Date.now()),
            );
            const remaining = Math.max(0, deadline - Date.now());
            if (remaining > 0) await waitForExit(child as ChildProcessWithoutNullStreams, remaining);
          }
          return processTree?.terminate() ?? {
            forced: false,
            confirmed: false,
            reason: "The worker process tree controller is unavailable",
          };
        })();
        return cancellation;
      };
      active = { cancel: cancelChild };

      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      let lastProgress = 0;
      let app = acp.client({ name: "codex-agent-relay" })
        .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
          return this.adapter.handlePermission(params, {
            sessionId,
            signal: totalAbort.signal,
            partial,
            abort: (failure) => totalAbort.abort(failure),
            markRequested: () => { permissionRequested = true; },
            setFailure: (failure) => { permissionFailure = failure; },
            hasFailure: () => permissionFailure !== undefined,
            summarizer,
          });
        })
        .onNotification(acp.methods.client.session.update, async ({ params }) => {
          if (!promptStarted || params.sessionId !== sessionId) return;
          const update = params.update;
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            const appended = appendLimited(text, update.content.text, this.config.textLimitBytes);
            text = appended.value;
            truncated ||= appended.truncated;
          } else if (update.sessionUpdate === "usage_update") {
            summarizer.onUsage?.(update);
          } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            summarizer.onToolCall?.({
              toolCallId: update.toolCallId,
              ...(update.title ? { title: update.title } : {}),
              ...(update.status ? { status: update.status } : {}),
            });
            if (reportProgress) {
              const now = Date.now();
              if (now - lastProgress >= this.config.progressIntervalMs) {
                lastProgress = now;
                await reportProgress(update.title ?? `${this.adapter.displayName} is using a tool`);
              }
            }
          }
        });
      if (this.adapter.extendClient) app = this.adapter.extendClient(app, summarizer);

      operation = app.connectWith(stream, async (ctx) => {
        clientContext = ctx;
        if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
        const initialized = await withTimeout(ctx.request(acp.methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: this.adapter.capabilities,
          clientInfo: { name: "codex-agent-relay", version: "0.1.0" },
        }), this.config.phaseTimeoutMs, "INITIALIZE_TIMEOUT", `${this.adapter.displayName} initialize timed out`);
        if (initialized.protocolVersion !== 1) {
          throw new RelayFailure("PROTOCOL_MISMATCH", `${this.adapter.displayName} returned ACP protocol ${initialized.protocolVersion}`);
        }
        const authMethod = this.adapter.authenticate(initialized);
        if (authMethod) {
          if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
          await withTimeout(ctx.request(
            acp.methods.agent.authenticate,
            this.adapter.authenticateParams?.(authMethod) ?? { methodId: authMethod },
          ), this.config.phaseTimeoutMs, "AUTH_TIMEOUT", `${this.adapter.displayName} authentication timed out`);
        }

        let sessionModes: acp.SessionModeState | null | undefined;
        let configOptions: readonly acp.SessionConfigOption[] | null | undefined;
        if (record) {
          if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
          const action = this.adapter.existingSession?.(initialized, input) ?? "load";
          if (action === "resume") {
            const resumed = await withTimeout(ctx.request(acp.methods.agent.session.resume, {
              sessionId: record.sessionId,
              cwd,
              mcpServers: [],
            }), this.config.phaseTimeoutMs, "RESUME_TIMEOUT", `${this.adapter.displayName} session resume timed out`);
            sessionModes = resumed.modes;
            configOptions = resumed.configOptions;
          } else {
            if (!this.adapter.existingSession && !hasLoadCapability(initialized.agentCapabilities)) {
              throw new RelayFailure("LOAD_UNSUPPORTED", `${this.adapter.displayName} did not advertise loadSession capability`);
            }
            const loaded = await withTimeout(ctx.request(acp.methods.agent.session.load, {
              sessionId: record.sessionId,
              cwd,
              mcpServers: [],
            }), this.config.phaseTimeoutMs, "LOAD_TIMEOUT", `${this.adapter.displayName} session load timed out`);
            sessionModes = loaded.modes;
            configOptions = loaded.configOptions;
          }
        } else {
          if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
          const created = await withTimeout(ctx.request(acp.methods.agent.session.new, {
            cwd,
            mcpServers: [],
          }), this.config.phaseTimeoutMs, "NEW_SESSION_TIMEOUT", `${this.adapter.displayName} session creation timed out`);
          sessionId = created.sessionId;
          if (!sessionId) throw new RelayFailure("INVALID_SESSION", `${this.adapter.displayName} returned an empty sessionId`);
          sessionModes = created.modes;
          configOptions = created.configOptions;
        }
        if (this.adapter.configureSession) {
          await this.adapter.configureSession(ctx, sessionId as string, input, {
            agentCapabilities: initialized.agentCapabilities,
            configOptions,
            modes: sessionModes,
            metadata,
          }, totalAbort.signal);
        }
        if (!record) await this.store.writeNew(sessionId as string, cwd, metadata);

        promptStarted = true;
        if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
        const response = await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: sessionId as string,
          prompt: [{ type: "text", text: this.adapter.prompt(input.task) }],
        });
        if (permissionRequested) {
          throw permissionFailure ?? new RelayFailure(
            "UNEXPECTED_PERMISSION",
            "Grok requested permission despite --always-approve",
            partial(),
          );
        }
        if (this.adapter.completeSession) {
          try {
            await this.adapter.completeSession(ctx, sessionId as string, totalAbort.signal);
          } finally {
            // Start tree cleanup while the ACP connection still keeps the worker root alive.
            // This is required on Windows, where a root that exits before taskkill starts
            // cannot provide proof that its descendants were also removed.
            eagerCleanup ??= processTree?.terminate();
          }
        }
        if (record) await this.store.touch(record);
        return response.stopReason;
      });

      if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
      const stopReason = await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          if (totalAbort.signal.aborted) reject(totalAbort.signal.reason);
          totalAbort.signal.addEventListener("abort", () => reject(totalAbort.signal.reason), { once: true });
        }),
      ]);
      completedResult = {
        sessionId,
        stopReason,
        text,
        truncated: truncated || summarizer.truncated,
        ...summarizer.result(),
      } as R;
    } catch (error) {
      if ((totalAbort.signal.aborted || permissionRequested) && active) {
        await active.cancel().catch(() => undefined);
        if (operation) await settleWithin(operation.catch(() => undefined), this.config.killConfirmMs);
      }
      const effectiveError = totalAbort.signal.aborted && totalAbort.signal.reason instanceof RelayFailure
        ? totalAbort.signal.reason
        : error;
      const failure = effectiveError instanceof RelayFailure
        ? effectiveError
        : new RelayFailure(
          "ACP_FAILURE",
          `${effectiveError instanceof Error ? effectiveError.message : String(effectiveError)}${stderr ? `; ${this.adapter.displayName} stderr: ${stderr}` : ""}`,
        );
      pendingError = new RelayFailure(failure.code, boundedString(failure.message,
        Math.min(this.config.stderrLimitBytes, 8 * 1_024)), {
        ...partial(),
        ...(failure.partial ?? {}),
      } as Partial<R>);
    } finally {
      clearTimeout(totalTimer);
      signal?.removeEventListener("abort", onCallerAbort);
      try {
        if (lease) {
          try { await lease.markTerminating(); } catch (error) {
            leaseErrors.push(asLeaseFailure(error, "Cannot persist terminating workspace lease state"));
          }
        }
        if (worker.state === "created" || worker.state === "pending") {
          try {
            cleanupReport = processTree
              ? await (eagerCleanup ?? processTree.terminate())
              : { forced: false, confirmed: false, reason: "The worker process tree controller is unavailable" };
          } catch (error) {
            cleanupReport = { forced: false, confirmed: false, reason: String(error) };
          }
        }
        const noWorkerCreated = worker.state === "not-attempted" || worker.state === "failed";
        const cleanupConfirmed = noWorkerCreated || cleanupReport?.confirmed === true;
        if (lease && cleanupConfirmed) {
          let reaped = false;
          try {
            await lease.markReaped(noWorkerCreated ? "no-worker-created" : "tree-exit-confirmed");
            reaped = true;
          } catch (error) {
            leaseErrors.push(asLeaseFailure(error, "Cannot persist reaped workspace lease state"));
          }
          if (reaped) {
            try { await lease.release(); } catch (error) {
              leaseErrors.push(asLeaseFailure(error, "Cannot release workspace lease"));
            }
          }
        } else if (lease && !cleanupConfirmed) {
          try { await lease.markOrphaned(); } catch (error) {
            leaseErrors.push(asLeaseFailure(error, "Cannot persist orphaned workspace lease state"));
          }
        }
      } catch (error) {
        hasUnexpectedCleanupError = true;
        unexpectedCleanupError = error;
      } finally {
        let diagnostics: CleanupDiagnostic[];
        try {
          diagnostics = cleanupDiagnostics(
            worker.state,
            cleanupReport,
            leaseErrors,
            unexpectedCleanupError,
            hasUnexpectedCleanupError,
          );
        } catch {
          hasUnexpectedCleanupError = true;
          unexpectedCleanupError = new Error("Cannot construct task cleanup diagnostics");
          diagnostics = [{ code: "INTERNAL", message: "Cannot construct task cleanup diagnostics" }];
        }
        activeTasks.delete(taskEntry);
        taskEntry.resolveSettled({ diagnostics });
      }
    }
    if ((worker.state === "created" || worker.state === "pending") && !cleanupReport?.confirmed) {
      const prior = diagnosticSuffix(pendingError, leaseErrors);
      throw new RelayFailure(
        "PROCESS_CLEANUP_FAILED",
        boundedString(
          `Cannot confirm worker process-tree cleanup: ${cleanupReport?.reason ?? "unknown cleanup failure"}${prior}`,
          Math.min(this.config.stderrLimitBytes, 8 * 1_024),
        ),
        { ...partial(), ...(pendingError?.partial ?? {}) } as Partial<R>,
      );
    }
    if (leaseErrors.length > 0) {
      const failure = leaseErrors.find((candidate) => candidate.code === "LOCK_OWNERSHIP_LOST") ?? leaseErrors[0] as RelayFailure;
      throw new RelayFailure(
        failure.code,
        boundedString(`${failure.message}${diagnosticSuffix(pendingError, leaseErrors.filter((item) => item !== failure))}`,
          Math.min(this.config.stderrLimitBytes, 8 * 1_024)),
        { ...partial(), ...(pendingError?.partial ?? {}) } as Partial<R>,
      );
    }
    if (hasUnexpectedCleanupError) {
      throw new RelayFailure(
        "INTERNAL",
        boundedString(
          `Unexpected task cleanup failure: ${unexpectedCleanupError instanceof Error
            ? unexpectedCleanupError.message
            : String(unexpectedCleanupError)}`,
          Math.min(this.config.stderrLimitBytes, CLEANUP_DIAGNOSTIC_BYTES),
        ),
        { ...partial(), ...(pendingError?.partial ?? {}) } as Partial<R>,
      );
    }
    if (pendingError) throw pendingError;
    if (!completedResult) throw new RelayFailure("INTERNAL", `${this.adapter.displayName} task ended without a result`, partial());
    return completedResult;
  }

}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { child.off("exit", onExit); resolve(); }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asLeaseFailure(error: unknown, context: string): RelayFailure {
  if (error instanceof RelayFailure
    && (error.code === "LOCK_IO" || error.code === "LOCK_OWNERSHIP_LOST")) return error;
  return new RelayFailure("LOCK_IO", `${context}: ${error instanceof Error ? error.message : String(error)}`);
}

function diagnosticSuffix(primary: RelayFailure | undefined, leaseErrors: RelayFailure[]): string {
  const diagnostics = [
    ...(primary ? [`original error ${primary.code}: ${primary.message}`] : []),
    ...leaseErrors.map((failure) => `lease error ${failure.code}: ${failure.message}`),
  ];
  return diagnostics.length > 0 ? `; ${diagnostics.join("; ")}` : "";
}

export async function cleanupAllChildren(): Promise<void> {
  const entries = [...activeTasks];
  const reports = Promise.all(entries.map((entry) => entry.settled));
  await Promise.allSettled(entries.map((entry) => entry.cancel()));
  const settledReports = await reports;
  const failedReports = settledReports.filter((report) => report.diagnostics.length > 0);
  if (failedReports.length === 0) return;

  const allDiagnostics = failedReports.flatMap((report) => dedupeDiagnostics(report.diagnostics));
  const primaryCode = cleanupPriority.find((code) => allDiagnostics.some((item) => item.code === code)) ?? "INTERNAL";
  const bounded = boundCleanupDiagnostics(allDiagnostics);
  throw new CleanupAggregateError(
    entries.length,
    failedReports.length,
    primaryCode,
    bounded.diagnostics,
    bounded.omittedCount,
    bounded.truncated,
  );
}

export function beginRunnerShutdown(): Promise<void> {
  if (runnerShutdownPromise) return runnerShutdownPromise;
  runnerAccepting = false;
  let resolveShutdown: () => void = () => {};
  let rejectShutdown: (error: unknown) => void = () => {};
  runnerShutdownPromise = new Promise<void>((resolve, reject) => {
    resolveShutdown = resolve;
    rejectShutdown = reject;
  });
  try {
    cleanupAllChildren().then(resolveShutdown, rejectShutdown);
  } catch (error) {
    rejectShutdown(error);
  }
  return runnerShutdownPromise;
}

function assertRunnerAccepting(): void {
  if (!runnerAccepting) {
    throw new RelayFailure("CANCELLED", "Relay is shutting down and cannot accept new delegation tasks");
  }
}

function cleanupDiagnostics(
  workerState: "not-attempted" | "pending" | "created" | "failed",
  termination: TerminationReport | undefined,
  leaseErrors: readonly RelayFailure[],
  unexpectedError: unknown,
  hasUnexpectedError: boolean,
): CleanupDiagnostic[] {
  const diagnostics: CleanupDiagnostic[] = [];
  if ((workerState === "pending" || workerState === "created") && termination?.confirmed !== true) {
    diagnostics.push({
      code: "PROCESS_CLEANUP_FAILED",
      message: boundedString(
        `Cannot confirm worker process-tree cleanup: ${termination?.reason ?? "unknown cleanup failure"}`,
        CLEANUP_DIAGNOSTIC_BYTES,
      ),
    });
  }
  for (const failure of leaseErrors) {
    diagnostics.push({
      code: failure.code === "LOCK_OWNERSHIP_LOST" ? "LOCK_OWNERSHIP_LOST" : "LOCK_IO",
      message: boundedString(failure.message, CLEANUP_DIAGNOSTIC_BYTES),
    });
  }
  if (hasUnexpectedError) {
    diagnostics.push({
      code: "INTERNAL",
      message: boundedString(
        `Unexpected task cleanup failure: ${unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError)}`,
        CLEANUP_DIAGNOSTIC_BYTES,
      ),
    });
  }
  return dedupeDiagnostics(diagnostics);
}

function dedupeDiagnostics(diagnostics: readonly CleanupDiagnostic[]): CleanupDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.code}\u0000${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function boundCleanupDiagnostics(diagnostics: readonly CleanupDiagnostic[]): {
  diagnostics: CleanupDiagnostic[];
  omittedCount: number;
  truncated: boolean;
} {
  const result: CleanupDiagnostic[] = [];
  let bytes = 0;
  let truncated = false;
  for (const diagnostic of diagnostics) {
    if (result.length >= CLEANUP_DIAGNOSTIC_LIMIT) break;
    const prefixBytes = Buffer.byteLength(diagnostic.code) + 2;
    const remaining = CLEANUP_DIAGNOSTIC_BYTES - bytes - prefixBytes;
    if (remaining <= 0) break;
    const message = boundedString(diagnostic.message, remaining);
    truncated ||= message !== diagnostic.message;
    result.push({ ...diagnostic, message });
    bytes += prefixBytes + Buffer.byteLength(message);
  }
  const omittedCount = diagnostics.length - result.length;
  return { diagnostics: result, omittedCount, truncated: truncated || omittedCount > 0 };
}

function cleanupAggregateMessage(
  taskCount: number,
  failureCount: number,
  primaryCode: CleanupFailureCode,
  diagnostics: readonly CleanupDiagnostic[],
  omittedCount: number,
  truncated: boolean,
): string {
  const header = `Cleanup failed for ${failureCount} of ${taskCount} active task${taskCount === 1 ? "" : "s"}`
    + ` (primary ${primaryCode})`;
  const rawDetails = diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ");
  const initiallyAvailable = Math.max(0, CLEANUP_DIAGNOSTIC_BYTES - Buffer.byteLength(header) - 2);
  const actuallyTruncated = truncated || Buffer.byteLength(rawDetails) > initiallyAvailable;
  const footer = actuallyTruncated
    ? `; diagnostics truncated${omittedCount > 0 ? `; ${omittedCount} omitted` : ""}`
    : "";
  const available = Math.max(0, CLEANUP_DIAGNOSTIC_BYTES - Buffer.byteLength(header) - Buffer.byteLength(footer) - 2);
  const details = boundedString(rawDetails, available);
  return `${header}${details ? `: ${details}` : ""}${footer}`;
}
