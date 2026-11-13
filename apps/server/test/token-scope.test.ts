import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { ServerInfo } from "@ribhu-voyager/protocol";
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
    provider: "demo",
    model: "ribhu-demo",
    demo: true,
    demoTokensPerSecond: 4000,
    maxWindowEntries: 100,
    token: "shared",
    authMode: "auto",
    authSource: "auto",
  };
}

test("tenant API tokens are scoped at the WebSocket boundary", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-token-"));
  const api = await createApiRuntime(configFor(dir));
  const info: ServerInfo = {
    serverId: api.serverId,
    demo: api.demo,
    model: api.model.modelId,
    provider: api.model.provider,
    startedAt: api.startedAt,
  };
  const server = createServer((_request, response) => response.writeHead(404).end());
  const gateway = attachGateway(server, api, info, "shared", undefined, {
    authorizeToken: async (token) => token === "tenant-token",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const connect = (token: string) =>
    new Promise<{ open: boolean; message?: string }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
      let settled = false;
      const done = (open: boolean, message?: string) => {
        if (settled) return;
        settled = true;
        resolve({ open, message });
        ws.close();
      };
      ws.on("open", () => done(true));
      ws.on("message", (raw) => done(true, raw.toString()));
      ws.on("error", (error) => done(false, error.message));
      ws.on("close", () => done(false, "closed"));
      setTimeout(() => done(false, "timeout"), 5_000);
    });
  try {
    assert.equal((await connect("tenant-token")).open, true);
    assert.equal((await connect("other-tenant")).open, false);
    assert.equal((await connect("shared")).open, false);
    assert.equal((await connect("")).open, false);
  } finally {
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
