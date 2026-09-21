import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { RelayConfig } from "./config.js";
import { SessionStore, resolveCwd } from "./store.js";
import { CursorRunner, DshRunner, GrokRunner, OpenCodeRunner, type ProgressReporter } from "./runner.js";
import {
  RelayFailure,
  type CursorRelayResult,
  type DshRelayResult,
  type GrokRelayResult,
  type OpenCodeRelayResult,
  type RelayResult,
  type RelayResultPartial,
} from "./types.js";

const grokInputSchema = z.object({
  task: z.string().trim().min(1).describe("Task for Grok"),
  cwd: z.string().min(1).describe("Existing absolute working directory"),
  sessionId: z.string().min(1).optional().describe("Previously returned Grok session ID"),
});

const cursorInputSchema = z.object({
  task: z.string().trim().min(1).describe("Task for Cursor"),
  cwd: z.string().min(1).describe("Existing absolute working directory"),
  sessionId: z.string().min(1).optional().describe("Previously returned Cursor session ID"),
  model: z.string().trim().min(1).optional().describe("Cursor model for a new session"),
  mode: z.enum(["agent", "ask"]).optional().describe("Cursor mode for a new session; defaults to agent"),
});

const openCodeInputSchema = z.object({
  task: z.string().trim().min(1).describe("Task for OpenCode"),
  cwd: z.string().trim().min(1).describe("Existing absolute working directory"),
  sessionId: z.string().trim().min(1).optional().describe("Previously returned OpenCode session ID"),
  resume: z.boolean().optional().describe("Resume the OpenCode session; defaults to true when sessionId is set"),
  model: z.string().trim().min(1).optional().describe("OpenCode model session option"),
  effort: z.string().trim().min(1).optional().describe("OpenCode effort session option"),
  agent: z.string().trim().min(1).optional().describe("OpenCode agent; mapped to the mode session option"),
});

const errorSchema = z.object({ code: z.string(), message: z.string() });
const outputSchema = z.object({
  sessionId: z.string().nullable(),
  stopReason: z.string().nullable(),
  text: z.string(),
  truncated: z.boolean(),
  error: errorSchema.optional(),
});

const cursorOutputSchema = outputSchema.extend({
  provider: z.literal("cursor"),
  toolCalls: z.array(z.object({
    toolCallId: z.string(),
    title: z.string().optional(),
    status: z.string().optional(),
  })).optional(),
  todos: z.array(z.object({
    id: z.string(),
    content: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  })).optional(),
  subagents: z.array(z.object({
    toolCallId: z.string(),
    description: z.string(),
    subagentType: z.string(),
    model: z.string().optional(),
    agentId: z.string().optional(),
    durationMs: z.number().optional(),
  })).optional(),
  interactions: z.array(z.object({
    type: z.enum(["question", "plan", "permission"]),
    toolCallId: z.string().optional(),
    title: z.string().optional(),
    summary: z.string(),
    outcome: z.enum(["skipped", "rejected"]),
  })).optional(),
  images: z.array(z.object({
    toolCallId: z.string(),
    description: z.string(),
    filePath: z.string().optional(),
    referenceImageCount: z.number().int().nonnegative(),
  })).optional(),
  summariesTruncated: z.boolean().optional(),
});

const usageSchema = z.object({
  used: z.number(),
  size: z.number(),
  cost: z.object({
    amount: z.number(),
    currency: z.string(),
  }).optional(),
});

const toolCallSchema = z.array(z.object({
  toolCallId: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
}));

const openCodeOutputSchema = outputSchema.extend({
  provider: z.literal("opencode"),
  usage: usageSchema.optional(),
  toolCalls: toolCallSchema.optional(),
  summariesTruncated: z.boolean().optional(),
});

const dshInputSchema = z.object({
  task: z.string().trim().min(1).describe("Task for DSH"),
  cwd: z.string().trim().min(1).describe("Existing absolute working directory"),
  sessionId: z.string().trim().min(1).optional().describe("Previously returned DSH session ID"),
  model: z.string().trim().min(1).optional().describe("DSH model session option"),
  reasoningEffort: z.string().trim().min(1).optional().describe("DSH reasoning_effort session option"),
});

const dshOutputSchema = outputSchema.extend({
  provider: z.literal("dsh"),
  usage: usageSchema.optional(),
  toolCalls: toolCallSchema.optional(),
  summariesTruncated: z.boolean().optional(),
});

function toolResult(result: RelayResult, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    ...(isError ? { isError: true } : {}),
  };
}

function isCursorPartial(value: RelayResultPartial | undefined): value is Partial<CursorRelayResult> {
  return value !== undefined && "provider" in value && value.provider === "cursor";
}

function isOpenCodePartial(value: RelayResultPartial | undefined): value is Partial<OpenCodeRelayResult> {
  return value !== undefined && "provider" in value && value.provider === "opencode";
}

function isDshPartial(value: RelayResultPartial | undefined): value is Partial<DshRelayResult> {
  return value !== undefined && "provider" in value && value.provider === "dsh";
}

function errorFields(failure: RelayFailure) {
  return {
    sessionId: failure.partial?.sessionId ?? null,
    stopReason: failure.partial?.stopReason ?? null,
    text: failure.partial?.text ?? "",
    truncated: failure.partial?.truncated ?? false,
    error: { code: failure.code, message: failure.message },
  };
}

type ToolContext = {
  mcpReq: {
    _meta?: unknown;
    signal: AbortSignal;
    notify: (notification: {
      method: "notifications/progress";
      params: { progressToken: string | number; progress: number; message: string };
    }) => Promise<void>;
  };
};

