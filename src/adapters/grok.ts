import type { RelayConfig } from "../config.js";
import type { SessionStore } from "../store.js";
import { RelayFailure, type DelegateInput, type GrokRelayResult } from "../types.js";
import { AcpRunner } from "../runner/acp-runner.js";
import { authMethodIds, cancelledPermission } from "../runner/helpers.js";
import { EmptySummarizer } from "../runner/summaries.js";
import type { ProgressReporter, ProviderAdapter } from "../runner/types.js";

function grokAdapter(config: RelayConfig): ProviderAdapter<DelegateInput, GrokRelayResult> {
  return {
    provider: "grok",
    displayName: "Grok",
    command: () => ({ command: config.command, args: config.commandArgs }),
    authenticate(initialized) {
      const authIds = authMethodIds(initialized);
      const preferred = process.env.XAI_API_KEY && authIds.includes("xai.api_key")
        ? "xai.api_key"
        : authIds.includes("cached_token") ? "cached_token" : undefined;
      if (!preferred) {
        throw new RelayFailure("AUTH_UNAVAILABLE", "No non-interactive Grok authentication is available (xai.api_key or cached_token)");
      }
      return preferred;
    },
    authenticateParams(methodId) {
      return { methodId, _meta: { headless: true } };
    },
    capabilities: {},
    prompt: (task) => task,
    sessionMetadata: () => ({}),
    createSummarizer: () => new EmptySummarizer(),
    handlePermission(_params, rt) {
      rt.markRequested();
      queueMicrotask(() => rt.abort(new RelayFailure(
        "UNEXPECTED_PERMISSION",
        "Grok requested permission despite --always-approve",
        rt.partial(),
      )));
      return cancelledPermission();
    },
  };
}

export class GrokRunner extends AcpRunner<DelegateInput, GrokRelayResult> {
  constructor(config: RelayConfig, store: SessionStore) {
    super(config, store, grokAdapter(config));
  }

  override delegate(input: DelegateInput, signal?: AbortSignal, reportProgress?: ProgressReporter): Promise<GrokRelayResult> {
    return super.delegate(input, signal, reportProgress);
  }
}
