import * as acp from "@agentclientprotocol/sdk";
import type { RelayConfig } from "../config.js";
import type { SessionStore } from "../store.js";
import { RelayFailure, type DshDelegateInput, type DshRelayResult } from "../types.js";
import { AcpRunner } from "../runner/acp-runner.js";
import {
  abortFailure,
  cancelledPermission,
  configSelectValues,
  hasResumeCapability,
} from "../runner/helpers.js";
import { boundedString, withTimeout } from "../runner/limits.js";
import { StandardSummaries } from "../runner/summaries.js";
import type { ProgressReporter, ProviderAdapter } from "../runner/types.js";

export function dshSpawnSpec(config: RelayConfig): { command: string; args: string[] } {
  return {
    command: config.dshCommand?.trim() || "dsh",
    args: config.dshCommandArgs ?? ["--profile", "acp"],
  };
}

function dshAdapter(config: RelayConfig): ProviderAdapter<DshDelegateInput, DshRelayResult> {
  return {
    provider: "dsh",
    displayName: "DSH",
    command() {
      return dshSpawnSpec(config);
    },
    authenticate() {
      return undefined;
    },
    capabilities: {},
    prompt: (task) => `This is a noninteractive delegated task. Do not ask the user questions. Resolve minor ambiguity conservatively. If a material decision is unresolved, stop and report it.\n\n${task}`,
    sessionMetadata: () => ({}),
    existingSession(initialized) {
      if (!hasResumeCapability(initialized.agentCapabilities)) {
        throw new RelayFailure("RESUME_UNSUPPORTED", "DSH did not advertise session resume capability");
      }
      return "resume";
    },
    createSummarizer: (limitBytes) => new StandardSummaries(limitBytes, "dsh"),
    handlePermission(params, rt) {
      if (params.sessionId !== rt.sessionId || rt.signal.aborted || rt.hasFailure()) {
        return cancelledPermission();
      }
      rt.markRequested();
      const reject = params.options.find((option) => option.kind === "reject_once");
      const permissionLabel = boundedString(params.toolCall.title ?? params.toolCall.toolCallId, 256);
      const permissionFailure = new RelayFailure(
        "PERMISSION_REQUIRED",
        reject
          ? `DSH permission was rejected: ${permissionLabel}`
          : `DSH requested permission without a reject_once option: ${permissionLabel}`,
        rt.partial(),
      );
      rt.setFailure(permissionFailure);
      setImmediate(() => rt.abort(permissionFailure));
      return reject
        ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } }
        : cancelledPermission();
    },
    async configureSession(ctx, sessionId, input, extras, signal) {
      const requested = [
        ["model", input.model],
        ["reasoning_effort", input.reasoningEffort],
      ] as const;
      let options = [...(extras.configOptions ?? [])];
      for (const [id, value] of requested) {
        if (value === undefined) continue;
        if (signal?.aborted) abortFailure(signal);
        const option = options.find((entry) => entry.id === id);
        if (!option) {
          throw new RelayFailure("CONFIG_UNSUPPORTED", `DSH did not advertise the ${id} session option`);
        }
        if (!configSelectValues(option).includes(value)) {
          throw new RelayFailure("INVALID_CONFIG", `DSH ${id} value is not available`);
        }
        const response = await withTimeout(ctx.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: id,
          value,
        }), config.phaseTimeoutMs, "CONFIG_TIMEOUT", `DSH ${id} configuration timed out`);
        if (signal?.aborted) abortFailure(signal);
        options = [...response.configOptions];
      }
    },
  };
}

export class DshRunner extends AcpRunner<DshDelegateInput, DshRelayResult> {
  constructor(config: RelayConfig, store: SessionStore) {
    super(config, store, dshAdapter(config));
  }

  override delegate(input: DshDelegateInput, signal?: AbortSignal, reportProgress?: ProgressReporter): Promise<DshRelayResult> {
    return super.delegate(input, signal, reportProgress);
  }
}
