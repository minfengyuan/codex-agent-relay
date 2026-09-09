import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { z } from "zod";
import type { RelayConfig } from "./config.js";
import type { SessionRecord, SessionStore } from "./store.js";
import {
  RelayFailure,
  type CursorDelegateInput,
  type CursorMode,
  type DelegateInput,
  type ImageSummary,
  type InteractionSummary,
  type RelayResult,
  type SubagentSummary,
  type TodoSummary,
  type ToolCallSummary,
} from "./types.js";

export type ProgressReporter = (message: string) => Promise<void> | void;

type RunnerInput = CursorDelegateInput;
type Provider = "grok" | "cursor";
type ActiveChild = { child: ChildProcessWithoutNullStreams; sessionId: string | null; cancel: () => Promise<void> };
type ActiveTask = { cancel: () => Promise<void>; settled: Promise<void>; resolveSettled: () => void };

type ProviderAdapter = {
  provider: Provider;
  displayName: string;
  command(input: RunnerInput, record?: SessionRecord): { command: string; args: string[] };
  authenticate(initialized: acp.InitializeResponse): string;
  capabilities: acp.ClientCapabilities;
  prompt(task: string): string;
  sessionMetadata(input: RunnerInput, record?: SessionRecord): Pick<SessionRecord, "model" | "mode">;
};

const activeTasks = new Set<ActiveTask>();
const todoStatus = z.enum(["pending", "in_progress", "completed", "cancelled"]);
const askQuestionRequest = z.object({
  toolCallId: z.string(),
  title: z.string().optional(),
  questions: z.array(z.object({
    id: z.string(),
    prompt: z.string(),
    options: z.array(z.object({ id: z.string(), label: z.string() })),
    allowMultiple: z.boolean().optional(),
  })),
});
const createPlanRequest = z.object({
  toolCallId: z.string(),
  name: z.string().optional(),
  overview: z.string().optional(),
  plan: z.string(),
  todos: z.array(z.object({ id: z.string(), content: z.string(), status: todoStatus })),
  isProject: z.boolean().optional(),
  phases: z.array(z.object({
    name: z.string(),
    todos: z.array(z.object({ id: z.string(), content: z.string(), status: todoStatus })),
  })).optional(),
});
const updateTodosRequest = z.object({
  toolCallId: z.string(),
  todos: z.array(z.object({ id: z.string(), content: z.string(), status: todoStatus })),
  merge: z.boolean(),
});
const cursorTaskRequest = z.object({
  toolCallId: z.string(),
  description: z.string(),
  prompt: z.string(),
  subagentType: z.union([z.string(), z.object({ custom: z.string() })]),
  model: z.string().optional(),
  agentId: z.string().optional(),
  durationMs: z.number().optional(),
});
const generateImageRequest = z.object({
  toolCallId: z.string(),
  description: z.string(),
  filePath: z.string().optional(),
  referenceImagePaths: z.array(z.string()).optional(),
});

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
  return Boolean(capabilities && typeof capabilities === "object"
    && (capabilities as { loadSession?: unknown }).loadSession === true);
}

function abortFailure(signal: AbortSignal): never {
  if (signal.reason instanceof RelayFailure) throw signal.reason;
  throw new RelayFailure("CANCELLED", "MCP request was cancelled");
}

function authMethodIds(response: acp.InitializeResponse): string[] {
  return (response.authMethods ?? []).map((method) => method.id);
}

function boundedString(value: string, limitBytes: number): string {
  return appendLimited("", value, limitBytes).value;
}

function boundedJson(value: unknown, limitBytes: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return boundedString(JSON.stringify(value), limitBytes);
  } catch {
    return "[unserializable]";
  }
}

function jsonSize(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try { return Buffer.byteLength(JSON.stringify(value)); } catch { return Number.POSITIVE_INFINITY; }
}

