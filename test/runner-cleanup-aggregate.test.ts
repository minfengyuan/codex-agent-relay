import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayFailure } from "../src/types.js";
import { cleanupAllChildren, CursorRunner, GrokRunner, OpenCodeRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";
import { baseConfig, cleanupDirs, tempDir } from "./helpers.js";

const dirs: string[] = [];
const releaseGates: Array<() => void> = [];

afterEach(async () => {
  for (const release of releaseGates.splice(0)) release();
  vi.unstubAllEnvs();
  try {
    await cleanupAllChildren();
  } catch {
    // Individual tests assert the aggregate result; teardown only reaps leftovers.
  } finally {
    await cleanupDirs(dirs);
  }
});

describe("process-wide cleanup aggregation", () => {
  it("does not report an ordinary cancelled pre-spawn task as a cleanup failure", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const stateDir = await tempDir(dirs);
    const cwd = await tempDir(dirs);
    const gate = deferred<void>();
    releaseGates.push(() => gate.resolve());
    const started = deferred<void>();
    class BlockingStore extends SessionStore {
      override async acquire(path: string) {
        const lease = await super.acquire(path);
        started.resolve();
        await gate.promise;
        return lease;
      }
    }
    const task = new GrokRunner(baseConfig(stateDir), new BlockingStore(stateDir)).delegate({ task: "blocked", cwd });
    const rejected = expect(task).rejects.toMatchObject({ code: "CANCELLED" });
    await started.promise;

    const cleanup = cleanupAllChildren();
    gate.resolve(undefined);
    await expect(cleanup).resolves.toBeUndefined();
    await rejected;
  }, 15_000);

  it("waits for every task and bounds diagnostics when more than sixteen lease releases fail", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const stateDir = await tempDir(dirs);
    const count = 17;
    const gate = deferred<void>();
    releaseGates.push(() => gate.resolve());
    const allStarted = deferred<void>();
    let acquired = 0;
    class FailingReleaseStore extends SessionStore {
      override async acquire(cwd: string) {
        const lease = await super.acquire(cwd);
        acquired += 1;
        if (acquired === count) allStarted.resolve();
        await gate.promise;
        lease.release = async () => {
          throw new RelayFailure("LOCK_IO", `release failed ${cwd}: ${"x".repeat(1_000)}`);
        };
        return lease;
      }
    }
    const stores = Array.from({ length: count }, (_, index) => new FailingReleaseStore(stateDir, `aggregate-${index}`));
    const cwds = await Promise.all(Array.from({ length: count }, (_, index) => tempDir(dirs, `relay-cleanup-${index}-`)));
    const tasks = cwds.map((cwd, index) => {
      const Runner = [GrokRunner, CursorRunner, OpenCodeRunner][index % 3]!;
      const task = new Runner(baseConfig(stateDir), stores[index]!).delegate({ task: `blocked-${index}`, cwd });
      void task.catch(() => undefined);
      return task;
    });
    await allStarted.promise;

    const cleanup = cleanupAllChildren();
    gate.resolve(undefined);
    const aggregate = await cleanup.then(
      () => { throw new Error("expected cleanup aggregation"); },
      (error: unknown) => error as {
        name: string;
        primaryCode: string;
        taskCount: number;
        failureCount: number;
        diagnostics: Array<{ code: string; message: string }>;
        omittedCount: number;
        truncated: boolean;
        message: string;
      },
    );
    expect(aggregate).toMatchObject({
      name: "CleanupAggregateError",
      primaryCode: "LOCK_IO",
      taskCount: count,
      failureCount: count,
      truncated: true,
    });
    expect(aggregate.diagnostics.length).toBeLessThanOrEqual(16);
    expect(aggregate.omittedCount).toBeGreaterThan(0);
    expect(Buffer.byteLength(aggregate.message)).toBeLessThanOrEqual(8 * 1_024);
    expect(aggregate.diagnostics.reduce((bytes, item) => bytes + Buffer.byteLength(item.code) + 2 + Buffer.byteLength(item.message), 0))
      .toBeLessThanOrEqual(8 * 1_024);
    await Promise.all(tasks.map((task) => expect(task).rejects.toMatchObject({ code: "LOCK_IO" })));
  }, 45_000);

  it("keeps every task report while selecting ownership loss ahead of lock I/O", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const stateDir = await tempDir(dirs);
    const cwds = await Promise.all([tempDir(dirs, "relay-owner-"), tempDir(dirs, "relay-io-")]);
    const gate = deferred<void>();
    releaseGates.push(() => gate.resolve());
    const bothStarted = deferred<void>();
    let acquired = 0;
    class BarrierStore extends SessionStore {
      constructor(state: string, private readonly failure: "ownership" | "io") { super(state, failure); }
      override async acquire(cwd: string) {
        const lease = await super.acquire(cwd);
        acquired += 1;
        if (acquired === 2) bothStarted.resolve();
        await gate.promise;
        if (this.failure === "ownership") {
          lease.markTerminating = async () => { throw new RelayFailure("LOCK_OWNERSHIP_LOST", "token replaced"); };
          lease.markReaped = async () => { throw new RelayFailure("LOCK_OWNERSHIP_LOST", "token replaced"); };
        } else {
          lease.release = async () => { throw new RelayFailure("LOCK_IO", "release I/O failed"); };
        }
        return lease;
      }
    }
    const tasks = cwds.map((cwd, index) => new GrokRunner(
      baseConfig(stateDir),
      new BarrierStore(stateDir, index === 0 ? "ownership" : "io"),
    ).delegate({ task: "blocked", cwd }));
    tasks.forEach((task) => { void task.catch(() => undefined); });
    await bothStarted.promise;

    const cleanup = cleanupAllChildren();
    gate.resolve(undefined);
    const aggregate = await cleanup.then(
      () => { throw new Error("expected cleanup aggregation"); },
      (error: unknown) => error as { primaryCode: string; failureCount: number; diagnostics: Array<{ code: string }> },
    );
    expect(aggregate.primaryCode).toBe("LOCK_OWNERSHIP_LOST");
    expect(aggregate.failureCount).toBe(2);
    expect(aggregate.diagnostics).toHaveLength(2);
    expect(aggregate.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(["LOCK_OWNERSHIP_LOST", "LOCK_IO"]));
    await expect(tasks[0]).rejects.toMatchObject({ code: "LOCK_OWNERSHIP_LOST" });
    await expect(tasks[1]).rejects.toMatchObject({ code: "LOCK_IO" });
  }, 15_000);
});

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
