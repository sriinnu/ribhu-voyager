import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from "@ribhu-voyager/protocol";
import { WebSocket } from "ws";

import {
  createApiRuntime,
  type ApiRuntime,
  type GatewayRuntime,
} from "../src/api-runtime.js";
import type { Config } from "../src/config.js";
import { attachGateway, type Gateway } from "../src/gateway.js";
import { createRuntimePool, runtimeInfo } from "../src/runtime-pool.js";

function configFor(dataDir: string, token = ""): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    workspaceDir: join(dataDir, "workspace"),
    provider: "demo",
    model: "ribhu-demo",
    demo: true,
    demoTokensPerSecond: 4000,
    maxWindowEntries: 100,
    token,
    authMode: "auto",
    authSource: "auto",
  };
}

type Waiter = {
  match: (message: ServerMessage) => boolean;
  resolve: (message: ServerMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class TestClient {
  readonly ws: WebSocket;
  private queue: ServerMessage[] = [];
  private waiters: Waiter[] = [];

  constructor(port: number, token?: string) {
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
    this.ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      const index = this.waiters.findIndex((waiter) => waiter.match(message));
      if (index === -1) {
        this.queue.push(message);
        return;
      }
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter!.timer);
      waiter!.resolve(message);
    });
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  next(
    match: (message: ServerMessage) => boolean,
    timeoutMs = 15_000,
  ): Promise<ServerMessage> {
    const index = this.queue.findIndex(match);
    if (index !== -1) {
      const [message] = this.queue.splice(index, 1);
      return Promise.resolve(message!);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((entry) => entry !== waiter);
          reject(new Error("timed out waiting for a gateway message"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function startGateway(
  resolveRuntime: (token: string | undefined) => Promise<GatewayRuntime | undefined>,
): Promise<{ port: number; gateway: Gateway; server: Server }> {
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const gateway = attachGateway(
    server,
    undefined,
    undefined,
    "",
    undefined,
    {
      resolveRuntime,
      infoFor: (runtime) => runtimeInfo(runtime as ApiRuntime),
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, gateway, server };
}

function welcomeOf(message: ServerMessage) {
  assert.equal(message.t, "welcome");
  if (message.t !== "welcome") throw new Error("unreachable");
  return message;
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for state");
}

async function entriesOf(api: ApiRuntime, conversationId: number) {
  return (await api.storage.entries(conversationId)).entries;
}

test("tenant tokens route to isolated runtimes", { timeout: 30_000 }, async () => {
  const dirA = await mkdtemp(join(tmpdir(), "ribhu-tenant-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "ribhu-tenant-b-"));
  const apiA = await createApiRuntime(configFor(dirA));
  const apiB = await createApiRuntime(configFor(dirB));
  const { port, gateway, server } = await startGateway(async (token) => {
    if (token === "token-a") return apiA;
    if (token === "token-b") return apiB;
    return undefined;
  });
  const clientA = new TestClient(port, "token-a");
  const clientB = new TestClient(port, "token-b");
  try {
    const rootA = await apiA.conversation();
    const rootB = await apiB.conversation();
    assert.ok(rootA && rootB);
    const createConversation = apiB.createConversation;
    assert.ok(createConversation, "api runtime supports creating conversations");
    const bOnlyId = await createConversation("B only");
    assert.notEqual(bOnlyId, rootA.id);

    await Promise.all([clientA.open(), clientB.open()]);
    clientA.send({ t: "hello", v: PROTOCOL_VERSION, clientId: "tenant-a" });
    clientB.send({ t: "hello", v: PROTOCOL_VERSION, clientId: "tenant-b" });
    const welcomeA = welcomeOf(await clientA.next((message) => message.t === "welcome"));
    const welcomeB = welcomeOf(await clientB.next((message) => message.t === "welcome"));

    // Each token got its own runtime and its own root conversation.
    assert.equal(welcomeA.info.serverId, apiA.serverId);
    assert.equal(welcomeB.info.serverId, apiB.serverId);
    assert.notEqual(welcomeA.info.serverId, welcomeB.info.serverId);
    assert.equal(welcomeA.conversationId, rootA.id);
    assert.equal(welcomeB.conversationId, rootB.id);

    // A submission through token A lands in runtime A's journal only.
    clientA.send({
      t: "submit",
      requestId: "tenant-a-1",
      content: "message from tenant A",
    });
    const ack = await clientA.next(
      (message) => message.t === "ack" && message.requestId === "tenant-a-1",
    );
    assert.ok(ack.t === "ack");
    const userView = await clientA.next(
      (message) =>
        message.t === "view" &&
        message.view.entries.some((entry) => entry.kind === "pi.user"),
    );
    assert.ok(userView.t === "view");

    const [aEntries, bEntries] = await Promise.all([
      entriesOf(apiA, rootA.id),
      entriesOf(apiB, rootB.id),
    ]);
    assert.ok(
      aEntries.some((entry) => entry.kind === "pi.user"),
      "tenant A has the submission",
    );
    assert.ok(
      !bEntries.some((entry) => entry.kind === "pi.user"),
      "tenant B never sees tenant A's submission",
    );

    // Token A cannot resync, attach, or fork token B's conversation.
    clientA.send({ t: "resync", conversationId: bOnlyId });
    const resync = await clientA.next((message) => message.t === "error");
    assert.ok(resync.t === "error");
    assert.equal(resync.code, "unknown_conversation");

    const intruder = new TestClient(port, "token-a");
    try {
      await intruder.open();
      intruder.send({
        t: "hello",
        v: PROTOCOL_VERSION,
        clientId: "intruder",
        conversationId: bOnlyId,
      });
      const attach = await intruder.next((message) => message.t === "error");
      assert.ok(attach.t === "error");
      assert.equal(attach.code, "unknown_conversation");
    } finally {
      intruder.close();
    }

    clientA.send({ t: "fork", conversationId: bOnlyId });
    const fork = await clientA.next((message) => message.t === "error");
    assert.ok(fork.t === "error");
    assert.equal(fork.code, "unknown_conversation");

    // The owning token can still reach its own conversation.
    clientB.send({ t: "resync", conversationId: bOnlyId });
    const snapshot = await clientB.next(
      (message) =>
        message.t === "snapshot" && message.conversationId === bOnlyId,
    );
    assert.ok(snapshot.t === "snapshot");

    // Unknown tokens are rejected at the upgrade boundary.
    const bad = new TestClient(port, "bogus");
    try {
      await assert.rejects(bad.open(), /401|Unexpected server response/);
    } finally {
      bad.close();
    }
  } finally {
    clientA.close();
    clientB.close();
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await apiA.close();
    await apiB.close();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("runtime pool creates one runtime per tenant and enforces tokens", { timeout: 20_000 }, async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "ribhu-pool-"));
  const dirs = new Map<string, string>([
    ["tenant-a", await mkdtemp(join(tmpdir(), "ribhu-pool-a-"))],
    ["tenant-b", await mkdtemp(join(tmpdir(), "ribhu-pool-b-"))],
  ]);
  const pool = createRuntimePool(
    configFor(baseDir),
    async (token) => {
      if (token === "token-a") return "tenant-a";
      if (token === "token-b") return "tenant-b";
      return undefined;
    },
    async (tenantConfig: Config, tenantId: string) => {
      const dir = dirs.get(tenantId)!;
      return createApiRuntime(
        { ...tenantConfig, dataDir: dir, workspaceDir: join(dir, "workspace") },
        tenantId,
      );
    },
  );
  try {
    const a = await pool.resolve("token-a");
    assert.ok(a);
    assert.equal(a.tenantId, "tenant-a");
    assert.equal(a.info.serverId, a.runtime.serverId);
    assert.equal(a.info.provider, "demo");

    // Cached: the same token never creates a second runtime.
    assert.equal(await pool.resolve("token-a"), a);
    assert.equal(pool.infoFor(a.runtime), a.info);

    const b = await pool.resolve("token-b");
    assert.ok(b);
    assert.equal(b.tenantId, "tenant-b");
    assert.notEqual(b.runtime.serverId, a.runtime.serverId);

    assert.equal(await pool.resolve("bogus"), undefined);
    assert.equal(await pool.resolve(undefined), undefined);
  } finally {
    await pool.close();
    await Promise.all(
      [...dirs.values()].map((dir) => rm(dir, { recursive: true, force: true })),
    );
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("shared token guards the default single runtime", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-pool-shared-"));
  const pool = createRuntimePool(configFor(dir, "shared"));
  try {
    const resolved = await pool.resolve("shared");
    assert.ok(resolved);
    assert.equal(resolved.tenantId, "default");
    assert.equal(resolved.runtime.serverId, (await pool.resolve("shared"))!.runtime.serverId);
    assert.equal(await pool.resolve("wrong"), undefined);
    assert.equal(await pool.resolve(undefined), undefined);
  } finally {
    await pool.close();
    await rm(dir, { recursive: true, force: true });
  }
});
