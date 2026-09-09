#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { env } from "node:process";
import { log, warn } from "node:console";

const START_MARKER = "<!-- GROK-BUILD_START -->";
const END_MARKER = "<!-- GROK-BUILD_END -->";
const INSTRUCTIONS = `<!-- GROK-BUILD_START -->
## External coding agents

Codex owns planning, delegation, review, and integration. External agents execute bounded tasks in the supplied workspace/worktree.

- Use \`grok_delegate\` for self-contained implementation work or an explicit Grok Build request.
- Use \`cursor_delegate\` for Cursor implementation tasks or focused analysis in \`ask\` mode; an optional \`model\` selects the startup model.
- Use \`opencode_delegate\` for OpenCode implementation work. Optional \`model\`, \`effort\`, and \`agent\` change the live session configuration; omitted fields keep OpenCode's restored or default state.

When delegating:

- Pass the absolute workspace/worktree path as cwd and a complete task specification.
- Use separate worktrees for parallel writers; a worktree is not a security boundary.
- Let the selected agent edit files directly, then inspect the diff and verify relevant tests before integration.
- Do not duplicate completed implementation work unless the result is incomplete.
- Cursor uses its native permission rules and sandbox. On PERMISSION_REQUIRED, review the returned request and coordinate any policy change before resuming; do not retry to bypass the rejection.
- OpenCode auto-selects the request's \`allow_once\` permission option. On PERMISSION_REQUIRED, \`allow_once\` was missing; review the failure and do not treat a retry as extra approval.
- OpenCode's child \`question: deny\` overlay can be overridden by agent-specific rules. The worker is noninteractive and will time out if it waits for a user; this is not hard isolation.
- Keep this relay out of downstream agents' MCP configuration to avoid recursive delegation.
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
  log(`External coding agent instructions are already present in ${agentsPath}`);
} else {
  await writeFile(agentsPath, updated, "utf8");
  log(`Updated ${agentsPath} with external coding agent instructions`);
}

if ((await readIfPresent(overridePath)).trim()) {
  warn(`Warning: ${overridePath} takes precedence over AGENTS.md, so the appended instructions will not be loaded`);
}