function permissionSummary(toolCall: acp.RequestPermissionRequest["toolCall"]): string {
  const parts = [`Permission requested for ${boundedString(toolCall.title ?? toolCall.name ?? toolCall.toolCallId, 256)}`];
  const rawInput = boundedJson(toolCall.rawInput, 1_024);
  const locations = boundedJson(toolCall.locations, 1_024);
  if (rawInput) parts.push(`input=${rawInput}`);
  if (locations) parts.push(`locations=${locations}`);
  return boundedString(parts.join("; "), 2_560);
}

class CursorSummaries {
  readonly toolCalls: ToolCallSummary[] = [];
  readonly todos: TodoSummary[] = [];
  readonly subagents: SubagentSummary[] = [];
  readonly interactions: InteractionSummary[] = [];
  readonly images: ImageSummary[] = [];
  truncated = false;

  constructor(private readonly limitBytes: number) {}

  add<T>(target: T[], value: T): void {
    target.push(value);
    if (Buffer.byteLength(JSON.stringify({ ...this.result(), summariesTruncated: true })) > this.limitBytes) {
      target.pop();
      this.truncated = true;
    }
  }

  addCritical<T>(target: T[], value: T): void {
    const removable: unknown[][] = [this.toolCalls, this.todos, this.subagents, this.images, this.interactions];
    target.push(value);
    while (Buffer.byteLength(JSON.stringify({ ...this.result(), summariesTruncated: true })) > this.limitBytes) {
      const source = removable.find((items) => items.length > (items === target ? 1 : 0));
      if (!source) {
        target.pop();
        this.truncated = true;
        return;
      }
      source.shift();
      this.truncated = true;
    }
  }

  markTruncated(): void {
    this.truncated = true;
  }

  replaceTodos(todos: TodoSummary[], merge: boolean): void {
    const next = merge ? new Map(this.todos.map((todo) => [todo.id, todo])) : new Map<string, TodoSummary>();
    for (const todo of todos) next.set(todo.id, todo);
    this.todos.splice(0);
    for (const todo of next.values()) this.add(this.todos, todo);
  }

  result(): Pick<RelayResult, "provider" | "toolCalls" | "todos" | "subagents" | "interactions" | "images" | "summariesTruncated"> {
    return {
      provider: "cursor",
      ...(this.toolCalls.length ? { toolCalls: this.toolCalls } : {}),
      ...(this.todos.length ? { todos: this.todos } : {}),
      ...(this.subagents.length ? { subagents: this.subagents } : {}),
      ...(this.interactions.length ? { interactions: this.interactions } : {}),
      ...(this.images.length ? { images: this.images } : {}),
      ...(this.truncated ? { summariesTruncated: true } : {}),
    };
  }
}

class AcpRunner {
  constructor(
    private readonly config: RelayConfig,
    private readonly store: SessionStore,
    private readonly adapter: ProviderAdapter,
  ) {}

