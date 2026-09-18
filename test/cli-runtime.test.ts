import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli, type CliDependencies } from "../src/cli-runtime.js";
import { baseConfig } from "./helpers.js";

afterEach(() => { vi.useRealTimers(); });

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function runtimeHarness(options: {
  close?: () => Promise<void>;
  cleanup?: () => Promise<void>;
  pause?: () => unknown;
  write?: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
} = {}) {
  const handlers = new Map<string, () => void>();
  const stderrWrites: string[] = [];
  const exits: number[] = [];
  const sdkErrors: Array<(error: Error) => void> = [];
  const stderrEvents = new EventEmitter(), stdoutEvents = new EventEmitter();
  const close = vi.fn(options.close ?? (async () => undefined));
  const cleanup = vi.fn(options.cleanup ?? (async () => undefined));
  const dependencies: CliDependencies = {
    serveStdio: (_factory, settings) => {
      sdkErrors.push(settings.onerror);
      return { close } as unknown as StdioServerHandle;
    },
    createServer: (() => ({})) as unknown as NonNullable<CliDependencies["createServer"]>,
    beginShutdown: cleanup,
    stdin: {
      on: (event, listener) => { handlers.set(event, listener); },
      pause: options.pause ?? (() => undefined),
    },
    stdout: stdoutEvents,
    stderr: {
      on: stderrEvents.on.bind(stderrEvents),
      off: stderrEvents.off.bind(stderrEvents),
      write: (chunk, callback) => {
        stderrWrites.push(chunk);
        if (options.write) return options.write(chunk, callback);
        callback?.(null);
        return true;
      },
    },
    process: {
      on: (event, listener) => { handlers.set(event, listener); },
      exit: (code) => { exits.push(code); },
    },
    closeTimeoutMs: 50,
  };
  const runtime = runCli(baseConfig("state"), dependencies);
  return { cleanup, close, exits, handlers, runtime, sdkErrors, stderrWrites, stderrEvents, stdoutEvents };
}

describe("CLI shutdown coordination", () => {
  it("runs cleanup when transport close rejects, emits only stderr diagnostics, and exits one time", async () => {
    const harness = runtimeHarness({ close: async () => { throw new Error("close rejected"); } });
    const first = harness.runtime.shutdown("EOF");
    const second = harness.runtime.shutdown("SIGTERM");
    expect(second).toBe(first);
    await first;
    await expect(harness.runtime.completion).resolves.toBe(1);
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.exits).toEqual([1]);
    expect(harness.stderrWrites.join("")).toContain("transport: close rejected");
  });

  it("converts a synchronous close throw and concurrent cleanup rejection into one failure exit", async () => {
    const harness = runtimeHarness({
      close: (() => { throw new Error("synchronous close failure"); }) as () => Promise<void>,
      cleanup: async () => { throw new Error("cleanup failure"); },
    });
    await harness.runtime.shutdown("SIGTERM");
    await expect(harness.runtime.completion).resolves.toBe(1);
    const output = harness.stderrWrites.join("");
    expect(output).toContain("cleanup: cleanup failure");
    expect(output).toContain("transport: synchronous close failure");
    expect(output.indexOf("cleanup:")).toBeLessThan(output.indexOf("transport:"));
    expect(harness.exits).toEqual([1]);
  });

  it("keeps a handler for a close rejection that arrives after the close timeout", async () => {
    vi.useFakeTimers();
    const close = deferred<void>(), cleanup = deferred<void>();
    const harness = runtimeHarness({ close: () => close.promise, cleanup: () => cleanup.promise });
    const shutdown = harness.runtime.shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(51);
    expect(harness.exits).toEqual([]);
    close.reject(new Error("late close rejection"));
    cleanup.resolve();
    await shutdown;
    expect(harness.exits).toEqual([1]);
    expect(harness.stderrWrites.join("")).toContain("close timed out");
  });

  it("treats shutdown-time SDK errors as failure even when close resolves", async () => {
    const cleanup = deferred<void>();
    const close = deferred<void>();
    const harness = runtimeHarness({ cleanup: () => cleanup.promise, close: () => close.promise });
    const shutdown = harness.runtime.shutdown("SIGHUP");
    harness.sdkErrors[0]?.(new Error("transport callback failed"));
    cleanup.resolve();
    close.resolve();
    await shutdown;
    await expect(harness.runtime.completion).resolves.toBe(1);
    expect(harness.stderrWrites.join("")).toContain("transport callback failed");
  });

  it("continues cleanup and close when pausing stdin throws", async () => {
    const harness = runtimeHarness({ pause: () => { throw new Error("pause failed"); } });
    await harness.runtime.shutdown("EOF");
    await expect(harness.runtime.completion).resolves.toBe(1);
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("exits zero after normal EOF and ignores repeated signal and EOF handlers", async () => {
    const harness = runtimeHarness();
    harness.handlers.get("end")?.();
    harness.handlers.get("SIGTERM")?.();
    harness.handlers.get("SIGINT")?.();
    await expect(harness.runtime.completion).resolves.toBe(0);
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.exits).toEqual([0]);
  });

  it("bounds shutdown diagnostics when transport reports an error flood", async () => {
    const harness = runtimeHarness({ cleanup: async () => { throw new Error("cleanup must remain visible"); } });
    const shutdown = harness.runtime.shutdown("EOF");
    for (let index = 0; index < 24; index += 1) {
      harness.sdkErrors[0]?.(new Error(`callback-${index}-${"😀".repeat(1_000)}`));
    }
    await shutdown;
    const output = harness.stderrWrites.join("");
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(8 * 1_024);
    expect(output).toContain("diagnostics truncated");
    expect(output).toMatch(/\d+ omitted/);
    expect(output).toContain("cleanup must remain visible");
    expect(harness.exits).toEqual([1]);
  });

  it("does not turn a pre-shutdown SDK error into a failed normal close", async () => {
    const h = runtimeHarness(); h.sdkErrors[0]?.(new Error("ordinary protocol error"));
    expect(h.cleanup).not.toHaveBeenCalled();
    await h.runtime.shutdown("EOF");
    expect(h.exits).toEqual([0]);
  });

  it("does not skip cleanup when stderr.write throws", async () => {
    const h = runtimeHarness({ write: () => { throw new Error("stderr write failed"); } });
    await h.runtime.shutdown("EOF");
    expect(h.cleanup).toHaveBeenCalledTimes(1); expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.exits).toEqual([1]);
  });

  it("bounds blocked stderr flushes and observes late stream errors", async () => {
    vi.useFakeTimers();
    const h = runtimeHarness({ write: () => false });
    const shutdown = h.runtime.shutdown("EOF");
    await vi.advanceTimersByTimeAsync(51);
    expect(h.exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(51);
    await shutdown;
    expect(h.exits).toEqual([1]);
    expect(() => h.stderrEvents.emit("error", new Error("late EPIPE"))).not.toThrow();
    expect(h.exits).toEqual([1]);
  });

  it("retains stdout and SDK callback failures until cleanup finishes", async () => {
    const cleanup = deferred<void>();
    const h = runtimeHarness({ cleanup: () => cleanup.promise });
    const shutdown = h.runtime.shutdown("EOF");
    h.stdoutEvents.emit("error", new Error("stdout EPIPE"));
    await Promise.resolve(); expect(h.exits).toEqual([]);
    cleanup.resolve(); await shutdown;
    expect(h.exits).toEqual([1]); expect(h.stderrWrites.join("")).toContain("stdout EPIPE");
  });
});
