import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

const mode = process.env.FAKE_ACP_MODE ?? "normal";
const sessionId = process.env.FAKE_SESSION_ID ?? "fake-session-1";
const isCursor = process.argv.includes("acp");
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
      log(`client:${JSON.stringify(ctx.params.clientInfo)}`);
      log(`argv:${JSON.stringify(process.argv.slice(2))}`);
      log(`delegated:${process.env.CODEX_AGENT_RELAY_DELEGATED ?? ""}`);
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: mode !== "no-load" },
        authMethods: mode === "no-auth" ? [] : isCursor ? [
          { id: "cursor_login", name: "Cursor login" },
        ] : [
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
      return { sessionId, ...(isCursor ? { modes: cursorModes() } : {}) };
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      log(`load:${ctx.params.sessionId}:${ctx.params.cwd}:${ctx.params.mcpServers.length}`);
      if (mode === "load-fail") throw new Error("load rejected");
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD HISTORY" } },
      });
      return isCursor ? { modes: cursorModes() } : {};
    })
    .onRequest(acp.methods.agent.session.setMode, (ctx) => {
      log(`set-mode:${ctx.params.sessionId}:${ctx.params.modeId}`);
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      log(`prompt:${ctx.params.sessionId}`);
      log(`prompt-text:${ctx.params.prompt[0]?.text ?? ""}`);
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
      if (mode === "descendant-write") {
        const descendant = spawn(process.execPath, ["-e", "const fs=require('node:fs');fs.appendFileSync(process.argv[1],'x');process.send('ready');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),10)", process.env.FAKE_DESCENDANT_OUTPUT], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        await new Promise((resolve) => descendant.once("message", resolve));
        log(`descendant:${descendant.pid}`);
        descendant.unref();
      }
      if (mode === "permission" || mode === "permission-basic" || mode === "permission-no-reject") {
        const outcome = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: {
            toolCallId: "t1",
            title: "Shell",
            status: "pending",
            content: [],
            ...(mode === "permission-basic" ? {} : {
              rawInput: { command: "touch denied.txt" },
              locations: [{ path: "/tmp/denied.txt", line: 1 }],
            }),
          },
          options: mode === "permission-no-reject"
            ? [{ optionId: "yes", name: "Yes", kind: "allow_once" }]
            : [
                { optionId: "yes", name: "Yes", kind: "allow_once" },
                { optionId: "deny-actual", name: "No", kind: "reject_once" },
              ],
        });
        log(`permission-response:${JSON.stringify(outcome)}`);
        while (!cancelled) await new Promise((resolve) => setTimeout(resolve, 10));
        return { stopReason: "cancelled" };
      }
      if (mode === "extensions") {
        const question = await ctx.client.request("cursor/ask_question", {
          toolCallId: "question-1",
          title: "Choose",
          questions: [{ id: "q1", prompt: "Pick one", options: [{ id: "a", label: "A" }] }],
        });
        log(`question-response:${JSON.stringify(question)}`);
        const plan = await ctx.client.request("cursor/create_plan", {
          toolCallId: "plan-1",
          name: "Plan",
          overview: "Do the work",
          plan: "1. Work",
          todos: [{ id: "one", content: "Work", status: "pending" }],
        });
        log(`plan-response:${JSON.stringify(plan)}`);
        await ctx.client.notify("cursor/update_todos", {
          toolCallId: "todos-1",
          todos: [{ id: "one", content: "Work", status: "pending" }],
          merge: false,
        });
        await ctx.client.notify("cursor/update_todos", {
          toolCallId: "todos-2",
          todos: [{ id: "one", content: "Work", status: "completed" }],
          merge: true,
        });
        await ctx.client.notify("cursor/task", {
          toolCallId: "task-1",
          description: "Explore",
          prompt: "Find code",
          subagentType: "explore",
          agentId: "agent-1",
          durationMs: 25,
        });
        await ctx.client.notify("cursor/generate_image", {
          toolCallId: "image-1",
          description: "Icon",
          filePath: "/tmp/icon.png",
          referenceImagePaths: ["/tmp/ref.png"],
        });
      }
      if (mode === "summary-large") {
        for (let i = 0; i < 200; i += 1) {
          await ctx.client.notify("cursor/task", {
            toolCallId: `task-${i}`,
            description: "x".repeat(500),
            prompt: "large",
            subagentType: "explore",
          });
        }
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

function cursorModes() {
  const requestedModeIndex = process.argv.indexOf("--mode");
  const requestedMode = requestedModeIndex >= 0 ? process.argv[requestedModeIndex + 1] : "agent";
  const currentModeId = process.env.FAKE_CURSOR_CURRENT_MODE ?? requestedMode;
  const available = process.env.FAKE_CURSOR_NO_ASK === "1" ? ["agent"] : ["agent", "ask"];
  return {
    currentModeId,
    availableModes: available.map((id) => ({ id, name: id })),
  };
}
