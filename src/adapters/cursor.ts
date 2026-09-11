import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { RelayConfig } from "../config.js";
import type { SessionStore } from "../store.js";
import {
  RelayFailure,
  type CursorDelegateInput,
  type CursorMode,
  type CursorRelayResult,
} from "../types.js";
import { AcpRunner } from "../runner/acp-runner.js";
import { authMethodIds, cancelledPermission } from "../runner/helpers.js";
import { boundedString, jsonSize, withTimeout } from "../runner/limits.js";
import { CursorSummaries, cursorSummarizer, permissionSummary } from "../runner/summaries.js";
import type { ProgressReporter, ProviderAdapter } from "../runner/types.js";

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

function cursorAdapter(config: RelayConfig): ProviderAdapter<CursorDelegateInput, CursorRelayResult> {
  return {
    provider: "cursor",
    displayName: "Cursor",
    command(input, record) {
      const command = config.cursorCommand?.trim();
      if (!command) {
        throw new RelayFailure("CURSOR_COMMAND_REQUIRED", "CODEX_AGENT_RELAY_CURSOR_COMMAND must name the Cursor CLI executable");
      }
      const metadata = this.sessionMetadata(input, record);
      const args = [...(config.cursorCommandArgs ?? []), "--sandbox", "enabled"];
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
    createSummarizer: (limitBytes) => new CursorSummaries(limitBytes),
    handlePermission(params, rt) {
      rt.markRequested();
      const summaries = cursorSummarizer(rt.summarizer);
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
      const permissionFailure = new RelayFailure(
        "PERMISSION_REQUIRED",
        reject
          ? `Cursor permission was rejected: ${permissionLabel}`
          : `Cursor requested permission without a reject_once option: ${permissionLabel}`,
        rt.partial(),
      );
      rt.setFailure(permissionFailure);
      setImmediate(() => rt.abort(permissionFailure));
      return reject
        ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } }
        : cancelledPermission();
    },
    extendClient(app, summarizer) {
      const summaries = cursorSummarizer(summarizer);
      return app
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
    },
    async configureSession(ctx, sessionId, _input, extras) {
      const requested = extras.metadata.mode;
      if (!requested) return;
      const modes = extras.modes;
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
        config.phaseTimeoutMs,
        "MODE_TIMEOUT",
        `Cursor ${requested} mode selection timed out`,
      );
    },
  };
}

export class CursorRunner extends AcpRunner<CursorDelegateInput, CursorRelayResult> {
  constructor(config: RelayConfig, store: SessionStore) {
    super(config, store, cursorAdapter(config));
  }

  override delegate(input: CursorDelegateInput, signal?: AbortSignal, reportProgress?: ProgressReporter): Promise<CursorRelayResult> {
    return super.delegate(input, signal, reportProgress);
  }
}
