import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ClientMessage, ServerMessage } from "@ribhu-voyager/protocol";
import { WebSocket } from "ws";

import { createApiRuntime, type ApiRuntime } from "../src/api-runtime.js";
import type { Config } from "../src/config.js";
import {
  attachGateway,
  createRateLimiter,
  type Gateway,
  type GatewayOptions,
} from "../src/gateway.js";
import { runtimeInfo } from "../src/runtime-pool.js";

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
    token: "secret",
    authMode: "auto",
    authSource: "auto",
  };
}

type Started = { port: number; gateway: Gateway; server: Server };

async function startServer(
  api: ApiRuntime,
  token: string,
  options: GatewayOptions = {},
): Promise<Started> {
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const gateway = attachGateway(server, api, runtimeInfo(api), token, undefined, options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, gateway, server };
}

async function stop(started: Started): Promise<void> {
  await started.gateway.close();
  await new Promise<void>((resolve) => started.server.close(() => resolve()));
}

type ConnectResult = { ok: boolean; error?: string };

function connect(
  port: number,
  options: { token?: string; origin?: string; headers?: Record<string, string> },
): Promise<ConnectResult> {
  return new Promise((resolve) => {
    const query = options.token ? `?token=${encodeURIComponent(options.token)}` : "";
    const headers = {
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.headers ?? {}),
    };
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws${query}`,
      Object.keys(headers).length > 0 ? { headers } : undefined,
    );
    let settled = false;
    const done = (result: ConnectResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
      ws.close();
    };
    ws.on("open", () => done({ ok: true }));
    ws.on("error", (error) => done({ ok: false, error: error.message }));
    ws.on("close", () => done({ ok: false, error: "closed before open" }));
    setTimeout(() => done({ ok: false, error: "timeout" }), 5_000);
  });
}

type Waiter = {
  match: (message: ServerMessage) => boolean;
  resolve: (message: ServerMessage) => void;
  timer: ReturnType<typeof setTimeout>;
};

class Session {
  readonly ws: WebSocket;
  private queue: ServerMessage[] = [];
  private waiters: Waiter[] = [];

  constructor(port: number, token: string) {
    this.ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
    );
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
    timeoutMs = 10_000,
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

test("R1: cross-origin upgrades are rejected; same-origin, allowlist, native pass", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-net-origin-"));
  const api = await createApiRuntime(configFor(dir));
  const started = await startServer(api, "secret", {
    allowedOrigins: ["https://app.example.com"],
    rateLimit: false,
  });
  try {
    const sameOrigin = `http://127.0.0.1:${started.port}`;
    assert.deepEqual(
      await connect(started.port, { token: "secret", origin: sameOrigin }),
      { ok: true },
    );
    assert.deepEqual(
      await connect(started.port, {
        token: "secret",
        origin: "https://app.example.com",
      }),
      { ok: true },
    );
    // Native shells/tunnels usually send no Origin at all.
    assert.deepEqual(await connect(started.port, { token: "secret" }), { ok: true });

    // TLS-terminating proxies rewrite Host; X-Forwarded-Host is accepted for
    // same-origin verification (browsers cannot forge it).
    const forwarded = await connect(started.port, {
      token: "secret",
      origin: "https://proxy.example.com",
      headers: { "x-forwarded-host": "proxy.example.com" },
    });
    assert.deepEqual(forwarded, { ok: true });

    const crossSite = await connect(started.port, {
      token: "secret",
      origin: "http://evil.example",
    });
    assert.equal(crossSite.ok, false);
    assert.match(crossSite.error ?? "", /403/);

    const unauthenticated = await connect(started.port, { origin: sameOrigin });
    assert.equal(unauthenticated.ok, false);
    assert.match(unauthenticated.error ?? "", /401/);
  } finally {
    await stop(started);
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("R1: a token-less runtime is refused unless anonymous access is explicit", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-net-anon-"));
  const api = await createApiRuntime({ ...configFor(dir), token: "" });
  const strict = await startServer(api, "", {
    allowAnonymous: false,
    rateLimit: false,
  });
  const permissive = await startServer(api, "", {
    allowAnonymous: true,
    rateLimit: false,
  });
  try {
    const refused = await connect(strict.port, {});
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? "", /401/);

    assert.deepEqual(await connect(permissive.port, {}), { ok: true });
  } finally {
    await stop(strict);
    await stop(permissive);
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("R8: upgrades and submits are rate limited with a clear error", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-net-rate-"));
  const api = await createApiRuntime(configFor(dir));
  const started = await startServer(api, "secret", {
    rateLimit: { limit: 2, windowMs: 60_000 },
  });
  try {
    const session = new Session(started.port, "secret");
    await session.open();
    session.send({ t: "hello", v: 2, clientId: "rate-limit" });
    await session.next((message) => message.t === "welcome");

    for (const requestId of ["rate-1", "rate-2"]) {
      session.send({ t: "submit", requestId, content: `message ${requestId}` });
      const ack = await session.next(
        (message) => message.t === "ack" && message.requestId === requestId,
      );
      assert.ok(ack.t === "ack");
    }
    session.send({ t: "submit", requestId: "rate-3", content: "message rate-3" });
    const limitedSubmit = await session.next(
      (message) =>
        message.t === "error" &&
        message.requestId === "rate-3",
    );
    assert.ok(limitedSubmit.t === "error");
    assert.match(limitedSubmit.message, /Rate limit exceeded/);
    session.close();

    // The session's upgrade consumed one IP slot; the next fills the budget and
    // the following upgrade is refused with 429.
    assert.equal((await connect(started.port, { token: "secret" })).ok, true);
    const overLimit = await connect(started.port, { token: "secret" });
    assert.equal(overLimit.ok, false);
    assert.match(overLimit.error ?? "", /429/);
  } finally {
    await stop(started);
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("R8: the shared rate limiter windows, prunes, and can be disabled", () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 1_000 });
  assert.ok(limiter);
  const start = 10_000;
  assert.equal(limiter!.take("health:1.2.3.4", start).allowed, true);
  assert.equal(limiter!.take("health:1.2.3.4", start + 1).allowed, true);
  const blocked = limiter!.take("health:1.2.3.4", start + 2);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  assert.equal(limiter!.take("health:5.6.7.8", start + 2).allowed, true);
  assert.equal(limiter!.take("health:1.2.3.4", start + 1_001).allowed, true);

  assert.equal(createRateLimiter({ limit: 0 }), undefined);
  assert.equal(createRateLimiter(false), undefined);
});

test("R8: device tokens can be unregistered over the gateway", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-net-device-"));
  const api = await createApiRuntime(configFor(dir));
  const started = await startServer(api, "secret", { rateLimit: false });
  try {
    const session = new Session(started.port, "secret");
    await session.open();
    session.send({ t: "push-device", token: "i".repeat(64), platform: "ios" });
    session.send({ t: "push-device", token: "a".repeat(64), platform: "android" });
    await waitFor(async () => {
      const entries = (await api.storage.settingsMatching("device:")).filter(
        (entry) => entry.value !== "",
      );
      return entries.length === 2 ? entries : undefined;
    });

    session.send({ t: "push-device", token: "", platform: "ios" });
    const remaining = await waitFor(async () => {
      const entries = (await api.storage.settingsMatching("device:")).filter(
        (entry) => entry.value !== "",
      );
      return entries.length === 1 ? entries : undefined;
    });
    assert.match(remaining[0]!.value, /"platform":"android"/);
    session.close();
  } finally {
    await stop(started);
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
