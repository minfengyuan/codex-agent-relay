import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { RelayConfig } from "./config.js";
import { SessionStore, resolveCwd } from "./store.js";
import { GrokRunner } from "./runner.js";
import { RelayFailure, type RelayResult } from "./types.js";

const inputSchema = z.object({
  task: z.string().trim().min(1).describe("Task for Grok"),
  cwd: z.string().min(1).describe("Existing absolute working directory"),
  sessionId: z.string().min(1).optional().describe("Previously returned Grok session ID"),
});

const errorSchema = z.object({ code: z.string(), message: z.string() });
const outputSchema = z.object({
  sessionId: z.string().nullable(),
  stopReason: z.string().nullable(),
  text: z.string(),
  truncated: z.boolean(),
  error: errorSchema.optional(),
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
  const store = new SessionStore(config.stateDir);
  const runner = new GrokRunner(config, store);

  server.registerTool("grok_delegate", {
    title: "Delegate a task to Grok",
    description: "Runs one Grok ACP prompt in the requested working directory and optionally resumes a saved Grok session.",
    inputSchema,
    outputSchema,
  }, async (input, ctx) => {
    try {
      const cwd = await resolveCwd(input.cwd);
      let progress = 0;
      const token = (ctx.mcpReq._meta as { progressToken?: string | number } | undefined)?.progressToken;
      const report = token === undefined ? undefined : async (message: string) => {
        progress += 1;
        await ctx.mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken: token, progress, message },
        });
      };
      const result = await runner.delegate({
        task: input.task,
        cwd,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      }, ctx.mcpReq.signal, report);
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
  return server;
}
