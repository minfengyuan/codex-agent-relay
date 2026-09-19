import type * as acp from "@agentclientprotocol/sdk";
import type { DelegateInput, RelayFailure, RelayResult } from "../types.js";
import type { SessionRecord } from "../store.js";

export type ProgressReporter = (message: string) => Promise<void> | void;

export type Provider = "grok" | "cursor" | "opencode" | "dsh";
export type ExistingSessionAction = "resume" | "load";

export type ToolCallUpdate = {
  toolCallId: string;
  title?: string;
  status?: string;
};

export type ProviderSummarizer<R extends RelayResult> = {
  truncated: boolean;
  result(): Partial<R>;
  onToolCall?(update: ToolCallUpdate): void;
  onUsage?(update: Extract<acp.SessionUpdate, { sessionUpdate: "usage_update" }>): void;
};

export type PermissionRuntime<R extends RelayResult> = {
  sessionId: string | null;
  signal: AbortSignal;
  partial: () => Partial<R>;
  abort: (failure: RelayFailure) => void;
  markRequested: () => void;
  setFailure: (failure: RelayFailure) => void;
  hasFailure: () => boolean;
  summarizer: ProviderSummarizer<R>;
};

export type SessionExtras = {
  configOptions: readonly acp.SessionConfigOption[] | null | undefined;
  modes: acp.SessionModeState | null | undefined;
  metadata: Pick<SessionRecord, "model" | "mode">;
};

export type ProviderAdapter<I extends DelegateInput, R extends RelayResult> = {
  provider: Provider;
  displayName: string;
  command(input: I, record?: SessionRecord): { command: string; args: string[] };
  authenticate(initialized: acp.InitializeResponse): string | undefined;
  authenticateParams?(methodId: string): acp.AuthenticateRequest;
  capabilities: acp.ClientCapabilities;
  prompt(task: string): string;
  sessionMetadata(input: I, record?: SessionRecord): Pick<SessionRecord, "model" | "mode">;
  spawnEnv?(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  existingSession?(initialized: acp.InitializeResponse, input: I): ExistingSessionAction;
  validateInput?(input: I): void;
  createSummarizer(limitBytes: number): ProviderSummarizer<R>;
  handlePermission(params: acp.RequestPermissionRequest, rt: PermissionRuntime<R>): acp.RequestPermissionResponse;
  extendClient?(app: acp.ClientApp, summarizer: ProviderSummarizer<R>): acp.ClientApp;
  configureSession?(
    ctx: acp.ClientContext,
    sessionId: string,
    input: I,
    extras: SessionExtras,
    signal?: AbortSignal,
  ): Promise<void>;
};
