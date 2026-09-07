import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createRelayServer } from "../src/server.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function harness() {
  const stateDir = await mkdtemp(join(tmpdir(), "relay-server-"));
  dirs.push(stateDir);
  const server = createRelayServer({ ...loadConfig({}), stateDir });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const responses = new Map<number, (message: JSONRPCMessage) => void>();
  clientTransport.onmessage = (message) => {
    if ("id" in message && typeof message.id === "number") responses.get(message.id)?.(message);
  };
  await clientTransport.start();
  await server.connect(serverTransport);
  const request = async (id: number, method: string, params: Record<string, unknown> = {}) => {
    const answer = new Promise<JSONRPCMessage>((resolve) => responses.set(id, resolve));
    await clientTransport.send({ jsonrpc: "2.0", id, method, params });
    return answer;
  };
  await request(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { server, clientTransport, request };
}

describe("MCP server", () => {
  it("discovers exactly grok_delegate with the required input contract", async () => {
    const { server, clientTransport, request } = await harness();
    const response = await request(2, "tools/list");
    expect(response).toHaveProperty("result.tools.0.name", "grok_delegate");
    expect(response).toHaveProperty("result.tools.0.inputSchema.required", ["task", "cwd"]);
    expect(response).toHaveProperty("result.tools.0.outputSchema.properties.sessionId");
    await clientTransport.close();
    await server.close();
  });

  it("returns matching JSON and structured error output", async () => {
    const { server, clientTransport, request } = await harness();
    const response = await request(3, "tools/call", {
      name: "grok_delegate",
      arguments: { task: "hello", cwd: "relative" },
    }) as { result?: { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: unknown } };
    expect(response.result?.isError).toBe(true);
    expect(JSON.parse(response.result?.content?.[0]?.text ?? "null")).toEqual(response.result?.structuredContent);
    expect(response.result?.structuredContent).toMatchObject({
      sessionId: null,
      stopReason: null,
      text: "",
      truncated: false,
      error: { code: "INVALID_CWD" },
    });
    await clientTransport.close();
    await server.close();
  });
});
