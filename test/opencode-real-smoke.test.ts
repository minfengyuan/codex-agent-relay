import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { OpenCodeRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";

const enabled = process.env.RUN_OPENCODE_REAL_TESTS === "1" || process.env.npm_lifecycle_event === "test:real:opencode";
const describeReal = enabled ? describe : describe.skip;
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describeReal("real OpenCode ACP smoke", () => {
  it("creates, resumes across processes, force-loads, and edits a disposable workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-real-"));
    roots.push(root);
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "README.md"), "workspace\n");
    const config = loadConfig();
    const nonce = randomUUID();
    const created = await new OpenCodeRunner(config, new SessionStore(state, "opencode")).delegate({
      task: `Remember ${nonce} and reply with exactly STORED. Do not write the nonce to a file.`,
      cwd: workspace,
    });
    expect(created.provider).toBe("opencode");
    expect(created.sessionId).toBeTruthy();
    expect(created.text).toContain("STORED");
    const resumed = await new OpenCodeRunner(config, new SessionStore(state, "opencode")).delegate({
      task: "Reply with the exact nonce I asked you to remember.",
      cwd: workspace,
      sessionId: created.sessionId as string,
    });
    expect(resumed.sessionId).toBe(created.sessionId);
    expect(resumed.text).toContain(nonce);
    const loaded = await new OpenCodeRunner(config, new SessionStore(state, "opencode")).delegate({
      task: "Reply with exactly LOADED.",
      cwd: workspace,
      sessionId: created.sessionId as string,
      resume: false,
    });
    expect(loaded.sessionId).toBe(created.sessionId);
    expect(loaded.text).toContain("LOADED");
    const edit = await new OpenCodeRunner(config, new SessionStore(state, "opencode")).delegate({
      task: "Create smoke.txt containing exactly opencode-smoke followed by a newline. Do not ask questions.",
      cwd: workspace,
    });
    expect(edit.error).toBeUndefined();
    expect(await readFile(join(workspace, "smoke.txt"), "utf8")).toBe("opencode-smoke\n");
  }, 180_000);

  it("approves allow_once permission requests so a workspace edit can complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-real-permission-"));
    roots.push(root);
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "opencode.json"), `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      agent: {
        build: {
          permission: {
            edit: "ask",
            bash: "deny",
          },
        },
      },
    })}\n`);
    const result = await new OpenCodeRunner(loadConfig(), new SessionStore(state, "opencode")).delegate({
      task: "Using the built-in edit or write tool only (not bash or a shell command), create permission-probe.txt containing exactly probe followed by a newline. Do not ask questions.",
      cwd: workspace,
      agent: "build",
    });
    expect(result.error).toBeUndefined();
    expect(await readFile(join(workspace, "permission-probe.txt"), "utf8")).toBe("probe\n");
  }, 180_000);
});
