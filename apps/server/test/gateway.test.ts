import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type {
  ClientMessage,
  ServerInfo,
  ServerMessage,
} from "@ribhu-voyager/protocol";
import { WebSocket } from "ws";

import type { Config } from "../src/config.js";
import { attachGateway, type Gateway } from "../src/gateway.js";
import { createRuntime, type Runtime } from "../src/harness.js";

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
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class TestClient {
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

async function startGateway(runtime: Runtime): Promise<{
  port: number;
  gateway: Gateway;
  server: Server;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const info: ServerInfo = {
    serverId: runtime.serverId,
    demo: runtime.demo,
    model: runtime.model.modelId,
    provider: runtime.model.provider,
    startedAt: runtime.startedAt,
  };
  const gateway = attachGateway(server, runtime, info, "");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, gateway, server };
}

function welcomeView(message: ServerMessage) {
  assert.equal(message.t, "welcome");
  if (message.t !== "welcome") throw new Error("unreachable");
  return message;
}

test("broadcasts durable commits and survives client retries", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-voyager-gateway-"));
  const runtime = await createRuntime(configFor(dir));
  const { port, gateway, server } = await startGateway(runtime);
  const a = new TestClient(port);
  const b = new TestClient(port);

  try {
    await Promise.all([a.open(), b.open()]);
    a.send({ t: "hello", v: 2, clientId: "a" });
    b.send({ t: "hello", v: 2, clientId: "b" });

    const aWelcome = welcomeView(await a.next((message) => message.t === "welcome"));
    const bWelcome = welcomeView(await b.next((message) => message.t === "welcome"));
    assert.equal(typeof aWelcome.conversationId, "number");
    assert.equal(aWelcome.conversationId, bWelcome.conversationId);

    const requestId = "gateway-req-1";
    a.send({
      t: "submit",
      requestId,
      content: "What is durable?",
      whenBusy: "steer",
    });

    const ack = await a.next((message) => message.t === "ack" && message.requestId === requestId);
    assert.ok(ack.t === "ack");

    // Both attached clients see the commit stream, not just the submitter.
    const aView = await a.next((message) => message.t === "view");
    const bView = await b.next((message) => message.t === "view");
    assert.ok(aView.t === "view" && aView.view.entries.length > 0);
    assert.ok(bView.t === "view" && bView.view.entries.length > 0);

    await runtime.root.waitForIdle();

    // A retry with the same requestId returns the original submission.
    b.send({ t: "submit", requestId, content: "What is durable?", whenBusy: "steer" });
    const retryAck = await b.next(
      (message) => message.t === "ack" && message.requestId === requestId,
    );
    assert.ok(retryAck.t === "ack");
    assert.equal(retryAck.submissionId, ack.submissionId);

    // A late-joining client gets the whole view in its welcome snapshot.
    const late = new TestClient(port);
    try {
      await late.open();
      late.send({ t: "hello", v: 2, clientId: "late" });
      const lateWelcome = welcomeView(await late.next((message) => message.t === "welcome"));
      const users = lateWelcome.view.entries.filter((entry) => entry.kind === "pi.user");
      const assistants = lateWelcome.view.entries.filter(
        (entry) => entry.kind === "pi.assistant",
      );
      assert.equal(users.length, 1, "exactly-once after the retry");
      assert.ok(assistants.length >= 1, "the answer is in the snapshot");
    } finally {
      late.close();
    }

    a.send({ t: "resync", conversationId: aWelcome.conversationId });
    const snapshot = await a.next((message) => message.t === "snapshot");
    assert.ok(snapshot.t === "snapshot");
    assert.ok(snapshot.view.entries.length > 0);

    a.send({ t: "ping", ts: 42 });
    const pong = await a.next((message) => message.t === "pong");
    assert.ok(pong.t === "pong");
    assert.equal(pong.ts, 42);
  } finally {
    a.close();
    b.close();
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
