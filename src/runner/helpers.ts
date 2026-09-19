import type * as acp from "@agentclientprotocol/sdk";
import { RelayFailure } from "../types.js";

export function abortFailure(signal: AbortSignal): never {
  if (signal.reason instanceof RelayFailure) throw signal.reason;
  throw new RelayFailure("CANCELLED", "MCP request was cancelled");
}

export function authMethodIds(response: acp.InitializeResponse): string[] {
  return (response.authMethods ?? []).map((method) => method.id);
}

export function cancelledPermission(): acp.RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

export function hasLoadCapability(capabilities: unknown): boolean {
  return Boolean(capabilities && typeof capabilities === "object"
    && (capabilities as { loadSession?: unknown }).loadSession === true);
}

export function hasResumeCapability(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== "object") return false;
  const resume = (capabilities as {
    sessionCapabilities?: { resume?: unknown } | null;
  }).sessionCapabilities?.resume;
  return resume !== undefined && resume !== null;
}

export function configSelectValues(option: acp.SessionConfigOption): string[] {
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