  async delegate(input: RunnerInput, signal?: AbortSignal, reportProgress?: ProgressReporter): Promise<RelayResult> {
    if (process.env.GROK_RELAY_DELEGATED === "1") {
      throw new RelayFailure("NESTED_DELEGATION", "Delegation is disabled inside a delegated worker process");
    }
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
    let active: ActiveChild | undefined;
    let operation: Promise<string> | undefined;
    let completedResult: RelayResult | undefined;
    let pendingError: RelayFailure | undefined;
    let releaseError: unknown;
    const summaries = new CursorSummaries(Math.max(64 * 1_024, this.config.textLimitBytes));
    const cursorFields = (): Partial<RelayResult> => this.adapter.provider === "cursor" ? summaries.result() : {};
    const partial = (): Partial<RelayResult> => ({ sessionId, text, truncated: truncated || summaries.truncated, ...cursorFields() });
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
      child = spawn(invocation.command, invocation.args, {
        cwd,
        env: { ...process.env, GROK_RELAY_DELEGATED: "1" },
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
      }), this.config.phaseTimeoutMs, "SPAWN_TIMEOUT", `Timed out starting ${this.adapter.displayName}`);
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
      let app = acp.client({ name: "codex-grok-relay" })
        .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
          permissionRequested = true;
          if (this.adapter.provider === "cursor") {
            const reject = params.options.find((option) => option.kind === "reject_once");
            const permissionDetail = permissionSummary(params.toolCall);
            if (Buffer.byteLength(params.toolCall.toolCallId) > 256
              || Buffer.byteLength(params.toolCall.title ?? "") > 256
              || jsonSize(params.toolCall.rawInput) > 1_024
              || jsonSize(params.toolCall.locations) > 1_024) {
              summaries.markTruncated();
            }
            summaries.addCritical(summaries.interactions, {
              type: "permission",
              toolCallId: boundedString(params.toolCall.toolCallId, 256),
              ...(params.toolCall.title ? { title: boundedString(params.toolCall.title, 256) } : {}),
              summary: permissionDetail,
              outcome: "rejected",
            });
            const permissionLabel = boundedString(params.toolCall.title ?? params.toolCall.toolCallId, 256);
            permissionFailure = new RelayFailure(
              "PERMISSION_REQUIRED",
              reject
                ? `Cursor permission was rejected: ${permissionLabel}`
                : `Cursor requested permission without a reject_once option: ${permissionLabel}`,
              partial(),
            );
            setImmediate(() => totalAbort.abort(permissionFailure));
            return reject
              ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } }
              : { outcome: { outcome: "cancelled" as const } };
          }
          queueMicrotask(() => totalAbort.abort(new RelayFailure(
            "UNEXPECTED_PERMISSION",
            "Grok requested permission despite --always-approve",
            partial(),
          )));
          return { outcome: { outcome: "cancelled" as const } };
        })
        .onNotification(acp.methods.client.session.update, async ({ params }) => {
          if (!promptStarted || params.sessionId !== sessionId) return;
          const update = params.update;
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            const appended = appendLimited(text, update.content.text, this.config.textLimitBytes);
            text = appended.value;
            truncated ||= appended.truncated;
          } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            if (this.adapter.provider === "cursor") {
              summaries.add(summaries.toolCalls, {
                toolCallId: update.toolCallId,
                ...(update.title ? { title: update.title } : {}),
                ...(update.status ? { status: update.status } : {}),
              });
            }
            if (reportProgress) {
              const now = Date.now();
              if (now - lastProgress >= this.config.progressIntervalMs) {
                lastProgress = now;
                await reportProgress(update.title ?? `${this.adapter.displayName} is using a tool`);
              }
            }
          }
        });

      if (this.adapter.provider === "cursor") {
        app = app
          .onRequest("cursor/ask_question", (value) => askQuestionRequest.parse(value), ({ params }) => {
            summaries.add(summaries.interactions, {
              type: "question",
              toolCallId: params.toolCallId,
              ...(params.title ? { title: params.title } : {}),
              summary: params.questions.map((question) => question.prompt).join("; "),
              outcome: "skipped",
            });
            return { outcome: { outcome: "skipped", reason: "No interactive UI is available" } };
          })
          .onRequest("cursor/create_plan", (value) => createPlanRequest.parse(value), ({ params }) => {
            summaries.add(summaries.interactions, {
              type: "plan",
              toolCallId: params.toolCallId,
              ...(params.name ? { title: params.name } : {}),
              summary: params.overview ?? params.plan,
              outcome: "rejected",
            });
            return { outcome: { outcome: "rejected", reason: "Plan approval is unavailable in delegated execution" } };
          })
          .onNotification("cursor/update_todos", (value) => updateTodosRequest.parse(value), ({ params }) => {
            summaries.replaceTodos(params.todos, params.merge);
          })
          .onNotification("cursor/task", (value) => cursorTaskRequest.parse(value), ({ params }) => {
            summaries.add(summaries.subagents, {
              toolCallId: params.toolCallId,
              description: params.description,
              subagentType: typeof params.subagentType === "string" ? params.subagentType : params.subagentType.custom,
              ...(params.model ? { model: params.model } : {}),
              ...(params.agentId ? { agentId: params.agentId } : {}),
              ...(params.durationMs === undefined ? {} : { durationMs: params.durationMs }),
            });
          })
          .onNotification("cursor/generate_image", (value) => generateImageRequest.parse(value), ({ params }) => {
            summaries.add(summaries.images, {
              toolCallId: params.toolCallId,
              description: params.description,
              ...(params.filePath ? { filePath: params.filePath } : {}),
              referenceImageCount: params.referenceImagePaths?.length ?? 0,
            });
          });
      }

      operation = app.connectWith(stream, async (ctx) => {
        clientContext = ctx;
        if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
        const initialized = await withTimeout(ctx.request(acp.methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: this.adapter.capabilities,
          clientInfo: { name: "codex-grok-relay", version: "0.1.0" },
        }), this.config.phaseTimeoutMs, "INITIALIZE_TIMEOUT", `${this.adapter.displayName} initialize timed out`);
        if (initialized.protocolVersion !== 1) {
          throw new RelayFailure("PROTOCOL_MISMATCH", `${this.adapter.displayName} returned ACP protocol ${initialized.protocolVersion}`);
        }
        const authMethod = this.adapter.authenticate(initialized);
        if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
        await withTimeout(ctx.request(acp.methods.agent.authenticate, {
          methodId: authMethod,
          ...(this.adapter.provider === "grok" ? { _meta: { headless: true } } : {}),
        }), this.config.phaseTimeoutMs, "AUTH_TIMEOUT", `${this.adapter.displayName} authentication timed out`);

        if (record) {
          if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
          if (!hasLoadCapability(initialized.agentCapabilities)) {
            throw new RelayFailure("LOAD_UNSUPPORTED", `${this.adapter.displayName} did not advertise loadSession capability`);
          }
          const loaded = await withTimeout(ctx.request(acp.methods.agent.session.load, {
            sessionId: record.sessionId,
            cwd,
            mcpServers: [],
          }), this.config.phaseTimeoutMs, "LOAD_TIMEOUT", `${this.adapter.displayName} session load timed out`);
          await this.ensureCursorMode(ctx, loaded.modes, metadata.mode, record.sessionId);
        } else {
          if (totalAbort.signal.aborted) abortFailure(totalAbort.signal);
          const created = await withTimeout(ctx.request(acp.methods.agent.session.new, {
            cwd,
            mcpServers: [],
          }), this.config.phaseTimeoutMs, "NEW_SESSION_TIMEOUT", `${this.adapter.displayName} session creation timed out`);
          sessionId = created.sessionId;
          if (!sessionId) throw new RelayFailure("INVALID_SESSION", `${this.adapter.displayName} returned an empty sessionId`);
          if (active) active.sessionId = sessionId;
          await this.ensureCursorMode(ctx, created.modes, metadata.mode, sessionId);
          await this.store.writeNew(sessionId, cwd, metadata);
        }

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
      completedResult = { sessionId, stopReason, text, truncated: truncated || summaries.truncated, ...cursorFields() };
    } catch (error) {
      if ((totalAbort.signal.aborted || permissionRequested) && active) {
        await active.cancel().catch(() => undefined);
        if (operation) await Promise.race([operation.catch(() => undefined), delay(this.config.termGraceMs)]);
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
      pendingError = new RelayFailure(failure.code, failure.message, { ...partial(), ...failure.partial });
    } finally {
      clearTimeout(totalTimer);
      signal?.removeEventListener("abort", onCallerAbort);
      if (active) await this.terminate(active.child).catch(() => undefined);
      else if (child) await this.terminate(child).catch(() => undefined);
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
      throw new RelayFailure(failure.code, failure.message, partial());
    }
    if (pendingError) throw pendingError;
    if (!completedResult) throw new RelayFailure("INTERNAL", `${this.adapter.displayName} task ended without a result`, partial());
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

  private async ensureCursorMode(
    ctx: acp.ClientContext,
    modes: acp.SessionModeState | null | undefined,
    requested: CursorMode | undefined,
    sessionId: string,
  ): Promise<void> {
    if (this.adapter.provider !== "cursor" || !requested) return;
    if (!modes) {
      if (requested === "ask") {
        throw new RelayFailure("MODE_UNAVAILABLE", "Cursor did not report session modes needed to verify ask mode");
      }
      return;
    }
    if (modes.currentModeId === requested) return;
    if (!modes.availableModes.some((mode) => mode.id === requested)) {
      throw new RelayFailure("MODE_UNAVAILABLE", `Cursor does not offer ${requested} mode for this session`);
    }
    await withTimeout(
      ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: requested }),
      this.config.phaseTimeoutMs,
      "MODE_TIMEOUT",
      `Cursor ${requested} mode selection timed out`,
    );
  }
}

