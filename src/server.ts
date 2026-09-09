import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { RelayConfig } from "./config.js";
import { SessionStore, resolveCwd } from "./store.js";
import { CursorRunner, GrokRunner, type ProgressReporter } from "./runner.js";
import { RelayFailure, type RelayResult } from "./types.js";

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

function toolResult(result: RelayResult, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    ...(isError ? { isError: true } : {}),
  };
}

export function createRelayServer(config: RelayConfig): McpServer {
  const server = new McpServer(
    { name: "codex-grok-relay", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const runner = new GrokRunner(config, new SessionStore(config.stateDir));
  const cursorRunner = new CursorRunner(config, new SessionStore(config.stateDir, "cursor"));

  const progressReporter = (ctx: { mcpReq: { _meta?: unknown; notify: (notification: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; message: string };
  }) => Promise<void> } }): ProgressReporter | undefined => {
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
  };

  server.registerTool("grok_delegate", {
    title: "Delegate a task to Grok",
    description: "Runs one Grok ACP prompt in the requested working directory and optionally resumes a saved Grok session.",
    inputSchema: grokInputSchema,
    outputSchema,
  }, async (input, ctx) => {
    try {
      const cwd = await resolveCwd(input.cwd);
      const result = await runner.delegate({
        task: input.task,
        cwd,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      }, ctx.mcpReq.signal, progressReporter(ctx));
      return toolResult(result);
    } catch (error) {
      const failure = error instanceof RelayFailure
        ? error
        : new RelayFailure("INTERNAL", error instanceof Error ? error.message : String(error));
      const result: RelayResult = {
        sessionId: failure.partial?.sessionId ?? input.sessionId ?? null,
        stopReason: failure.partial?.stopReason ?? null,
        text: failure.partial?.text ?? "",
        truncated: failure.partial?.truncated ?? false,
        error: { code: failure.code, message: failure.message },
      };
      return toolResult(result, true);
    }
  });

  server.registerTool("cursor_delegate", {
    title: "Delegate a task to Cursor",
    description: "Runs one Cursor ACP prompt in the requested working directory and optionally resumes a saved Cursor session.",
    inputSchema: cursorInputSchema,
    outputSchema: cursorOutputSchema,
  }, async (input, ctx) => {
    try {
      const cwd = await resolveCwd(input.cwd);
      const result = await cursorRunner.delegate({
        task: input.task,
        cwd,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
      }, ctx.mcpReq.signal, progressReporter(ctx));
      return toolResult(result);
    } catch (error) {
      const failure = error instanceof RelayFailure
        ? error
        : new RelayFailure("INTERNAL", error instanceof Error ? error.message : String(error));
      const result: RelayResult = {
        sessionId: failure.partial?.sessionId ?? input.sessionId ?? null,
        stopReason: failure.partial?.stopReason ?? null,
        text: failure.partial?.text ?? "",
        truncated: failure.partial?.truncated ?? false,
        provider: "cursor",
        ...(failure.partial?.toolCalls ? { toolCalls: failure.partial.toolCalls } : {}),
        ...(failure.partial?.todos ? { todos: failure.partial.todos } : {}),
        ...(failure.partial?.subagents ? { subagents: failure.partial.subagents } : {}),
        ...(failure.partial?.interactions ? { interactions: failure.partial.interactions } : {}),
        ...(failure.partial?.images ? { images: failure.partial.images } : {}),
        ...(failure.partial?.summariesTruncated ? { summariesTruncated: true } : {}),
        error: { code: failure.code, message: failure.message },
      };
      return toolResult(result, true);
    }
  });
  return server;
}
