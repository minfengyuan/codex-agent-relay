export type RelayErrorCode =
  | "STATE_IO"
  | "INVALID_CWD"
  | "UNKNOWN_SESSION"
  | "CORRUPT_SESSION"
  | "CWD_MISMATCH"
  | "STATE_CONFLICT"
  | "WORKSPACE_BUSY"
  | "WORKSPACE_ORPHANED"
  | "STALE_LOCK_UNVERIFIED"
  | "LOCK_IO"
  | "LOCK_OWNERSHIP_LOST"
  | "PROCESS_CLEANUP_FAILED"
  | "INTERNAL"
  | "OPENCODE_PERMISSION_INVALID"
  | "CANCELLED"
  | "NESTED_DELEGATION"
  | "INVALID_INPUT"
  | "TIMEOUT"
  | "SPAWN_TIMEOUT"
  | "INITIALIZE_TIMEOUT"
  | "AUTH_TIMEOUT"
  | "RESUME_TIMEOUT"
  | "LOAD_TIMEOUT"
  | "NEW_SESSION_TIMEOUT"
  | "MODE_TIMEOUT"
  | "CONFIG_TIMEOUT"
  | "PROTOCOL_MISMATCH"
  | "LOAD_UNSUPPORTED"
  | "RESUME_UNSUPPORTED"
  | "INVALID_SESSION"
  | "MODE_UNAVAILABLE"
  | "AUTH_UNAVAILABLE"
  | "CURSOR_COMMAND_REQUIRED"
  | "SESSION_OPTION_CONFLICT"
  | "CONFIG_UNSUPPORTED"
  | "INVALID_CONFIG"
  | "PERMISSION_REQUIRED"
  | "UNEXPECTED_PERMISSION"
  | "ACP_FAILURE";

export type RelayError = { code: RelayErrorCode; message: string };

export type UsageSummary = {
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
};

type RelayResultBase = {
  sessionId: string | null;
  stopReason: string | null;
  text: string;
  truncated: boolean;
  error?: RelayError;
};

export type GrokRelayResult = RelayResultBase;

export type CursorRelayResult = RelayResultBase & {
  provider: "cursor";
  toolCalls?: ToolCallSummary[];
  todos?: TodoSummary[];
  subagents?: SubagentSummary[];
  interactions?: InteractionSummary[];
  images?: ImageSummary[];
  summariesTruncated?: boolean;
};

export type OpenCodeRelayResult = RelayResultBase & {
  provider: "opencode";
  toolCalls?: ToolCallSummary[];
  usage?: UsageSummary;
  summariesTruncated?: boolean;
};

export type DshRelayResult = RelayResultBase & {
  provider: "dsh";
  toolCalls?: ToolCallSummary[];
  usage?: UsageSummary;
  summariesTruncated?: boolean;
};

export type RelayResult = GrokRelayResult | CursorRelayResult | OpenCodeRelayResult | DshRelayResult;

export type RelayResultPartial =
  | Partial<GrokRelayResult>
  | Partial<CursorRelayResult>
  | Partial<OpenCodeRelayResult>
  | Partial<DshRelayResult>;

type GrokForbiddenExtras =
  | "provider"
  | "toolCalls"
  | "todos"
  | "subagents"
  | "interactions"
  | "images"
  | "usage"
  | "summariesTruncated";
export type _GrokRelayResultHasNoExtras = GrokForbiddenExtras & keyof GrokRelayResult extends never ? true : never;
true satisfies _GrokRelayResultHasNoExtras;

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

export type OpenCodeDelegateInput = DelegateInput & {
  resume?: boolean;
  model?: string;
  effort?: string;
  agent?: string;
};

export type DshDelegateInput = DelegateInput & {
  model?: string;
  reasoningEffort?: string;
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
    public readonly code: RelayErrorCode,
    message: string,
    public readonly partial?: RelayResultPartial,
  ) {
    super(message);
    this.name = "RelayFailure";
  }
}
