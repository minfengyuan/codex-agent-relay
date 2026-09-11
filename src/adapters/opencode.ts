import * as acp from "@agentclientprotocol/sdk";
import type { RelayConfig } from "../config.js";
import type { SessionStore } from "../store.js";
import { RelayFailure, type OpenCodeDelegateInput, type OpenCodeRelayResult } from "../types.js";
import { AcpRunner } from "../runner/acp-runner.js";
import {
  abortFailure,
  authMethodIds,
  cancelledPermission,
  hasLoadCapability,
  hasResumeCapability,
} from "../runner/helpers.js";
import { boundedString, withTimeout } from "../runner/limits.js";
import { OpenCodeSummaries } from "../runner/summaries.js";
import type { ProgressReporter, ProviderAdapter } from "../runner/types.js";

function overlayOpenCodePermission(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const existing = env.OPENCODE_PERMISSION;
  let parsed: Record<string, unknown> = {};
  if (existing !== undefined) {
    try {
      const value: unknown = JSON.parse(existing);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("not object");
      }
      parsed = value as Record<string, unknown>;
    } catch {
      throw new RelayFailure("OPENCODE_PERMISSION_INVALID", "OPENCODE_PERMISSION must be a JSON object");
    }
  }
  return { ...env, OPENCODE_PERMISSION: JSON.stringify({ ...parsed, question: "deny" }) };
}

function configSelectValues(option: acp.SessionConfigOption): string[] {
  if (option.type !== "select") return [];
  const values: string[] = [];
  for (const entry of option.options) {
    if ("value" in entry && typeof entry.value === "string") {
      values.push(entry.value);
      continue;
    }
    if ("options" in entry && Array.isArray(entry.options)) {
      for (const inner of entry.options) {
        if (inner && typeof inner === "object" && "value" in inner && typeof inner.value === "string") {
          values.push(inner.value);
        }
      }
    }
  }
  return values;
}

function opencodeAdapter(config: RelayConfig): ProviderAdapter<OpenCodeDelegateInput, OpenCodeRelayResult> {
  return {
    provider: "opencode",
    displayName: "OpenCode",
    command(input) {
      return {
        command: config.opencodeCommand?.trim() || "opencode",
        args: [...(config.opencodeCommandArgs ?? []), "acp", "--cwd", input.cwd],
      };
    },
    authenticate(initialized) {
      const authIds = authMethodIds(initialized);
      if (authIds.includes("opencode-login")) return "opencode-login";
      if (authIds.length === 0) return undefined;
      throw new RelayFailure("AUTH_UNAVAILABLE", "OpenCode did not advertise non-interactive opencode-login authentication");
    },
    capabilities: {},
    prompt: (task) => `This is a noninteractive delegated task. Do not ask the user questions. Resolve minor ambiguity conservatively. If a material decision is unresolved, stop and report it.\n\n${task}`,
    sessionMetadata: () => ({}),
    spawnEnv: overlayOpenCodePermission,
    validateInput(input) {
      if (input.resume !== undefined && !input.sessionId) {
        throw new RelayFailure("INVALID_INPUT", "resume requires sessionId");
      }
    },
    existingSession(initialized, input) {
      if (input.resume === false) {
        if (!hasLoadCapability(initialized.agentCapabilities)) {
          throw new RelayFailure("LOAD_UNSUPPORTED", "OpenCode did not advertise loadSession capability");
        }
        return "load";
      }
      if (hasResumeCapability(initialized.agentCapabilities)) return "resume";
      if (hasLoadCapability(initialized.agentCapabilities)) return "load";
      throw new RelayFailure("LOAD_UNSUPPORTED", "OpenCode did not advertise session resume or loadSession capability");
    },
    createSummarizer: (limitBytes) => new OpenCodeSummaries(limitBytes),
    handlePermission(params, rt) {
      if (params.sessionId !== rt.sessionId || rt.signal.aborted || rt.hasFailure()) {
        return cancelledPermission();
      }
      const allowOnce = params.options.find((option) => option.kind === "allow_once");
      if (!allowOnce) {
        rt.markRequested();
        const permissionLabel = boundedString(params.toolCall.title ?? params.toolCall.toolCallId, 256);
        const permissionFailure = new RelayFailure(
          "PERMISSION_REQUIRED",
          `OpenCode requested permission without an allow_once option: ${permissionLabel}`,
          rt.partial(),
        );
        rt.setFailure(permissionFailure);
        setImmediate(() => rt.abort(permissionFailure));
        return cancelledPermission();
      }
      return { outcome: { outcome: "selected" as const, optionId: allowOnce.optionId } };
    },
    async configureSession(ctx, sessionId, input, extras, signal) {
      const requested = [
        ["model", input.model],
        ["effort", input.effort],
        ["mode", input.agent],
      ] as const;
      let options = [...(extras.configOptions ?? [])];
      for (const [id, value] of requested) {
        if (value === undefined) continue;
        if (signal?.aborted) abortFailure(signal);
        const option = options.find((entry) => entry.id === id);
        if (!option) {
          throw new RelayFailure("CONFIG_UNSUPPORTED", `OpenCode did not advertise the ${id} session option`);
        }
        if (!configSelectValues(option).includes(value)) {
          throw new RelayFailure("INVALID_CONFIG", `OpenCode ${id} value is not available`);
        }
        const response = await withTimeout(ctx.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: id,
          value,
        }), config.phaseTimeoutMs, "CONFIG_TIMEOUT", `OpenCode ${id} configuration timed out`);
        if (signal?.aborted) abortFailure(signal);
        options = [...response.configOptions];
      }
    },
  };
}

export class OpenCodeRunner extends AcpRunner<OpenCodeDelegateInput, OpenCodeRelayResult> {
  constructor(config: RelayConfig, store: SessionStore) {
    super(config, store, opencodeAdapter(config));
  }

  override delegate(input: OpenCodeDelegateInput, signal?: AbortSignal, reportProgress?: ProgressReporter): Promise<OpenCodeRelayResult> {
    return super.delegate(input, signal, reportProgress);
  }
}
