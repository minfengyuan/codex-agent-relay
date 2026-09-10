import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CursorRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";

const enabled = process.env.RUN_CURSOR_REAL_TESTS === "1" || process.env.npm_lifecycle_event === "test:real:cursor";
const describeReal = enabled ? describe : describe.skip;
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describeReal("real Cursor ACP smoke", () => {
  it("creates and resumes ask mode, then edits a disposable workspace in agent mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-real-"));
    roots.push(root);
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".cursor"), { recursive: true });
    await writeFile(join(workspace, ".cursor", "cli.json"), `${JSON.stringify({
      permissions: { allow: ["Write(smoke.txt)"], deny: ["Write(**/*.key)"] },
    })}\n`);
    const config = loadConfig();
    const store = new SessionStore(state, "cursor");
    const runner = new CursorRunner(config, store);
    const nonce = randomUUID();
    const ask = await runner.delegate({ task: `Remember ${nonce} and reply with exactly STORED.`, cwd: workspace, mode: "ask" });
    expect(ask.text).toContain("STORED");
    const resumed = await runner.delegate({ task: "Reply with the exact nonce I asked you to remember.", cwd: workspace, sessionId: ask.sessionId as string });
    expect(resumed.text).toContain(nonce);
    const edit = await runner.delegate({ task: "Create smoke.txt containing exactly cursor-smoke followed by a newline.", cwd: workspace });
    expect(edit.error).toBeUndefined();
    expect(await readFile(join(workspace, "smoke.txt"), "utf8")).toBe("cursor-smoke\n");
  }, 180_000);

  it("reports PERMISSION_REQUIRED when the local native policy produces an approval request", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "cursor-real-permission-"));
    roots.push(root);
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const runner = new CursorRunner(loadConfig(), new SessionStore(state, "cursor"));
    try {
      await runner.delegate({ task: "Create permission-probe.txt containing probe.", cwd: workspace });
      context.skip("The effective native Cursor policy allowed the write without an ACP permission request");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "PERMISSION_REQUIRED") throw error;
      expect(error).toMatchObject({
        code: "PERMISSION_REQUIRED",
        partial: { interactions: [expect.objectContaining({ type: "permission", outcome: "rejected" })] },
      });
    }
  }, 180_000);
});
