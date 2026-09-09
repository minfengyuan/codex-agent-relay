export type RelayError = { code: string; message: string };

export type RelayResult = {
  sessionId: string | null;
  stopReason: string | null;
  text: string;
  truncated: boolean;
  provider?: "cursor";
  toolCalls?: ToolCallSummary[];
  todos?: TodoSummary[];
  subagents?: SubagentSummary[];
  interactions?: InteractionSummary[];
  images?: ImageSummary[];
  summariesTruncated?: boolean;
  error?: RelayError;
};

export type DelegateInput = {
  task: string;
  cwd: string;
  sessionId?: string;
};

export type CursorMode = "agent" | "ask";

export type CursorDelegateInput = DelegateInput & {
  model?: string;
  mode?: CursorMode;
};

export type ToolCallSummary = {
  toolCallId: string;
  title?: string;
  status?: string;
};

export type TodoSummary = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
};

export type SubagentSummary = {
  toolCallId: string;
  description: string;
  subagentType: string;
  model?: string;
  agentId?: string;
  durationMs?: number;
};

export type InteractionSummary = {
  type: "question" | "plan" | "permission";
  toolCallId?: string;
  title?: string;
  summary: string;
  outcome: "skipped" | "rejected";
};

export type ImageSummary = {
  toolCallId: string;
  description: string;
  filePath?: string;
  referenceImageCount: number;
};

export class RelayFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly partial?: Partial<RelayResult>,
  ) {
    super(message);
    this.name = "RelayFailure";
  }
}
