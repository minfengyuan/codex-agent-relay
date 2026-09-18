import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

const [log, mode] = process.argv.slice(2);
const record = (event) => appendFileSync(log, `${JSON.stringify(event)}\n`);
let writer;
record({ event: "worker", pid: process.pid });
process.on("SIGTERM", () => {
  if (!writer || writer.exitCode !== null || writer.signalCode !== null) process.exit(0);
  writer.once("exit", () => process.exit(0));
  writer.kill("SIGTERM");
});
acp.agent({ name: "cli-lifecycle-fixture" })
  .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "cached_token", name: "Fixture token" }] }))
  .onRequest(acp.methods.agent.authenticate, () => ({}))
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: `cli-fixture-${process.pid}` }))
  .onRequest(acp.methods.agent.session.prompt, async ({ params }) => {
    if (mode === "writer") {
      const output = join(process.cwd(), "writes.txt");
      writer = spawn(process.execPath, ["-e",
        "const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),10);fs.appendFileSync(process.argv[1],'x');process.send('ready');",
        output], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true, shell: false, detached: process.platform === "win32" });
      record({ event: "descendant", pid: writer.pid, cwd: process.cwd() });
      await new Promise((resolve, reject) => { writer.once("message", resolve); writer.once("error", reject); });
    }
    record({ event: "prompt", cwd: process.cwd(), sessionId: params.sessionId });
    return new Promise(() => {});
  })
  .onNotification(acp.methods.agent.session.cancel, () => { record({ event: "cancel", pid: process.pid }); })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
