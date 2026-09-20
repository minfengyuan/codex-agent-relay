import * as acp from "@agentclientprotocol/sdk";
import type { RelayConfig } from "../config.js";
import type { SessionStore } from "../store.js";
import { RelayFailure, type DshDelegateInput, type DshRelayResult } from "../types.js";
import { AcpRunner } from "../runner/acp-runner.js";
import {
  abortFailure,
  cancelledPermission,
  configSelectValues,
  hasCloseCapability,
  hasResumeCapability,
} from "../runner/helpers.js";
import { boundedString, withTimeout } from "../runner/limits.js";
import { StandardSummaries } from "../runner/summaries.js";
import type { ProgressReporter, ProviderAdapter } from "../runner/types.js";
import { resolveWindowsDshLauncher } from "./dsh-windows-command.js";

export { resolveWindowsDshLauncher };

export function dshSpawnSpec(
  config: RelayConfig,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const command = config.dshCommand?.trim() || "dsh";
  const args = config.dshCommandArgs ?? ["--profile", "acp"];
  if (process.platform !== "win32") return { command, args };
  const resolved = resolveWindowsDshLauncher(command, env);
  return { command: resolved.command, args: [...resolved.prefixArgs, ...args] };
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
    persistNewSessionBeforeConfigure: true,
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
      if (!hasCloseCapability(extras.agentCapabilities)) {
        throw new RelayFailure(
          "SESSION_CLOSE_UNSUPPORTED",
          "DSH did not advertise session close capability",
        );
      }
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
    async completeSession(ctx, sessionId, signal) {
      if (signal?.aborted) abortFailure(signal);
      try {
        await withTimeout(
          ctx.request(acp.methods.agent.session.close, { sessionId }),
          config.phaseTimeoutMs,
          "SESSION_CLOSE_TIMEOUT",
          "DSH session close timed out",
        );
      } catch (error) {
        if (error instanceof RelayFailure) throw error;
        throw new RelayFailure(
          "SESSION_CLOSE_FAILED",
          `DSH session close failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (signal?.aborted) abortFailure(signal);
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
