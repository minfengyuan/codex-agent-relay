#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { cleanupAllChildren } from "./runner.js";
import { createRelayServer } from "./server.js";

const config = loadConfig();
const handle = serveStdio(() => createRelayServer(config), {
  onerror: (error) => console.error(`[codex-agent-relay] ${error.message}`),
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[codex-agent-relay] received ${signal}; cleaning up`);
  process.stdin.pause();
  await handle.close();
  await cleanupAllChildren();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => { void shutdown(signal); });
}

process.stdin.once("end", () => { void shutdown("SIGHUP"); });
