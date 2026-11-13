import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PROTOCOL_VERSION,
  isClientMessage,
  type ClientMessage,
  type ServerInfo,
  type ServerMessage,
  type WireEntry,
  type WireView,
} from "@ribhu-voyager/protocol";
import { WebSocket } from "ws";

import { createApiRuntime, type GatewayRuntime } from "../src/api-runtime.js";
import type { Config } from "../src/config.js";
import { attachGateway, type Gateway } from "../src/gateway.js";

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

async function startGateway(runtime: GatewayRuntime): Promise<{
  port: number;
  gateway: Gateway;
  server: Server;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const info: ServerInfo = {
    serverId: "approval-api-test",
    demo: true,
    model: "ribhu-demo",
    provider: "demo",
    startedAt: Date.now(),
  };
  const gateway = attachGateway(server, runtime, info, "");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, gateway, server };
}

function entryStatus(entry: WireEntry): unknown {
  const data = entry.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  return (data as { status?: unknown }).status;
}

function hasApprovalStatus(view: WireView, status: string): boolean {
  return view.entries.some(
    (entry) => entry.kind === "pi.approval" && entryStatus(entry) === status,
  );
}

function errors(message: ServerMessage, code: string, text?: string) {
  return (
    message.t === "error" &&
    message.code === code &&
    (text === undefined || message.message.includes(text))
  );
}

test("isClientMessage accepts the approval wire shape", () => {
  const approve: ClientMessage = {
    t: "approval",
    conversationId: 7,
    callId: "call_1",
    decision: "approve",
  };
  const deny: ClientMessage = {
    t: "approval",
    callId: "call_2",
    decision: "deny",
  };

  assert.equal(isClientMessage(approve), true);
  assert.equal(isClientMessage(deny), true);
  // The gateway receives JSON, so the exact wire round-trip must stay accepted.
  assert.equal(isClientMessage(JSON.parse(JSON.stringify(approve))), true);
  assert.equal(isClientMessage({ t: "nope" }), false);
  assert.equal(isClientMessage(null), false);

  if (approve.t === "approval") {
    // Compile-time check: the published variant exposes the fixed decision union.
    const decision: "approve" | "deny" = approve.decision;
    assert.equal(decision, "approve");
  }
});

