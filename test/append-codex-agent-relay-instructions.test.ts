import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/append-codex-agent-relay-instructions.mjs", import.meta.url));
const startMarker = "<!-- CODEX-AGENT-RELAY_START -->";
const endMarker = "<!-- CODEX-AGENT-RELAY_END -->";
const legacyStartMarker = "<!-- GROK-BUILD_START -->";
const legacyEndMarker = "<!-- GROK-BUILD_END -->";
const tempDirectories: string[] = [];

async function tempCodexHome(): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/codex-agent-relay-`);
  tempDirectories.push(root);
  return `${root}/codex-home`;
}

async function run(codexHome: string) {
  return execFileAsync(process.execPath, [script], {
    env: { ...process.env, CODEX_HOME: codexHome },
  });
}

describe("append-codex-agent-relay-instructions", () => {
  afterEach(async () => Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ));

  it("creates AGENTS.md and remains idempotent", async () => {
    const codexHome = await tempCodexHome();

    await run(codexHome);
    const first = await readFile(`${codexHome}/AGENTS.md`, "utf8");
    await run(codexHome);
    const second = await readFile(`${codexHome}/AGENTS.md`, "utf8");

    expect(first).toContain("## External coding agents");
    expect(first).toContain("`grok_delegate`");
    expect(first).toContain("`cursor_delegate`");
    expect(first).toContain("`opencode_delegate`");
    expect(first).toContain("PERMISSION_REQUIRED");
    expect(first).toContain("allow_once");
    expect(first).toContain(startMarker);
    expect(first).toContain(endMarker);
    expect(first).not.toContain(legacyStartMarker);
    expect(first).not.toContain(legacyEndMarker);
    expect(first.match(new RegExp(startMarker, "g"))).toHaveLength(1);
    expect(second).toBe(first);
  });

  it("preserves existing instructions and updates the managed block in place", async () => {
    const codexHome = await tempCodexHome();
    await mkdir(codexHome);
    await writeFile(
      `${codexHome}/AGENTS.md`,
      `# Existing\n\n${startMarker}\nOld instructions\n${endMarker}\n\nAfter\n`,
    );

    await run(codexHome);
    const content = await readFile(`${codexHome}/AGENTS.md`, "utf8");

    expect(content).toMatch(/^# Existing\n\n/);
    expect(content).toContain("Pass the absolute workspace/worktree path as cwd");
    expect(content).not.toContain("Old instructions");
    expect(content).toMatch(/\n\nAfter\n$/);
    expect(content).toContain(startMarker);
    expect(content).not.toContain(legacyStartMarker);
  });

  it("replaces a legacy GROK-BUILD block in place with the new managed block", async () => {
    const codexHome = await tempCodexHome();
    await mkdir(codexHome);
    await writeFile(
      `${codexHome}/AGENTS.md`,
      `# Existing\n\n${legacyStartMarker}\nOld instructions\n${legacyEndMarker}\n\nAfter\n`,
    );

    await run(codexHome);
    const content = await readFile(`${codexHome}/AGENTS.md`, "utf8");

    expect(content).toMatch(/^# Existing\n\n/);
    expect(content).toContain("Pass the absolute workspace/worktree path as cwd");
    expect(content).toContain(startMarker);
    expect(content).toContain(endMarker);
    expect(content).not.toContain("Old instructions");
    expect(content).not.toContain(legacyStartMarker);
    expect(content).not.toContain(legacyEndMarker);
    expect(content).toMatch(/\n\nAfter\n$/);
    expect(content.match(new RegExp(startMarker, "g"))).toHaveLength(1);

    await run(codexHome);
    expect(await readFile(`${codexHome}/AGENTS.md`, "utf8")).toBe(content);
  });

  it("rejects malformed managed markers without changing the file", async () => {
    const codexHome = await tempCodexHome();
    const original = `# Existing\n\n${startMarker}\nIncomplete\n`;
    await mkdir(codexHome);
    await writeFile(`${codexHome}/AGENTS.md`, original);

    await expect(run(codexHome)).rejects.toMatchObject({ code: 1 });
    await expect(readFile(`${codexHome}/AGENTS.md`, "utf8")).resolves.toBe(original);
  });

  it("rejects malformed legacy managed markers without changing the file", async () => {
    const codexHome = await tempCodexHome();
    const original = `# Existing\n\n${legacyStartMarker}\nIncomplete\n`;
    await mkdir(codexHome);
    await writeFile(`${codexHome}/AGENTS.md`, original);

    await expect(run(codexHome)).rejects.toMatchObject({ code: 1 });
    await expect(readFile(`${codexHome}/AGENTS.md`, "utf8")).resolves.toBe(original);
  });

  it("rejects mixed new and legacy managed blocks without changing the file", async () => {
    const codexHome = await tempCodexHome();
    const original = `${startMarker}\nnew\n${endMarker}\n${legacyStartMarker}\nold\n${legacyEndMarker}\n`;
    await mkdir(codexHome);
    await writeFile(`${codexHome}/AGENTS.md`, original);

    await expect(run(codexHome)).rejects.toMatchObject({ code: 1 });
    await expect(readFile(`${codexHome}/AGENTS.md`, "utf8")).resolves.toBe(original);
  });

  it("warns when AGENTS.override.md masks the global AGENTS.md", async () => {
    const codexHome = await tempCodexHome();
    await mkdir(codexHome);
    await writeFile(`${codexHome}/AGENTS.override.md`, "# Override\n");

    const result = await run(codexHome);

    expect(result.stderr).toContain("takes precedence over AGENTS.md");
  });
});
