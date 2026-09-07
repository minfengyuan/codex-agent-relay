import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
setInterval(() => {}, 1_000);
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: "cached_token", name: "Cached token" }],
    });
  } else if (message.method === "authenticate") {
    reply(message.id, {});
  } else if (message.method === "session/new") {
    reply(message.id, { sessionId: "backpressure-session" });
    setImmediate(() => {
      lines.pause();
      process.stdin.pause();
    });
  }
});