function grokAdapter(config: RelayConfig): ProviderAdapter {
  return {
    provider: "grok",
    displayName: "Grok",
    command: () => ({ command: config.command, args: config.commandArgs }),
    authenticate(initialized) {
      const authIds = authMethodIds(initialized);
      const preferred = process.env.XAI_API_KEY && authIds.includes("xai.api_key")
        ? "xai.api_key"
        : authIds.includes("cached_token") ? "cached_token" : undefined;
      if (!preferred) {
        throw new RelayFailure("AUTH_UNAVAILABLE", "No non-interactive Grok authentication is available (xai.api_key or cached_token)");
      }
      return preferred;
    },
    capabilities: {},
    prompt: (task) => task,
    sessionMetadata: () => ({}),
  };
}

function cursorAdapter(config: RelayConfig): ProviderAdapter {
  return {
    provider: "cursor",
    displayName: "Cursor",
    command(input, record) {
      const command = config.cursorCommand?.trim();
      if (!command) {
        throw new RelayFailure("CURSOR_COMMAND_REQUIRED", "GROK_RELAY_CURSOR_COMMAND must name the Cursor CLI executable");
      }
      const metadata = this.sessionMetadata(input, record);
      const args = ["--sandbox", "enabled"];
      if (metadata.model) args.push("--model", metadata.model);
      if (metadata.mode === "ask") args.push("--mode", "ask");
      args.push("acp");
      return { command, args };
    },
    authenticate(initialized) {
      if (!authMethodIds(initialized).includes("cursor_login")) {
        throw new RelayFailure("AUTH_UNAVAILABLE", "Cursor did not advertise non-interactive cursor_login authentication");
      }
      return "cursor_login";
    },
    capabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    prompt: (task) => `Work non-interactively. Resolve minor ambiguity conservatively. If a major decision is required, stop and report it.\n\n${task}`,
    sessionMetadata(input, record) {
      if (record && record.mode === undefined) {
        throw new RelayFailure("CORRUPT_SESSION", `Cursor session record has no mode: ${record.sessionId}`);
      }
      const mode: CursorMode = input.mode ?? record?.mode ?? "agent";
      const model = input.model ?? record?.model;
      if (record && input.mode !== undefined && input.mode !== record.mode) {
        throw new RelayFailure("SESSION_OPTION_CONFLICT", `Cursor session mode is ${record.mode ?? "agent"}, not ${input.mode}`);
      }
      if (record && input.model !== undefined && input.model !== record.model) {
        throw new RelayFailure("SESSION_OPTION_CONFLICT", `Cursor session model is ${record.model ?? "the CLI default"}, not ${input.model}`);
      }
      return { mode, ...(model ? { model } : {}) };
    },
  };
}

export class GrokRunner extends AcpRunner {
  constructor(config: RelayConfig, store: SessionStore) {
    super(config, store, grokAdapter(config));
  }

  override delegate(input: DelegateInput, signal?: AbortSignal, reportProgress?: ProgressReporter): Promise<RelayResult> {
    return super.delegate(input, signal, reportProgress);
  }
}

export class CursorRunner extends AcpRunner {
  constructor(config: RelayConfig, store: SessionStore) {
    super(config, store, cursorAdapter(config));
  }
}

export async function cleanupAllChildren(): Promise<void> {
  const entries = [...activeTasks];
  await Promise.allSettled(entries.map((entry) => entry.cancel()));
  await Promise.allSettled(entries.map((entry) => entry.settled));
}
