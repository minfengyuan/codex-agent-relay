import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../../dist/cli-runtime.js";
import { beginRunnerShutdown, GrokRunner } from "../../dist/runner.js";
import { SessionStore } from "../../dist/store.js";

const [stateDir, log, mode] = process.argv.slice(2);
const config = {
  command: process.execPath,
  commandArgs: [join(dirname(fileURLToPath(import.meta.url)), "cli-worker.mjs"), log,
    mode === "writer" || mode === "unconfirmed" ? "writer" : "hang"],
  stateDir, phaseTimeoutMs: 2000, totalTimeoutMs: 15000,
  cancelGraceMs: 100, termGraceMs: 100, killConfirmMs: 5000,
  textLimitBytes: 262144, stderrLimitBytes: 65536, progressIntervalMs: 1,
};
let finish;
const barrier = new Promise((resolve) => { finish = resolve; });
const runtime = runCli(config, {
  beginShutdown: () => {
    const cleanup = beginRunnerShutdown();
    return mode === "gate" ? cleanup.then(() => barrier) : cleanup;
  },
  serveStdio: (factory, options) => {
    const handle = serveStdio(factory, options);
    return mode === "close-failure" ? { close: () => { throw new Error("injected close failure"); } } : handle;
  },
});
process.on("message", async (message) => {
  if (message.action === "finish") { finish(); return; }
  if (message.action !== "shutdown") return;
  if (mode === "unconfirmed") {
    if (process.platform === "win32") process.env.SystemRoot = "";
    else {
      const kill = process.kill.bind(process);
      process.kill = (pid, signal) => {
        if (pid < 0 && signal !== 0) throw Object.assign(new Error("injected group permission failure"), { code: "EPERM" });
        return kill(pid, signal);
      };
    }
  }
  const first = runtime.shutdown("SIGTERM"), second = runtime.shutdown("SIGINT");
  if (mode === "gate") {
    try {
      await new GrokRunner(config, new SessionStore(stateDir)).delegate({ task: "rejected", cwd: message.cwd });
      process.send({ event: "gate-result", code: "UNEXPECTED_SUCCESS", same: first === second });
    } catch (error) {
      process.send({ event: "gate-result", code: error.code, same: first === second });
    }
  }
});
