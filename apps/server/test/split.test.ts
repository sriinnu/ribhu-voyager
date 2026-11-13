import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { ServerInfo, ServerMessage } from "@ribhu-voyager/protocol";
import { WebSocket } from "ws";

import { createApiRuntime, type ApiRuntime } from "../src/api-runtime.js";
import type { Config } from "../src/config.js";
import { attachGateway, type Gateway } from "../src/gateway.js";
import { startWorker, type WorkerHandle } from "../src/worker.js";

function configFor(dataDir: string): Config {
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
    token: "",
    authMode: "auto",
    authSource: "auto",
  };
}

type Waiter = {
  match: (message: ServerMessage) => boolean;
  resolve: (message: ServerMessage) => void;
  timer: ReturnType<typeof setTimeout>;
};

class Client {
  readonly ws: WebSocket;
  private queue: ServerMessage[] = [];
  private waiters: Waiter[] = [];

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  send(message: object): void {
    this.ws.send(JSON.stringify(message));
  }

  next(
    match: (message: ServerMessage) => boolean,
    timeoutMs = 20_000,
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

async function boot(api: ApiRuntime): Promise<{
  server: Server;
  gateway: Gateway;
  port: number;
}> {
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
  return {
    server,
    gateway,
    port: (server.address() as AddressInfo).port,
  };
}

async function stop(
  server: Server,
  gateway: Gateway,
  api: ApiRuntime,
): Promise<void> {
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await api.close();
}

test("API admits and the worker answers through the queue", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-split-"));
  let worker: WorkerHandle | undefined;
  let api = await createApiRuntime(configFor(dir));
  let host = await boot(api);
  const client = new Client(host.port);
  try {
    worker = await startWorker(configFor(dir));

    await client.open();
    client.send({ t: "hello", v: 2, clientId: "split" });
    const welcome = await client.next((message) => message.t === "welcome");
    assert.ok(welcome.t === "welcome");

    client.send({
      t: "submit",
      requestId: "split-1",
      content: "What is durable?",
      whenBusy: "steer",
    });
    const ack = await client.next((message) => message.t === "ack");
    assert.ok(ack.t === "ack");

    const view = await client.next(
      (message) =>
        message.t === "view" &&
        message.view.entries.some((entry) => entry.kind === "pi.assistant"),
    );
    assert.ok(view.t === "view");
    assert.equal(
      view.view.entries.filter((entry) => entry.kind === "pi.user").length,
      1,
    );

    // The worker can be replaced; an input admitted while it is down is picked
    // up from the queue by the next worker.
    await worker.close();
    worker = undefined;
    client.send({
      t: "submit",
      requestId: "split-2",
      content: "What is durable?",
      whenBusy: "steer",
    });
    const secondAck = await client.next(
      (message) => message.t === "ack" && message.requestId === "split-2",
    );
    assert.ok(secondAck.t === "ack");
    await new Promise((resolve) => setTimeout(resolve, 300));
    worker = await startWorker(configFor(dir));
    const secondView = await client.next(
      (message) =>
        message.t === "view" &&
        message.view.entries.filter((entry) => entry.kind === "pi.assistant")
          .length >= 2,
    );
    assert.ok(secondView.t === "view");

    // The API can be replaced without touching the worker or its journal.
    client.close();
    await stop(host.server, host.gateway, api);

    api = await createApiRuntime(configFor(dir));
    host = await boot(api);
    const restarted = new Client(host.port);
    await restarted.open();
    restarted.send({ t: "hello", v: 2, clientId: "restarted" });
    const again = await restarted.next((message) => message.t === "welcome");
    assert.ok(again.t === "welcome");
    assert.ok(
      again.view.entries.some((entry) => entry.kind === "pi.assistant"),
      "the restarted API serves the worker's committed answer",
    );

    const rootId = again.conversationId;
    restarted.send({ t: "create", title: "Second chat" });
    const created = await restarted.next(
      (message) =>
        message.t === "welcome" && message.conversationId !== rootId,
    );
    assert.ok(created.t === "welcome");
    const createdList = await restarted.next(
      (message) =>
        message.t === "conversations" &&
        message.items.some((item) => item.title === "Second chat"),
    );
    assert.ok(createdList.t === "conversations");

    restarted.send({ t: "fork", conversationId: rootId });
    const forked = await restarted.next(
      (message) =>
        message.t === "welcome" &&
        message.conversationId !== rootId &&
        message.conversationId !== created.conversationId,
    );
    assert.ok(forked.t === "welcome");
    const forkList = await restarted.next(
      (message) =>
        message.t === "conversations" &&
        message.items.some(
          (item) => item.parentId === rootId && item.id === forked.conversationId,
        ),
    );
    assert.ok(forkList.t === "conversations");

    restarted.close();
  } finally {
    client.close();
    await stop(host.server, host.gateway, api);
    await worker?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
