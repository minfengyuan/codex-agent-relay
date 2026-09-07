import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { RelayConfig } from "./config.js";
import type { SessionStore } from "./store.js";
import { RelayFailure, type DelegateInput, type RelayResult } from "./types.js";

export type ProgressReporter = (message: string) => Promise<void> | void;

type ActiveChild = {
  child: ChildProcessWithoutNullStreams;
  sessionId: string | null;
  cancel: () => Promise<void>;
};

type ActiveTask = {
  cancel: () => Promise<void>;
  settled: Promise<void>;
  resolveSettled: () => void;
};

const activeTasks = new Set<ActiveTask>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, code: string, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new RelayFailure(code, message)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function appendLimited(current: string, chunk: string, limit: number): { value: string; truncated: boolean } {
  const used = Buffer.byteLength(current);
  if (used >= limit) return { value: current, truncated: chunk.length > 0 };
  const bytes = Buffer.from(chunk);
  if (bytes.length <= limit - used) return { value: current + chunk, truncated: false };
  const remaining = limit - used;
  let end = remaining;
  let suffix = bytes.subarray(0, end).toString("utf8");
  while (end > 0 && (suffix.endsWith("�") || Buffer.byteLength(suffix) > remaining)) {
    end -= 1;
    suffix = bytes.subarray(0, end).toString("utf8");
  }
  return { value: current + suffix, truncated: true };
}

function hasLoadCapability(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== "object") return false;
  return (capabilities as { loadSession?: unknown }).loadSession === true;
}

function abortFailure(signal: AbortSignal): never {
  if (signal.reason instanceof RelayFailure) throw signal.reason;
  throw new RelayFailure("CANCELLED", "MCP request was cancelled");
}

function authMethodIds(response: acp.InitializeResponse): string[] {
  return (response.authMethods ?? []).map((method) => method.id);
}

export class GrokRunner {
  constructor(
    private readonly config: RelayConfig,
    private readonly store: SessionStore,
  ) {}

  async delegate(input: DelegateInput, signal?: AbortSignal, reportProgress?: ProgressReporter): Promise<RelayResult> {
    if (signal?.aborted) abortFailure(signal);
    const cwd = input.cwd;
    let release: (() => Promise<void>) | undefined;
    let sessionId: string | null = input.sessionId ?? null;
    let text = "";
    let truncated = false;
    let stderr = "";
    let permissionRequested = false;
    let promptStarted = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    let active: ActiveChild | undefined;
    let operation: Promise<string> | undefined;
    let completedResult: RelayResult | undefined;
    let pendingError: RelayFailure | undefined;
    let releaseError: unknown;
    const totalAbort = new AbortController();
    let resolveSettled: () => void = () => {};
    const taskEntry: ActiveTask = {
      cancel: async () => {
        totalAbort.abort(new RelayFailure("CANCELLED", "Relay is shutting down"));
        if (active) await active.cancel().catch(() => undefined);
        else if (child) await this.terminate(child).catch(() => undefined);
      },
      settled: new Promise<void>((resolve) => { resolveSettled = resolve; }),
      resolveSettled: () => resolveSettled(),
    };
    activeTasks.add(taskEntry);
    const totalTimer = setTimeout(() => totalAbort.abort(new RelayFailure("TIMEOUT", "Grok task exceeded the 3600 second limit")), this.config.totalTimeoutMs);
    const onCallerAbort = () => totalAbort.abort(new RelayFailure("CANCELLED", "MCP request was cancelled"));
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (signal?.aborted) onCallerAbort();

    try {
      release = await this.store.acquire(cwd);
      if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
      const record = input.sessionId ? await this.store.read(input.sessionId, cwd) : undefined;
      if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
      child = spawn(this.config.command, this.config.commandArgs, {
        cwd,
        env: process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
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
        child?.once("spawn", resolve);
        child?.once("error", reject);
      }), this.config.phaseTimeoutMs, "SPAWN_TIMEOUT", "Timed out starting Grok");
      if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);

