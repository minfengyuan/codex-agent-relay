import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

const mode = process.env.FAKE_ACP_MODE ?? "normal";
const sessionId = process.env.FAKE_SESSION_ID ?? "fake-session-1";
const cwdArgIndex = process.argv.indexOf("--cwd");
const log = (line) => {
  if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${line}\n`);
};

if (mode === "malformed") {
  process.stdout.write("{definitely-not-json}\n");
} else if (mode === "exit") {
  process.exit(19);
} else {
  let cancelled = false;
  let configOptions = defaultConfigOptions(mode === "grouped");
  acp.agent({ name: "fake-opencode" })
    .onRequest(acp.methods.agent.initialize, (ctx) => {
      log(`initialize:${JSON.stringify(ctx.params.clientCapabilities)}`);
      log(`argv:${JSON.stringify(process.argv.slice(1))}`);
      log(`process-cwd:${process.cwd()}`);
      log(`delegated:${process.env.GROK_RELAY_DELEGATED ?? ""}`);
      log(`permission-env:${process.env.OPENCODE_PERMISSION ?? ""}`);
      const loadSession = mode !== "no-load" && mode !== "no-load-no-resume";
      const resume = mode !== "no-resume" && mode !== "no-load-no-resume";
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession,
          ...(resume ? { sessionCapabilities: { resume: {} } } : { sessionCapabilities: {} }),
        },
        authMethods: mode === "no-auth" ? [] : mode === "unknown-auth" ? [
          { id: "other-login", name: "Other login" },
        ] : [
          { id: "opencode-login", name: "Login with opencode" },
        ],
      };
    })
    .onRequest(acp.methods.agent.authenticate, (ctx) => {
      log(`auth:${ctx.params.methodId}`);
      return {};
    })
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      log(`new:${ctx.params.cwd}:${process.cwd()}:${ctx.params.mcpServers.length}`);
      log(`cwd-arg:${cwdArgIndex >= 0 ? process.argv[cwdArgIndex + 1] : ""}`);
      return { sessionId, configOptions };
    })
    .onRequest(acp.methods.agent.session.resume, async (ctx) => {
      log(`resume:${ctx.params.sessionId}:${ctx.params.cwd}:${ctx.params.mcpServers.length}`);
      if (mode === "resume-fail") throw new Error("resume rejected");
      return { configOptions };
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      log(`load:${ctx.params.sessionId}:${ctx.params.cwd}:${ctx.params.mcpServers.length}`);
      if (mode === "load-fail") throw new Error("load rejected");
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD HISTORY" } },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "replay-tool", title: "Replay tool", status: "completed", content: [] },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "usage_update", used: 9, size: 99, cost: { amount: 9, currency: "USD" } },
      });
      return { configOptions };
    })
    .onRequest(acp.methods.agent.session.setConfigOption, async (ctx) => {
      log(`set-config:${ctx.params.configId}:${ctx.params.value}`);
      if (mode === "config-timeout" || (mode === "config-hang-effort" && ctx.params.configId === "effort")) {
        while (!cancelled) await new Promise((resolve) => setTimeout(resolve, 10));
        return { configOptions };
      }
      const option = configOptions.find((entry) => entry.id === ctx.params.configId);
      if (!option) throw new Error(`unknown config ${ctx.params.configId}`);
      option.currentValue = ctx.params.value;
      if (ctx.params.configId === "model" && ctx.params.value === "opencode/fast") {
        const effort = configOptions.find((entry) => entry.id === "effort");
        if (effort) {
          effort.currentValue = "low";
          effort.options = [{ value: "low", name: "Low" }];
        }
      }
      return { configOptions };
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      log(`prompt:${ctx.params.sessionId}`);
      log(`prompt-text:${ctx.params.prompt[0]?.text ?? ""}`);
      if (mode === "descendant") {
        const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
          stdio: "ignore",
        });
        log(`descendant:${descendant.pid}`);
        descendant.unref();
      }
      if (mode === "permission" || mode === "permission-missing") {
        const outcome = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: {
            toolCallId: "t1",
            title: "Edit",
            status: "pending",
            content: [],
            rawInput: { path: "allowed.txt" },
          },
          options: mode === "permission-missing"
            ? [
                { optionId: "always-actual", name: "Always", kind: "allow_always" },
                { optionId: "reject-actual", name: "Reject", kind: "reject_once" },
              ]
            : [
                { optionId: "always-actual", name: "Always", kind: "allow_always" },
                { optionId: "allow-once-actual", name: "Once", kind: "allow_once" },
                { optionId: "reject-actual", name: "Reject", kind: "reject_once" },
              ],
        });
        log(`permission-response:${JSON.stringify(outcome)}`);
        if (mode === "permission-missing") {
          while (!cancelled) await new Promise((resolve) => setTimeout(resolve, 10));
          return { stopReason: "cancelled" };
        }
      }
      if (mode === "permission-other-session") {
        const outcome = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: "other-session",
          toolCall: { toolCallId: "t-other", title: "Other", status: "pending", content: [] },
          options: [{ optionId: "allow-once-actual", name: "Once", kind: "allow_once" }],
        });
        log(`permission-other-response:${JSON.stringify(outcome)}`);
      }
      if (mode === "hang" || mode === "permission-after-cancel") {
        while (!cancelled) await new Promise((resolve) => setTimeout(resolve, 10));
        return { stopReason: "cancelled" };
      }
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: "other-session",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OTHER SESSION" } },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: "other-session",
        update: { sessionUpdate: "tool_call", toolCallId: "other-tool", title: "Other tool", status: "completed", content: [] },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: "other-session",
        update: { sessionUpdate: "usage_update", used: 1, size: 2, cost: { amount: 1, currency: "USD" } },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Fake tool", status: "in_progress", content: [] },
      });
      if (mode === "summary-large") {
        for (let i = 0; i < 200; i += 1) {
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `task-${i}`,
              title: "x".repeat(500),
              status: "completed",
              content: [],
            },
          });
        }
      }
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: 11,
          size: 100,
          cost: { amount: 1.25, currency: "USD" },
        },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: 42,
          size: 128,
          cost: { amount: 3.5, currency: "USD" },
        },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: mode === "large" ? "x".repeat(10000) : mode === "partial-fail" ? "partial text" : "fresh answer" },
        },
      });
      if (mode === "partial-fail") throw new Error("prompt failed after output");
      return { stopReason: "end_turn" };
    })
    .onNotification(acp.methods.agent.session.cancel, async (ctx) => {
      log(`cancel:${ctx.params.sessionId}`);
      cancelled = true;
      if (mode === "permission-after-cancel") {
        const outcome = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: { toolCallId: "late", title: "Late", status: "pending", content: [] },
          options: [
            { optionId: "always-actual", name: "Always", kind: "allow_always" },
            { optionId: "allow-once-actual", name: "Once", kind: "allow_once" },
            { optionId: "reject-actual", name: "Reject", kind: "reject_once" },
          ],
        });
        log(`permission-response:${JSON.stringify(outcome)}`);
      }
    })
    .connect(acp.ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin),
    ));
}

function defaultConfigOptions(grouped) {
  const models = [
    { value: "opencode/gpt", name: "GPT" },
    { value: "opencode/fast", name: "Fast" },
  ];
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "opencode/gpt",
      options: grouped ? [{ group: "opencode", name: "OpenCode", options: models }] : models,
    },
    ...(mode === "no-effort" ? [] : [{
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    }]),
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: "build",
      options: [
        { value: "build", name: "Build" },
        { value: "plan", name: "Plan" },
      ],
    },
  ];
}
