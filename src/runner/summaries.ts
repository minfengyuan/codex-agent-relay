import type * as acp from "@agentclientprotocol/sdk";
import { RelayFailure } from "../types.js";
import type {
  CursorRelayResult,
  GrokRelayResult,
  ImageSummary,
  InteractionSummary,
  OpenCodeRelayResult,
  SubagentSummary,
  TodoSummary,
  ToolCallSummary,
  UsageSummary,
} from "../types.js";
import { boundedJson, boundedString } from "./limits.js";
import type { ProviderSummarizer, ToolCallUpdate } from "./types.js";

export function usageFromUpdate(update: Extract<acp.SessionUpdate, { sessionUpdate: "usage_update" }>): UsageSummary {
  const usage: UsageSummary = { used: update.used, size: update.size };
  if (update.cost && typeof update.cost.amount === "number" && typeof update.cost.currency === "string") {
    usage.cost = { amount: update.cost.amount, currency: update.cost.currency };
  }
  return usage;
}

export function permissionSummary(toolCall: acp.RequestPermissionRequest["toolCall"]): string {
  const parts = [`Permission requested for ${boundedString(toolCall.title ?? toolCall.name ?? toolCall.toolCallId, 256)}`];
  const rawInput = boundedJson(toolCall.rawInput, 1_024);
  const locations = boundedJson(toolCall.locations, 1_024);
  if (rawInput) parts.push(`input=${rawInput}`);
  if (locations) parts.push(`locations=${locations}`);
  return boundedString(parts.join("; "), 2_560);
}

export class EmptySummarizer implements ProviderSummarizer<GrokRelayResult> {
  truncated = false;
  result(): Partial<GrokRelayResult> {
    return {};
  }
}

export class CursorSummaries implements ProviderSummarizer<CursorRelayResult> {
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

  onToolCall(update: ToolCallUpdate): void {
    this.add(this.toolCalls, {
      toolCallId: update.toolCallId,
      ...(update.title ? { title: update.title } : {}),
      ...(update.status ? { status: update.status } : {}),
    });
  }

  result(): Pick<CursorRelayResult, "provider" | "toolCalls" | "todos" | "subagents" | "interactions" | "images" | "summariesTruncated"> {
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

export class OpenCodeSummaries implements ProviderSummarizer<OpenCodeRelayResult> {
  readonly toolCalls: ToolCallSummary[] = [];
  truncated = false;
  usage?: UsageSummary;

  constructor(private readonly limitBytes: number) {}

  add(value: ToolCallSummary): void {
    this.toolCalls.push(value);
    if (Buffer.byteLength(JSON.stringify({ ...this.result(), summariesTruncated: true })) > this.limitBytes) {
      this.toolCalls.pop();
      this.truncated = true;
    }
  }

  onToolCall(update: ToolCallUpdate): void {
    this.add({
      toolCallId: update.toolCallId,
      ...(update.title ? { title: update.title } : {}),
      ...(update.status ? { status: update.status } : {}),
    });
  }

  onUsage(update: Extract<acp.SessionUpdate, { sessionUpdate: "usage_update" }>): void {
    this.usage = usageFromUpdate(update);
  }

  result(): Pick<OpenCodeRelayResult, "provider" | "toolCalls" | "usage" | "summariesTruncated"> {
    return {
      provider: "opencode",
      ...(this.toolCalls.length ? { toolCalls: this.toolCalls } : {}),
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.truncated ? { summariesTruncated: true } : {}),
    };
  }
}

export function cursorSummarizer(summarizer: ProviderSummarizer<CursorRelayResult>): CursorSummaries {
  if (!(summarizer instanceof CursorSummaries)) {
    throw new RelayFailure("INTERNAL", "Cursor adapter received a non-Cursor summarizer");
  }
  return summarizer;
}
