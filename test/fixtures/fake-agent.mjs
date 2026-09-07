import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

const mode = process.env.FAKE_ACP_MODE ?? "normal";
const sessionId = process.env.FAKE_SESSION_ID ?? "fake-session-1";
const log = (line) => {
  if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${line}\n`);
};

if (mode === "malformed") {
  process.stdout.write("{definitely-not-json}\n");
} else if (mode === "exit") {
  process.exit(19);
} else {
  let cancelled = false;
  acp.agent({ name: "fake-grok" })
    .onRequest(acp.methods.agent.initialize, (ctx) => {
      log(`initialize:${JSON.stringify(ctx.params.clientCapabilities)}`);
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: mode !== "no-load" },
        authMethods: mode === "no-auth" ? [] : [
          { id: "cached_token", name: "Cached token" },
          { id: "xai.api_key", name: "API key" },
        ],
      };
    })
    .onRequest(acp.methods.agent.authenticate, (ctx) => {
      log(`auth:${ctx.params.methodId}:${JSON.stringify(ctx.params._meta)}`);
      return {};
    })
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      log(`new:${ctx.params.cwd}:${ctx.params.mcpServers.length}`);
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      log(`load:${ctx.params.sessionId}:${ctx.params.cwd}:${ctx.params.mcpServers.length}`);
      if (mode === "load-fail") throw new Error("load rejected");
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD HISTORY" } },
      });
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      log(`prompt:${ctx.params.sessionId}`);
      if (mode === "unknown-request") {
        try { await ctx.client.request("vendor/unknown", {}); }
        catch { log("unknown-rejected"); }
      }
      if (mode === "descendant") {
        const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
          stdio: "ignore",
        });
        log(`descendant:${descendant.pid}`);
        descendant.unref();
      }
      if (mode === "permission") {
        await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: { toolCallId: "t1", title: "permission", status: "pending", content: [] },
          options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }],
        });
        while (!cancelled) await new Promise((resolve) => setTimeout(resolve, 10));
        return { stopReason: "cancelled" };
      }
      if (mode === "hang") {
        while (!cancelled) await new Promise((resolve) => setTimeout(resolve, 10));
        return { stopReason: "cancelled" };
      }
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Fake tool", status: "in_progress", content: [] },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: mode === "large" ? "x".repeat(10000) : mode === "unicode" ? "😀".repeat(1000) : "fresh answer" },
        },
      });
      return { stopReason: "end_turn" };
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      log(`cancel:${ctx.params.sessionId}`);
      cancelled = true;
    })
    .connect(acp.ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin),
    ));
}
