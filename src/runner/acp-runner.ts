import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { RelayConfig } from "../config.js";
import type { SessionStore } from "../store.js";
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
type ActiveTask = { cancel: () => Promise<void>; settled: Promise<void>; resolveSettled: () => void };

const activeTasks = new Set<ActiveTask>();

export class AcpRunner<I extends DelegateInput, R extends RelayResult> {
  constructor(
    private readonly config: RelayConfig,
    private readonly store: SessionStore,
    private readonly adapter: ProviderAdapter<I, R>,
  ) {}

  async delegate(input: I, signal?: AbortSignal, reportProgress?: ProgressReporter): Promise<R> {
    if (process.env.CODEX_AGENT_RELAY_DELEGATED === "1") {
      throw new RelayFailure("NESTED_DELEGATION", "Delegation is disabled inside a delegated worker process");
    }
    this.adapter.validateInput?.(input);
    if (signal?.aborted) abortFailure(signal);
    const cwd = input.cwd;
    let release: (() => Promise<void>) | undefined;
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
    let releaseError: unknown;
    let cleanupReport: TerminationReport | undefined;
    const summarizer = this.adapter.createSummarizer(Math.max(64 * 1_024, this.config.textLimitBytes));
    const partial = (): Partial<R> => ({
      sessionId,
      text,
      truncated: truncated || summarizer.truncated,
      ...summarizer.result(),
    });
    const totalAbort = new AbortController();
    let resolveSettled: () => void = () => {};
    const taskEntry: ActiveTask = {
      cancel: async () => {
        totalAbort.abort(new RelayFailure("CANCELLED", "Relay is shutting down"));
        if (active) await active.cancel().catch(() => undefined);
        else if (processTree) await processTree.terminate().catch(() => undefined);
      },
      settled: new Promise<void>((resolve) => { resolveSettled = resolve; }),
      resolveSettled: () => resolveSettled(),
    };
    activeTasks.add(taskEntry);
    const totalTimer = setTimeout(() => totalAbort.abort(new RelayFailure(
      "TIMEOUT",
      `${this.adapter.displayName} task exceeded the ${this.config.totalTimeoutMs / 1000} second limit`,
    )), this.config.totalTimeoutMs);
    const onCallerAbort = () => totalAbort.abort(new RelayFailure("CANCELLED", "MCP request was cancelled"));
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (signal?.aborted) onCallerAbort();

    try {
      release = await this.store.acquire(cwd);
      if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
      const record = input.sessionId ? await this.store.read(input.sessionId, cwd) : undefined;
      const metadata = this.adapter.sessionMetadata(input, record);
      if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
      const invocation = this.adapter.command(input, record);
      const childEnv = { ...process.env, CODEX_AGENT_RELAY_DELEGATED: "1" };
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
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        const joined = stderr + chunk;
        const bytes = Buffer.from(joined);
        stderr = bytes.length > this.config.stderrLimitBytes
          ? bytes.subarray(bytes.length - this.config.stderrLimitBytes).toString("utf8")
          : joined;
      });
      await withTimeout(new Promise<void>((resolve, reject) => {
        child?.once("spawn", () => { worker.state = "created"; resolve(); });
        child?.once("error", (error) => {
          worker.state = processTree?.reference() ? "created" : "failed";
          reject(error);
        });
      }), this.config.phaseTimeoutMs, "SPAWN_TIMEOUT", `Timed out starting ${this.adapter.displayName}`);
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
      pendingError = new RelayFailure(failure.code, failure.message, {
        ...partial(),
        ...(failure.partial ?? {}),
      } as Partial<R>);
    } finally {
      clearTimeout(totalTimer);
      signal?.removeEventListener("abort", onCallerAbort);
      try {
        if (worker.state === "created" || worker.state === "pending") {
          try {
            cleanupReport = processTree
              ? await processTree.terminate()
              : { forced: false, confirmed: false, reason: "The worker process tree controller is unavailable" };
          } catch (error) {
            cleanupReport = { forced: false, confirmed: false, reason: String(error) };
          }
        }
        if (worker.state === "not-attempted" || worker.state === "failed" || cleanupReport?.confirmed) {
          try {
            await release?.();
          } catch (error) {
            releaseError = error;
          }
        }
      } finally {
        activeTasks.delete(taskEntry);
        taskEntry.resolveSettled();
      }
    }
    if ((worker.state === "created" || worker.state === "pending") && !cleanupReport?.confirmed) {
      const prior = pendingError ? `; original error ${pendingError.code}: ${pendingError.message}` : "";
      throw new RelayFailure(
        "PROCESS_CLEANUP_FAILED",
        boundedString(
          `Cannot confirm worker process-tree cleanup: ${cleanupReport?.reason ?? "unknown cleanup failure"}${prior}`,
          Math.min(this.config.stderrLimitBytes, 8 * 1_024),
        ),
        { ...partial(), ...(pendingError?.partial ?? {}) } as Partial<R>,
      );
    }
    if (releaseError) {
      const failure = releaseError instanceof RelayFailure
        ? releaseError
        : new RelayFailure("LOCK_IO", `Cannot release cwd lock: ${String(releaseError)}`);
      throw new RelayFailure(failure.code, failure.message, partial());
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

export async function cleanupAllChildren(): Promise<void> {
  const entries = [...activeTasks];
  await Promise.allSettled(entries.map((entry) => entry.cancel()));
  await Promise.allSettled(entries.map((entry) => entry.settled));
}
