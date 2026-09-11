import { RelayFailure, type RelayErrorCode } from "../types.js";

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, code: RelayErrorCode, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new RelayFailure(code, message)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function appendLimited(current: string, chunk: string, limit: number): { value: string; truncated: boolean } {
  const used = Buffer.byteLength(current);
  if (used >= limit) return { value: current, truncated: chunk.length > 0 };
  const bytes = Buffer.from(chunk);
  if (bytes.length <= limit - used) return { value: current + chunk, truncated: false };
  const remaining = limit - used;
  let end = remaining;
  let suffix = bytes.subarray(0, end).toString("utf8");
  while (end > 0 && (suffix.endsWith("�") || Buffer.byteLength(suffix) > remaining)) {
    end -= 1;
    suffix = bytes.subarray(0, end).toString("utf8");
  }
  return { value: current + suffix, truncated: true };
}

export function boundedString(value: string, limitBytes: number): string {
  return appendLimited("", value, limitBytes).value;
}

export function boundedJson(value: unknown, limitBytes: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return boundedString(JSON.stringify(value), limitBytes);
  } catch {
    return "[unserializable]";
  }
}

export function jsonSize(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try { return Buffer.byteLength(JSON.stringify(value)); } catch { return Number.POSITIVE_INFINITY; }
}