function progressReporter(ctx: ToolContext): ProgressReporter | undefined {
  let progress = 0;
  const token = (ctx.mcpReq._meta as { progressToken?: string | number } | undefined)?.progressToken;
  if (token === undefined) return undefined;
  return async (message: string) => {
    progress += 1;
    await ctx.mcpReq.notify({
      method: "notifications/progress",
      params: { progressToken: token, progress, message },
    });
  };
}

function registerDelegateTool<I extends { cwd: string }, R extends RelayResult>(
  server: McpServer,
  spec: {
    name: string;
    title: string;
    description: string;
    inputSchema: z.ZodTypeAny;
    outputSchema: z.ZodTypeAny;
    run: (input: I, cwd: string, signal: AbortSignal, progress?: ProgressReporter) => Promise<R>;
    toErrorResult: (failure: RelayFailure, input: I) => R;
  },
): void {
  server.registerTool(spec.name, {
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
  }, async (input, ctx) => {
    const parsed = input as I;
    try {
      const cwd = await resolveCwd(parsed.cwd);
      return toolResult(await spec.run(parsed, cwd, ctx.mcpReq.signal, progressReporter(ctx)));
    } catch (error) {
      const failure = error instanceof RelayFailure
        ? error
        : new RelayFailure("INTERNAL", error instanceof Error ? error.message : String(error));
      return toolResult(spec.toErrorResult(failure, parsed), true);
    }
  });
}

export function createRelayServer(config: RelayConfig): McpServer {
  const server = new McpServer(
    { name: "codex-agent-relay", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const runner = new GrokRunner(config, new SessionStore(config.stateDir));
  const cursorRunner = new CursorRunner(config, new SessionStore(config.stateDir, "cursor"));
  const openCodeRunner = new OpenCodeRunner(config, new SessionStore(config.stateDir, "opencode"));
  const dshRunner = new DshRunner(config, new SessionStore(config.stateDir, "dsh"));

  registerDelegateTool(server, {
    name: "grok_delegate",
    title: "Delegate a task to Grok",
    description: "Runs one Grok ACP prompt in the requested working directory and optionally resumes a saved Grok session.",
    inputSchema: grokInputSchema,
    outputSchema,
    run: (input: z.infer<typeof grokInputSchema>, cwd, signal, progress) => runner.delegate({
      task: input.task,
      cwd,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    }, signal, progress),
    toErrorResult: (failure): GrokRelayResult => errorFields(failure),
  });

  registerDelegateTool(server, {
    name: "cursor_delegate",
    title: "Delegate a task to Cursor",
    description: "Runs one Cursor ACP prompt in the requested working directory and optionally resumes a saved Cursor session.",
    inputSchema: cursorInputSchema,
    outputSchema: cursorOutputSchema,
    run: (input: z.infer<typeof cursorInputSchema>, cwd, signal, progress) => cursorRunner.delegate({
      task: input.task,
      cwd,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    }, signal, progress),
    toErrorResult: (failure): CursorRelayResult => {
      const extra = isCursorPartial(failure.partial) ? failure.partial : undefined;
      return {
        ...errorFields(failure),
        provider: "cursor",
        ...(extra?.toolCalls ? { toolCalls: extra.toolCalls } : {}),
        ...(extra?.todos ? { todos: extra.todos } : {}),
        ...(extra?.subagents ? { subagents: extra.subagents } : {}),
        ...(extra?.interactions ? { interactions: extra.interactions } : {}),
        ...(extra?.images ? { images: extra.images } : {}),
        ...(extra?.summariesTruncated ? { summariesTruncated: true } : {}),
      };
    },
  });

  registerDelegateTool(server, {
    name: "opencode_delegate",
    title: "Delegate a task to OpenCode",
    description: "Runs one OpenCode ACP prompt in the requested working directory and optionally resumes or loads a saved OpenCode session.",
    inputSchema: openCodeInputSchema,
    outputSchema: openCodeOutputSchema,
    run: (input: z.infer<typeof openCodeInputSchema>, cwd, signal, progress) => openCodeRunner.delegate({
      task: input.task,
      cwd,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.resume === undefined ? {} : { resume: input.resume }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.agent === undefined ? {} : { agent: input.agent }),
    }, signal, progress),
    toErrorResult: (failure): OpenCodeRelayResult => {
      const extra = isOpenCodePartial(failure.partial) ? failure.partial : undefined;
      return {
        ...errorFields(failure),
        provider: "opencode",
        ...(extra?.toolCalls ? { toolCalls: extra.toolCalls } : {}),
        ...(extra?.usage ? { usage: extra.usage } : {}),
        ...(extra?.summariesTruncated ? { summariesTruncated: true } : {}),
      };
    },
  });

  registerDelegateTool(server, {
    name: "dsh_delegate",
    title: "Delegate a task to DSH",
    description: "Runs one DSH ACP prompt in the requested working directory and optionally resumes a saved DSH session.",
    inputSchema: dshInputSchema,
    outputSchema: dshOutputSchema,
    run: (input: z.infer<typeof dshInputSchema>, cwd, signal, progress) => dshRunner.delegate({
      task: input.task,
      cwd,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    }, signal, progress),
    toErrorResult: (failure): DshRelayResult => {
      const extra = isDshPartial(failure.partial) ? failure.partial : undefined;
      return {
        ...errorFields(failure),
        provider: "dsh",
        ...(extra?.toolCalls ? { toolCalls: extra.toolCalls } : {}),
        ...(extra?.usage ? { usage: extra.usage } : {}),
        ...(extra?.summariesTruncated ? { summariesTruncated: true } : {}),
      };
    },
  });

  return server;
}
