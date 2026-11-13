import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { ServerInfo, ServerMessage } from "@ribhu-voyager/protocol";
import { WebSocket } from "ws";

import { createApiRuntime } from "../src/api-runtime.js";
import type { Config } from "../src/config.js";
import { attachGateway } from "../src/gateway.js";

function configFor(dir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    workspaceDir: join(dir, "workspace"),
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    demo: false,
    demoTokensPerSecond: 4000,
    maxWindowEntries: 100,
    token: "",
    authMode: "auto",
    authSource: "auto",
    anthropicApiKey: "sk-dummy",
  };
}

test("worker-applied auth revisions are broadcast", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-auth-live-"));
  const api = await createApiRuntime(configFor(dir));
  const info: ServerInfo = {
    serverId: api.serverId,
    demo: api.demo,
    model: api.model.modelId,
    provider: api.model.provider,
    startedAt: api.startedAt,
  };
  const server = createServer((_request, response) =>
    response.writeHead(404).end(),
  );
  const gateway = attachGateway(server, api, info, "");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages: ServerMessage[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));

  const waitFor = async (
    match: (message: ServerMessage) => boolean,
  ): Promise<ServerMessage> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = messages.find(match);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("timed out waiting for a message");
  };

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ t: "hello", v: 2, clientId: "auth" }));
    await waitFor((message) => message.t === "welcome");

    await api.storage.setSetting(
      "auth_info",
      JSON.stringify({
        mode: "api-key",
        label: "API key (credits)",
        subscriptionAvailable: true,
        apiKeyAvailable: true,
      }),
    );
    await api.storage.setSetting("auth_revision", String(Date.now()));
    const auth = await waitFor((message) => message.t === "auth");
    assert.ok(auth.t === "auth");
    assert.equal(auth.auth.mode, "api-key");
  } finally {
    ws.close();
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