      let clientContext: acp.ClientContext | undefined;
      const cancelChild = async (): Promise<void> => {
        if (clientContext && sessionId) {
          await Promise.race([
            (async () => {
              await clientContext.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => undefined);
              if (child?.exitCode !== null || child.signalCode !== null) return;
              await new Promise<void>((resolve) => child?.once("exit", () => resolve()));
            })(),
            delay(this.config.cancelGraceMs),
          ]);
        }
        await this.terminate(child as ChildProcessWithoutNullStreams);
      };
      active = { child, sessionId, cancel: cancelChild };

      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      let lastProgress = 0;
      const app = acp.client({ name: "codex-grok-relay" })
        .onRequest(acp.methods.client.session.requestPermission, () => {
          permissionRequested = true;
          queueMicrotask(() => totalAbort.abort(new RelayFailure(
            "UNEXPECTED_PERMISSION",
            "Grok requested permission despite --always-approve",
            { sessionId, text, truncated },
          )));
          return { outcome: { outcome: "cancelled" } };
        })
        .onNotification(acp.methods.client.session.update, async ({ params }) => {
          if (!promptStarted || params.sessionId !== sessionId) return;
          const update = params.update;
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            const appended = appendLimited(text, update.content.text, this.config.textLimitBytes);
            text = appended.value;
            truncated ||= appended.truncated;
          } else if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && reportProgress) {
            const now = Date.now();
            if (now - lastProgress >= this.config.progressIntervalMs) {
              lastProgress = now;
              await reportProgress(update.title ?? "Grok is using a tool");
            }
          }
        });

      operation = app.connectWith(stream, async (ctx) => {
        clientContext = ctx;
        if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
        const initialized = await withTimeout(ctx.request(acp.methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "codex-grok-relay", version: "0.1.0" },
        }), this.config.phaseTimeoutMs, "INITIALIZE_TIMEOUT", "Grok initialize timed out");
        if (initialized.protocolVersion !== 1) {
          throw new RelayFailure("PROTOCOL_MISMATCH", `Grok returned ACP protocol ${initialized.protocolVersion}`);
        }
        const authIds = authMethodIds(initialized);
        const preferred = process.env.XAI_API_KEY && authIds.includes("xai.api_key")
          ? "xai.api_key"
          : authIds.includes("cached_token") ? "cached_token" : undefined;
        if (!preferred) {
          throw new RelayFailure("AUTH_UNAVAILABLE", "No non-interactive Grok authentication is available (xai.api_key or cached_token)");
        }
        if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
        await withTimeout(ctx.request(acp.methods.agent.authenticate, {
          methodId: preferred,
          _meta: { headless: true },
        }), this.config.phaseTimeoutMs, "AUTH_TIMEOUT", "Grok authentication timed out");

        if (record) {
          if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
          if (!hasLoadCapability(initialized.agentCapabilities)) {
            throw new RelayFailure("LOAD_UNSUPPORTED", "Grok did not advertise loadSession capability");
          }
          await withTimeout(ctx.request(acp.methods.agent.session.load, {
            sessionId: record.sessionId,
            cwd,
            mcpServers: [],
          }), this.config.phaseTimeoutMs, "LOAD_TIMEOUT", "Grok session load timed out");
        } else {
          if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
          const created = await withTimeout(ctx.request(acp.methods.agent.session.new, {
            cwd,
            mcpServers: [],
          }), this.config.phaseTimeoutMs, "NEW_SESSION_TIMEOUT", "Grok session creation timed out");
          sessionId = created.sessionId;
          if (!sessionId) throw new RelayFailure("INVALID_SESSION", "Grok returned an empty sessionId");
          if (active) active.sessionId = sessionId;
          await this.store.writeNew(sessionId, cwd);
        }

        promptStarted = true;
        if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
        const response = await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: sessionId as string,
          prompt: [{ type: "text", text: input.task }],
        });
        if (permissionRequested) {
          throw new RelayFailure("UNEXPECTED_PERMISSION", "Grok requested permission despite --always-approve", { sessionId, text, truncated });
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
      completedResult = { sessionId, stopReason, text, truncated };
    } catch (error) {
      if (totalAbort.signal.aborted && active) {
        await active.cancel().catch(() => undefined);
        if (operation) await Promise.race([operation.catch(() => undefined), delay(this.config.termGraceMs)]);
      }
      const effectiveError = totalAbort.signal.aborted && totalAbort.signal.reason instanceof RelayFailure
        ? totalAbort.signal.reason
        : error;
      const failure = effectiveError instanceof RelayFailure
        ? effectiveError
        : new RelayFailure("ACP_FAILURE", `${effectiveError instanceof Error ? effectiveError.message : String(effectiveError)}${stderr ? `; Grok stderr: ${stderr}` : ""}`);
      pendingError = new RelayFailure(failure.code, failure.message, {
        sessionId,
        text,
        truncated,
        ...failure.partial,
      });
    } finally {
      clearTimeout(totalTimer);
      signal?.removeEventListener("abort", onCallerAbort);
      if (active) {
        await this.terminate(active.child).catch(() => undefined);
      } else if (child) {
        await this.terminate(child).catch(() => undefined);
      }
      try {
        await release?.();
      } catch (error) {
        releaseError = error;
      } finally {
        activeTasks.delete(taskEntry);
        taskEntry.resolveSettled();
      }
    }
    if (releaseError) {
      const failure = releaseError instanceof RelayFailure
        ? releaseError
        : new RelayFailure("LOCK_IO", `Cannot release cwd lock: ${String(releaseError)}`);
      throw new RelayFailure(failure.code, failure.message, { sessionId, text, truncated });
    }
    if (pendingError) throw pendingError;
    if (!completedResult) throw new RelayFailure("INTERNAL", "Grok task ended without a result", { sessionId, text, truncated });
    return completedResult;
  }

  private async terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await delay(this.config.termGraceMs);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      return;
    }
    const group = -child.pid;
    try { process.kill(group, "SIGTERM"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    const deadline = Date.now() + this.config.termGraceMs;
    while (Date.now() < deadline) {
      try { process.kill(group, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      }
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    }
    try { process.kill(group, "SIGKILL"); } catch { /* group exited */ }
  }
}

export async function cleanupAllChildren(): Promise<void> {
  const entries = [...activeTasks];
  await Promise.allSettled(entries.map((entry) => entry.cancel()));
  await Promise.allSettled(entries.map((entry) => entry.settled));
}
