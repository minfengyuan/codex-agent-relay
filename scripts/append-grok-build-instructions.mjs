#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { env } from "node:process";
import { log, warn } from "node:console";

const START_MARKER = "<!-- GROK-BUILD_START -->";
const END_MARKER = "<!-- GROK-BUILD_END -->";
const INSTRUCTIONS = `<!-- GROK-BUILD_START -->
## Grok Build delegation

The \`grok_delegate\` tool delegates implementation work to Grok Build.

Use it when:
  - the user explicitly asks Grok Build to implement something;
  - a self-contained implementation task can be delegated;
  - parallel implementation in a separate worktree is useful.

When delegating:
  - pass the absolute workspace/worktree path as cwd;
  - give Grok Build a complete task specification;
  - let Grok Build edit files directly;
  - after completion, inspect and review its changes yourself;
  - do not duplicate the implementation unless its result is incomplete.
<!-- GROK-BUILD_END -->`;

function applyInstructions(content) {
  const start = content.indexOf(START_MARKER);
  const end = content.indexOf(END_MARKER);

  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error(`Cannot update AGENTS.md: found an incomplete or misordered ${START_MARKER} block`);
  }

  if (start !== -1) {
    const duplicateStart = content.indexOf(START_MARKER, start + START_MARKER.length);
    const duplicateEnd = content.indexOf(END_MARKER, end + END_MARKER.length);
    if (duplicateStart !== -1 || duplicateEnd !== -1) {
      throw new Error(`Cannot update AGENTS.md: found multiple ${START_MARKER} blocks`);
    }

    const blockEnd = end + END_MARKER.length;
    return `${content.slice(0, start)}${INSTRUCTIONS}${content.slice(blockEnd)}`;
  }

  const separator = content.length === 0 ? "" : content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${INSTRUCTIONS}\n`;
}

async function readIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

const configuredHome = env.CODEX_HOME?.trim();
const codexHome = configuredHome ? resolve(configuredHome) : join(homedir(), ".codex");
const agentsPath = join(codexHome, "AGENTS.md");
const overridePath = join(codexHome, "AGENTS.override.md");

await mkdir(codexHome, { recursive: true });
const current = await readIfPresent(agentsPath);
const updated = applyInstructions(current);

if (updated === current) {
  log(`Grok Build instructions are already present in ${agentsPath}`);
} else {
  await writeFile(agentsPath, updated, "utf8");
  log(`Updated ${agentsPath} with Grok Build instructions`);
}

if ((await readIfPresent(overridePath)).trim()) {
  warn(`Warning: ${overridePath} takes precedence over AGENTS.md, so the appended instructions will not be loaded`);
}
