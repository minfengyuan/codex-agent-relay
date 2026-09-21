import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dshSpawnSpec } from "../src/adapters/dsh.js";
import { loadConfig } from "../src/config.js";
import { cleanupAllChildren, DshRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";

const execFileAsync = promisify(execFile);
const enabled = process.env.RUN_DSH_REAL_TESTS === "1" || process.env.npm_lifecycle_event === "test:real:dsh";
const describeReal = enabled ? describe : describe.skip;
const roots: string[] = [];
// Three sequential turns, CLI preflight, and cleanup must fit inside the test.
const TEST_TIMEOUT_MS = 600_000;
const TASK_TIMEOUT_MS = 150_000;

afterEach(async () => {
  vi.unstubAllEnvs();
  try {
    await cleanupAllChildren();
  } finally {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  }
});

async function assertNoActiveLease(state: string, cwd: string): Promise<void> {
  const lease = await new SessionStore(state, "dsh").acquire(cwd);
  await lease.markReaped("no-worker-created");
  await lease.release();
}

describeReal("real DSH ACP smoke", () => {
  it("creates, resumes across processes, and edits a disposable workspace", async () => {
    if (process.env.CODEX_AGENT_RELAY_DELEGATED === "1") {
      throw new Error("Real DSH smoke is unavailable inside a delegated worker (NESTED_DELEGATION); run it from the parent environment");
    }
    const loaded = loadConfig();
    const version = dshSpawnSpec({ ...loaded, dshCommandArgs: ["--version"] });
    await execFileAsync(version.command, version.args, { timeout: 15_000 });
    const help = dshSpawnSpec({ ...loaded, dshCommandArgs: ["--profile", "acp", "--help"] });
    await execFileAsync(help.command, help.args, { timeout: 15_000 });

    const root = await mkdtemp(join(tmpdir(), "dsh-real-"));
    roots.push(root);
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "README.md"), "workspace\n");
    const config = { ...loaded, stateDir: state, totalTimeoutMs: TASK_TIMEOUT_MS };
    const nonce = randomUUID();
    try {
      const created = await new DshRunner(config, new SessionStore(state, "dsh")).delegate({
        task: `Remember ${nonce} and reply with exactly STORED. Do not write the nonce to a file.`,
        cwd: workspace,
      });
      expect(created.provider).toBe("dsh");
      expect(created.sessionId).toBeTruthy();
      expect(created.text).toContain("STORED");
      expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("workspace\n");
      const names = await readdir(workspace);
      expect(names.filter((name) => !name.startsWith("."))).toEqual(["README.md"]);
      await assertNoActiveLease(state, workspace);

      await cleanupAllChildren();
      const resumed = await new DshRunner(config, new SessionStore(state, "dsh")).delegate({
        task: "Reply with the exact nonce I asked you to remember. Do not read files to recover it.",
        cwd: workspace,
        sessionId: created.sessionId as string,
      });
      expect(resumed.sessionId).toBe(created.sessionId);
      expect(resumed.text).toContain(nonce);
      await assertNoActiveLease(state, workspace);

      const edit = await new DshRunner(config, new SessionStore(state, "dsh")).delegate({
        task: "Create smoke.txt containing exactly dsh-smoke followed by a newline. Do not ask questions.",
        cwd: workspace,
      });
      expect(edit.error).toBeUndefined();
      expect(await readFile(join(workspace, "smoke.txt"), "utf8")).toBe("dsh-smoke\n");
      await assertNoActiveLease(state, workspace);
    } finally {
      await cleanupAllChildren();
    }
  }, TEST_TIMEOUT_MS);

  it("optionally resumes after setting DSH_TEST_MODEL and DSH_TEST_REASONING_EFFORT", async (context) => {
    if (process.env.CODEX_AGENT_RELAY_DELEGATED === "1") {
      throw new Error("Real DSH smoke is unavailable inside a delegated worker (NESTED_DELEGATION); run it from the parent environment");
    }
    const model = process.env.DSH_TEST_MODEL?.trim();
    const reasoningEffort = process.env.DSH_TEST_REASONING_EFFORT?.trim();
    if (!model && !reasoningEffort) {
      context.skip("DSH_TEST_MODEL / DSH_TEST_REASONING_EFFORT not set; config resume unverified");
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "dsh-real-config-"));
    roots.push(root);
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const config = { ...loadConfig(), stateDir: state, totalTimeoutMs: TASK_TIMEOUT_MS };
    try {
      const created = await new DshRunner(config, new SessionStore(state, "dsh")).delegate({
        task: "Reply with exactly READY.",
        cwd: workspace,
      });
      await assertNoActiveLease(state, workspace);
      await cleanupAllChildren();
      const resumed = await new DshRunner(config, new SessionStore(state, "dsh")).delegate({
        task: "Reply with exactly CONFIGURED.",
        cwd: workspace,
        sessionId: created.sessionId as string,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
      expect(resumed.text).toContain("CONFIGURED");
      await assertNoActiveLease(state, workspace);
    } finally {
      await cleanupAllChildren();
    }
  }, TEST_TIMEOUT_MS);
});