test("api-runtime appends one decision entry for a pending approval", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-approval-api-"));
  const api = await createApiRuntime(configFor(dir));
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);
    const decide = conversation.decideApproval;
    assert.equal(typeof decide, "function", "api-runtime exposes decideApproval");

    const approvalEntries = async () =>
      (await api.storage.entries(conversation.id)).entries.filter(
        (entry) => entry.kind === "pi.approval",
      );

    await api.storage.appendEntry({
      conversationId: conversation.id,
      kind: "pi.approval",
      data: {
        callId: "call_approve",
        name: "bash",
        args: { command: "npm test" },
        status: "pending",
        requestedAt: Date.now(),
      },
    });

    assert.equal(
      await decide("call_unknown", true),
      false,
      "an unknown callId is not a pending approval",
    );

    assert.equal(
      await decide("call_approve", true),
      true,
      "the pending callId is decided",
    );

    let entries = await approvalEntries();
    assert.equal(entries.length, 2, "request + decision");
    const approved = entries[1]!.data as {
      callId?: unknown;
      status?: unknown;
      decidedAt?: unknown;
    };
    assert.equal(approved.callId, "call_approve");
    assert.equal(approved.status, "approved");
    assert.equal(typeof approved.decidedAt, "number");

    assert.equal(
      await decide("call_approve", false),
      false,
      "a decision is append-only and cannot be replaced",
    );
    assert.equal((await approvalEntries()).length, 2);

    await api.storage.appendEntry({
      conversationId: conversation.id,
      kind: "pi.approval",
      data: {
        callId: "call_deny",
        name: "write",
        args: { path: "app.ts" },
        status: "pending",
        requestedAt: Date.now(),
      },
    });
    assert.equal(await decide("call_deny", false), true);
    entries = await approvalEntries();
    const denied = entries.at(-1)!.data as { callId?: unknown; status?: unknown };
    assert.equal(denied.callId, "call_deny");
    assert.equal(denied.status, "denied");

    // The scan window widens like the engine's: a request buried behind more
    // than the initial 200-entry window is still found.
    await api.storage.appendEntry({
      conversationId: conversation.id,
      kind: "pi.approval",
      data: {
        callId: "call_deep",
        name: "bash",
        args: { command: "npm test" },
        status: "pending",
        requestedAt: Date.now(),
      },
    });
    for (let index = 0; index < 250; index += 1) {
      await api.storage.appendEntry({
        conversationId: conversation.id,
        kind: "test.filler",
        data: { index },
      });
    }
    assert.equal(
      await decide("call_deep", true),
      true,
      "a pending request beyond the first scan window is still decided",
    );
    const deepEntries = await approvalEntries();
    const deepDecision = deepEntries.at(-1)!.data as { callId?: unknown; status?: unknown };
    assert.equal(deepDecision.callId, "call_deep");
    assert.equal(deepDecision.status, "approved");
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway decides approvals for the attached conversation", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-approval-gateway-"));
  const api = await createApiRuntime(configFor(dir));
  const { port, gateway, server } = await startGateway(api);
  const client = new TestClient(port);
  try {
    await client.open();
    client.send({ t: "hello", v: PROTOCOL_VERSION, clientId: "approval-api" });
    const welcome = await client.next((message) => message.t === "welcome");
    assert.ok(welcome.t === "welcome");
    const conversationId = welcome.conversationId;

    // The worker journals a pending request; the phone sees it in a view update.
    await api.storage.appendEntry({
      conversationId,
      kind: "pi.approval",
      data: {
        callId: "call_gateway",
        name: "bash",
        args: { command: "npm test" },
        status: "pending",
        requestedAt: Date.now(),
      },
    });
    const pendingView = await client.next(
      (message) => message.t === "view" && hasApprovalStatus(message.view, "pending"),
    );
    assert.ok(pendingView.t === "view");

    client.send({
      t: "approval",
      conversationId,
      callId: "call_gateway",
      decision: "approve",
    });
    // No new ServerMessage is needed: the decision arrives as a normal view update.
    const decidedView = await client.next(
      (message) => message.t === "view" && hasApprovalStatus(message.view, "approved"),
    );
    assert.ok(decidedView.t === "view");

    client.send({
      t: "approval",
      conversationId,
      callId: "call_gateway",
      decision: "deny",
    });
    const alreadyDecided = await client.next((message) =>
      errors(message, "not_found", "no pending approval"),
    );
    assert.ok(errors(alreadyDecided, "not_found", "no pending approval"));

    client.send({ t: "approval", callId: "", decision: "approve" });
    const emptyCall = await client.next((message) =>
      errors(message, "bad_request", "callId"),
    );
    assert.ok(errors(emptyCall, "bad_request", "callId"));

    client.send({
      t: "approval",
      conversationId: conversationId + 1,
      callId: "call_gateway",
      decision: "approve",
    });
    const wrongConversation = await client.next((message) =>
      errors(message, "bad_request", "conversationId"),
    );
    assert.ok(errors(wrongConversation, "bad_request", "conversationId"));

    client.send({
      t: "approval",
      callId: "call_gateway",
      decision: "maybe",
    } as unknown as ClientMessage);
    const badDecision = await client.next((message) =>
      errors(message, "bad_request", "decision"),
    );
    assert.ok(errors(badDecision, "bad_request", "decision"));

    // A connection that never said hello cannot decide anything.
    const detached = new TestClient(port);
    try {
      await detached.open();
      detached.send({
        t: "approval",
        callId: "call_gateway",
        decision: "approve",
      });
      const noHello = await detached.next((message) =>
        errors(message, "bad_request", "Send hello first"),
      );
      assert.ok(errors(noHello, "bad_request", "Send hello first"));
    } finally {
      detached.close();
    }
  } finally {
    client.close();
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
