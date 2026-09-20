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
  // Model the long-lived DSH ACP profile: closing a session or the transport
  // does not make the provider process disappear before relay tree cleanup.
  setInterval(() => {}, 1_000);
  let cancelled = false;
  let configOptions = defaultConfigOptions(mode === "grouped");
  acp.agent({ name: "fake-dsh" })
    .onRequest(acp.methods.agent.initialize, (ctx) => {
      log(`initialize:${JSON.stringify(ctx.params.clientCapabilities)}`);
      log(`argv:${JSON.stringify(process.argv.slice(1))}`);
      log(`process-cwd:${process.cwd()}`);
      log(`delegated:${process.env.CODEX_AGENT_RELAY_DELEGATED ?? ""}`);
      const resume = mode !== "no-resume";
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: {
            ...(resume ? { resume: {} } : {}),
            ...(mode === "no-close" ? {} : { close: {} }),
          },
        },
        authMethods: mode === "unknown-auth" ? [
          { id: "other-login", name: "Other login" },
        ] : [],
      };
    })
    .onRequest(acp.methods.agent.authenticate, (ctx) => {
      log(`auth:${ctx.params.methodId}`);
      return {};
    })
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      log(`new:${ctx.params.cwd}:${process.cwd()}:${ctx.params.mcpServers.length}`);
      return { sessionId, configOptions };
    })
    .onRequest(acp.methods.agent.session.resume, async (ctx) => {
      log(`resume:${ctx.params.sessionId}:${ctx.params.cwd}:${ctx.params.mcpServers.length}`);
      if (mode === "resume-fail") throw new Error("resume rejected");
      return { configOptions };
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      log(`load:${ctx.params.sessionId}:${ctx.params.cwd}:${ctx.params.mcpServers.length}`);
      throw new Error("DSH load is not supported");
    })
    .onRequest(acp.methods.agent.session.setConfigOption, async (ctx) => {
      log(`set-config:${ctx.params.configId}:${ctx.params.value}`);
      if (mode === "config-fail") throw new Error("config rejected");
      if (mode === "config-timeout" || (mode === "config-hang-effort" && ctx.params.configId === "reasoning_effort")) {
        while (!cancelled) await new Promise((resolve) => setTimeout(resolve, 10));
        return { configOptions };
      }
      const option = configOptions.find((entry) => entry.id === ctx.params.configId);
      if (!option) throw new Error(`unknown config ${ctx.params.configId}`);
      option.currentValue = ctx.params.value;
      if (ctx.params.configId === "model" && ctx.params.value === "dsh/fast") {
        const effort = configOptions.find((entry) => entry.id === "reasoning_effort");
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
      const permissionModes = new Set([
        "permission",
        "permission-missing",
        "permission-continue",
        "permission-repeat",
      ]);
      if (permissionModes.has(mode)) {
        const options = mode === "permission-missing"
          ? [
              { optionId: "always-actual", name: "Always", kind: "allow_always" },
              { optionId: "allow-once-actual", name: "Once", kind: "allow_once" },
            ]
          : [
              { optionId: "always-actual", name: "Always", kind: "allow_always" },
              { optionId: "allow-once-actual", name: "Once", kind: "allow_once" },
              { optionId: "reject-actual", name: "Reject", kind: "reject_once" },
            ];
        const outcome = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: {
            toolCallId: "t1",
            title: "Edit",
            status: "pending",
            content: [],
            rawInput: { path: "allowed.txt" },
          },
          options,
        });
        log(`permission-response:${JSON.stringify(outcome)}`);
        if (mode === "permission-repeat") {
          const second = await ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId: ctx.params.sessionId,
            toolCall: { toolCallId: "t2", title: "Again", status: "pending", content: [] },
            options,
          });
          log(`permission-repeat-response:${JSON.stringify(second)}`);
        }
        if (mode === "permission" || mode === "permission-missing") {
          while (!cancelled) await new Promise((resolve) => setTimeout(resolve, 10));
          return { stopReason: "cancelled" };
        }
      }
      if (mode === "permission-other-session") {
        const outcome = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: "other-session",
          toolCall: { toolCallId: "t-other", title: "Other", status: "pending", content: [] },
          options: [{ optionId: "reject-actual", name: "Reject", kind: "reject_once" }],
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
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
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
    .onRequest(acp.methods.agent.session.close, async (ctx) => {
      log(`close-start:${ctx.params.sessionId}`);
      if (mode === "close-timeout") {
        await new Promise(() => {});
      }
      if (mode === "close-fail") throw new Error("close rejected");
      if (mode === "close-delay") await new Promise((resolve) => setTimeout(resolve, 150));
      log(`close-complete:${ctx.params.sessionId}`);
      return {};
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
    { value: "dsh/gpt", name: "GPT" },
    { value: "dsh/fast", name: "Fast" },
  ];
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "dsh/gpt",
      options: grouped ? [{ group: "dsh", name: "DSH", options: models }] : models,
    },
    ...(mode === "no-effort" ? [] : [{
      id: "reasoning_effort",
      name: "Reasoning Effort",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    }]),
  ];
}
