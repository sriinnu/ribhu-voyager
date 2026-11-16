import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect as netConnect } from "node:net";
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
import { loadConfig, type Config } from "../src/config.js";
import {
  attachGateway,
  type Gateway,
  type GatewayOptions,
} from "../src/gateway.js";
import { healthResponse } from "../src/health.js";
import { startWorker } from "../src/worker.js";
import {
  createRuntimePool,
  isCapacityExceeded,
  runtimeForGateway,
  runtimeInfo,
  type ApiRuntimeFactory,
  type ResolvedRuntime,
  type RuntimeCapacityExceeded,
  type RuntimePool,
  type RuntimeResolveResult,
} from "../src/runtime-pool.js";

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

function expectResolved(value: RuntimeResolveResult): ResolvedRuntime {
  assert.ok(value, "expected the pool to resolve a tenant runtime");
  if (isCapacityExceeded(value)) {
    throw new Error(`unexpected capacity refusal: ${value.message}`);
  }
  return value;
}

function expectCapacity(value: RuntimeResolveResult): RuntimeCapacityExceeded {
  assert.ok(value, "expected a capacity refusal");
  if (!isCapacityExceeded(value)) {
    throw new Error("expected the pool to report capacity_exceeded");
  }
  return value;
}

/** Pool over isolated SQLite dirs; token `token-<tenant>` selects the tenant. */
function createPoolFor(
  baseDir: string,
  tenantDirs: Map<string, string>,
  options: number | Partial<Config> = {},
): RuntimePool {
  const extra =
    typeof options === "number" ? { maxTenantRuntimes: options } : options;
  const factory: ApiRuntimeFactory = async (tenantConfig, tenantId) => {
    const dir = tenantDirs.get(tenantId);
    if (!dir) throw new Error(`no data dir for tenant ${tenantId}`);
    return createApiRuntime(
      { ...tenantConfig, dataDir: dir, workspaceDir: join(dir, "workspace") },
      tenantId,
    );
  };
  return createRuntimePool(
    { ...configFor(baseDir), ...extra } as Config,
    async (token) =>
      token.startsWith("token-") ? token.slice("token-".length) : undefined,
    factory,
  );
}

type FakeRuntime = ApiRuntime & { closed: boolean };

/** Lightweight runtimes for eviction tests: only close() is observed. */
function fakeRuntimeFactory(): {
  runtimes: Map<string, FakeRuntime>;
  factory: ApiRuntimeFactory;
} {
  const runtimes = new Map<string, FakeRuntime>();
  const factory: ApiRuntimeFactory = async (_config, tenantId) => {
    const runtime = {
      serverId: `fake-${tenantId}`,
      startedAt: Date.now(),
      demo: true,
      tenantId,
      model: { provider: "demo", modelId: "ribhu-demo" },
      storage: {},
      closed: false,
      authInfo: async () => undefined,
      close: async () => {
        runtime.closed = true;
      },
      conversation: async () => undefined,
    } as unknown as FakeRuntime;
    runtimes.set(tenantId, runtime);
    return runtime;
  };
  return { runtimes, factory };
}

function createFakePool(
  baseDir: string,
  factory: ApiRuntimeFactory,
  extra: Partial<Config> = {},
): RuntimePool {
  return createRuntimePool(
    {
      ...configFor(baseDir),
      tenantRuntimeTtlMs: 600_000,
      tenantEvictIntervalMs: 0,
      ...extra,
    } as Config,
    async (token) =>
      token.startsWith("token-") ? token.slice("token-".length) : undefined,
    factory,
  );
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
    this.ws.on("error", () => undefined);
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
  extra: Partial<GatewayOptions> = {},
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
      ...extra,
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
    const a = expectResolved(await pool.resolve("token-a"));
    assert.equal(a.tenantId, "tenant-a");
    assert.equal(a.info.serverId, a.runtime.serverId);
    assert.equal(a.info.provider, "demo");

    // Cached: the same token never creates a second runtime.
    assert.equal(await pool.resolve("token-a"), a);
    assert.equal(pool.infoFor(a.runtime), a.info);

    const b = expectResolved(await pool.resolve("token-b"));
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
    const resolved = expectResolved(await pool.resolve("shared"));
    assert.equal(resolved.tenantId, "default");
    assert.equal(
      resolved.runtime.serverId,
      expectResolved(await pool.resolve("shared")).runtime.serverId,
    );
    assert.equal(await pool.resolve("wrong"), undefined);
    assert.equal(await pool.resolve(undefined), undefined);
  } finally {
    await pool.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("R6: RIBBHU_MAX_TENANT_RUNTIMES defaults to 20 and accepts 0", () => {
  assert.equal(loadConfig({}).maxTenantRuntimes, 20);
  assert.equal(
    loadConfig({ RIBBHU_MAX_TENANT_RUNTIMES: "5" }).maxTenantRuntimes,
    5,
  );
  assert.equal(
    loadConfig({ RIBBHU_MAX_TENANT_RUNTIMES: "0" }).maxTenantRuntimes,
    0,
  );
  assert.throws(
    () => loadConfig({ RIBBHU_MAX_TENANT_RUNTIMES: "-1" }),
    /RIBBHU_MAX_TENANT_RUNTIMES must be a non-negative integer/,
  );
  assert.throws(
    () => loadConfig({ RIBBHU_MAX_TENANT_RUNTIMES: "1.5" }),
    /RIBBHU_MAX_TENANT_RUNTIMES must be a non-negative integer/,
  );
});

test("R6: pool caps new tenants but keeps serving existing ones", { timeout: 20_000 }, async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "ribhu-pool-cap-"));
  const dirs = new Map<string, string>([
    ["tenant-a", await mkdtemp(join(tmpdir(), "ribhu-pool-cap-a-"))],
    ["tenant-b", await mkdtemp(join(tmpdir(), "ribhu-pool-cap-b-"))],
    ["tenant-c", await mkdtemp(join(tmpdir(), "ribhu-pool-cap-c-"))],
  ]);
  const pool = createPoolFor(baseDir, dirs, 2);
  try {
    const a = expectResolved(await pool.resolve("token-tenant-a"));
    const b = expectResolved(await pool.resolve("token-tenant-b"));

    const refused = expectCapacity(await pool.resolve("token-tenant-c"));
    assert.equal(refused.error, "capacity_exceeded");
    assert.equal(refused.tenantId, "tenant-c");
    assert.equal(refused.activeTenants, 2);
    assert.equal(refused.limit, 2);
    assert.match(refused.message, /capacity reached/i);

    // Existing tenants are never evicted or re-created by the cap.
    assert.equal(expectResolved(await pool.resolve("token-tenant-a")), a);
    assert.equal(expectResolved(await pool.resolve("token-tenant-b")), b);

    assert.deepEqual(pool.stats(), {
      activeTenants: 2,
      pendingTenants: 0,
      activeClients: 0,
      idle: 2,
      evictable: 0,
      maxTenants: 2,
      unlimited: false,
      ttlMs: 600_000,
      tenants: ["tenant-a", "tenant-b"],
    });

    // An unknown token is still a normal rejection, not a capacity error.
    assert.equal(await pool.resolve("bogus"), undefined);
  } finally {
    await pool.close();
    await Promise.all(
      [...dirs.values()].map((dir) => rm(dir, { recursive: true, force: true })),
    );
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("R6: maxTenantRuntimes=0 means unlimited", { timeout: 20_000 }, async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "ribhu-pool-unlimited-"));
  const dirs = new Map<string, string>([
    ["tenant-a", await mkdtemp(join(tmpdir(), "ribhu-pool-uncapped-a-"))],
    ["tenant-b", await mkdtemp(join(tmpdir(), "ribhu-pool-uncapped-b-"))],
    ["tenant-c", await mkdtemp(join(tmpdir(), "ribhu-pool-uncapped-c-"))],
  ]);
  const pool = createPoolFor(baseDir, dirs, 0);
  try {
    expectResolved(await pool.resolve("token-tenant-a"));
    expectResolved(await pool.resolve("token-tenant-b"));
    expectResolved(await pool.resolve("token-tenant-c"));
    assert.deepEqual(pool.stats(), {
      activeTenants: 3,
      pendingTenants: 0,
      activeClients: 0,
      idle: 3,
      evictable: 0,
      maxTenants: 0,
      unlimited: true,
      ttlMs: 600_000,
      tenants: ["tenant-a", "tenant-b", "tenant-c"],
    });
  } finally {
    await pool.close();
    await Promise.all(
      [...dirs.values()].map((dir) => rm(dir, { recursive: true, force: true })),
    );
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("R6: health returns 503 with pool stats when capacity is exhausted", { timeout: 20_000 }, async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "ribhu-pool-health-"));
  const dirs = new Map<string, string>([
    ["tenant-a", await mkdtemp(join(tmpdir(), "ribhu-pool-health-a-"))],
    ["tenant-b", await mkdtemp(join(tmpdir(), "ribhu-pool-health-b-"))],
  ]);
  const pool = createPoolFor(baseDir, dirs, 1);
  try {
    expectResolved(await pool.resolve("token-tenant-a"));

    const refused = await healthResponse(pool, "token-tenant-b", Date.now());
    assert.equal(refused.status, 503);
    assert.equal(refused.payload.ok, false);
    assert.equal(refused.payload.error, "capacity_exceeded");
    assert.match(String(refused.payload.message), /capacity reached/i);
    assert.deepEqual(refused.payload.pool, {
      activeTenants: 1,
      maxTenants: 1,
    });

    const healthy = await healthResponse(pool, "token-tenant-a", Date.now());
    assert.equal(healthy.status, 200);
    assert.equal(healthy.payload.ok, true);
    assert.ok(healthy.payload.worker, "authenticated health is detailed");
    assert.deepEqual(healthy.payload.pool, {
      activeTenants: 1,
      pendingTenants: 0,
      activeClients: 0,
      idle: 1,
      evictable: 0,
      maxTenants: 1,
      unlimited: false,
      ttlMs: 600_000,
      tenants: ["tenant-a"],
    });

    const anonymous = await healthResponse(pool, "unknown", Date.now());
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.payload.pool, undefined);
  } finally {
    await pool.close();
    await Promise.all(
      [...dirs.values()].map((dir) => rm(dir, { recursive: true, force: true })),
    );
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("R6: WS upgrade returns 503 when a new tenant exceeds capacity", { timeout: 30_000 }, async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "ribhu-pool-upgrade-"));
  const dirs = new Map<string, string>([
    ["tenant-a", await mkdtemp(join(tmpdir(), "ribhu-pool-upgrade-a-"))],
    ["tenant-b", await mkdtemp(join(tmpdir(), "ribhu-pool-upgrade-b-"))],
  ]);
  const pool = createPoolFor(baseDir, dirs, 1);
  const { port, gateway, server } = await startGateway(async (token) =>
    runtimeForGateway(await pool.resolve(token)),
  );
  const clientA = new TestClient(port, "token-tenant-a");
  let clientB: TestClient | undefined;
  let again: TestClient | undefined;
  try {
    await clientA.open();
    clientA.send({ t: "hello", v: PROTOCOL_VERSION, clientId: "tenant-a" });
    const welcome = welcomeOf(
      await clientA.next((message) => message.t === "welcome"),
    );
    assert.equal(welcome.info.serverId, expectResolved(await pool.resolve("token-tenant-a")).runtime.serverId);

    // A second tenant is refused at the upgrade boundary (503), not 401.
    clientB = new TestClient(port, "token-tenant-b");
    await assert.rejects(
      clientB.open(),
      /503|Unexpected server response/,
    );

    // The already-active tenant can still connect/reconnect.
    again = new TestClient(port, "token-tenant-a");
    await again.open();
  } finally {
    clientA.close();
    clientB?.close();
    again?.close();
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.close();
    await Promise.all(
      [...dirs.values()].map((dir) => rm(dir, { recursive: true, force: true })),
    );
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("R6: worker validates and logs its single tenant", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-worker-tenant-"));
  try {
    await assert.rejects(
      startWorker({ ...configFor(dir), tenantId: "bad tenant!" }),
      /RIBBHU_TENANT .* is invalid/,
    );

    const lines: string[] = [];
    const worker = await startWorker(
      { ...configFor(dir), tenantId: "tenant-a", maxTenantRuntimes: 7 },
      { log: (line) => lines.push(line) },
    );
    try {
      assert.ok(
        lines.some((line) => /tenant\s+tenant-a/.test(line)),
        "worker logs its tenant",
      );
    } finally {
      await worker.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Send an upgrade request that is missing Sec-WebSocket-Key, so ws aborts it. */
function rawUpgrade(port: number): Promise<void> {
  return new Promise((resolve) => {
    const socket = netConnect(port, "127.0.0.1", () => {
      socket.write(
        "GET /ws?token=good HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
    });
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve();
    };
    socket.on("close", done);
    socket.on("error", done);
    socket.on("data", () => undefined);
    setTimeout(done, 2_000);
  });
}

test("R6: tenant eviction env defaults and validation", () => {
  const defaults = loadConfig({});
  assert.equal(defaults.tenantRuntimeTtlMs, 600_000);
  assert.equal(defaults.tenantEvictIntervalMs, 60_000);

  assert.equal(
    loadConfig({ RIBBHU_TENANT_RUNTIME_TTL_MS: "0" }).tenantRuntimeTtlMs,
    0,
  );
  assert.equal(
    loadConfig({ RIBBHU_TENANT_EVICT_INTERVAL_MS: "0" }).tenantEvictIntervalMs,
    0,
  );
  assert.throws(
    () => loadConfig({ RIBBHU_TENANT_RUNTIME_TTL_MS: "-1" }),
    /RIBBHU_TENANT_RUNTIME_TTL_MS must be a non-negative integer/,
  );
  assert.throws(
    () => loadConfig({ RIBBHU_TENANT_EVICT_INTERVAL_MS: "1.5" }),
    /RIBBHU_TENANT_EVICT_INTERVAL_MS must be a non-negative integer/,
  );
});

test("R6: acquire/release tracks active clients and clamps release", { timeout: 20_000 }, async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "ribhu-evict-acquire-"));
  const { runtimes, factory } = fakeRuntimeFactory();
  const pool = createFakePool(baseDir, factory);
  try {
    const a = expectResolved(await pool.acquire("token-tenant-a"));
    const b = expectResolved(await pool.acquire("token-tenant-b"));
    assert.equal(runtimes.get("tenant-a"), a.runtime);

    let stats = pool.stats();
    assert.equal(stats.activeTenants, 2);
    assert.equal(stats.activeClients, 2);
    assert.equal(stats.idle, 0);
    assert.equal(stats.evictable, 0);
    assert.equal(stats.ttlMs, 600_000);

    pool.release(a.runtime);
    stats = pool.stats();
    assert.equal(stats.activeClients, 1);
    assert.equal(stats.idle, 1);

    // Never underflow: releasing twice must not steal another client's slot.
    pool.release(a.runtime);
    assert.equal(pool.stats().activeClients, 1);

    pool.release(b.runtime);
    assert.equal(pool.stats().activeClients, 0);
    assert.equal(pool.stats().idle, 2);

    // Unknown runtimes are ignored.
    pool.release({} as ApiRuntime);
    assert.equal(pool.stats().activeClients, 0);
  } finally {
    await pool.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("R6: idle eviction closes only idle runtimes; active ones survive", { timeout: 20_000 }, async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "ribhu-evict-idle-"));
  const { runtimes, factory } = fakeRuntimeFactory();
  const pool = createFakePool(baseDir, factory, {
    tenantRuntimeTtlMs: 10,
    tenantEvictIntervalMs: 0,
    maxTenantRuntimes: 5,
  });
  try {
    const active = expectResolved(await pool.acquire("token-tenant-a"));
    const idle = expectResolved(await pool.acquire("token-tenant-b"));
    pool.release(idle.runtime);
    await sleep(30);

    assert.equal(pool.stats().evictable, 1);
    assert.equal(pool.stats().activeClients, 1);

    const evicted = await pool.evictIdle(Date.now());
    assert.deepEqual(evicted, ["tenant-b"]);
    assert.equal(runtimes.get("tenant-b")!.closed, true);
    assert.equal(runtimes.get("tenant-a")!.closed, false, "active runtime survives");
    assert.deepEqual(pool.stats().tenants, ["tenant-a"]);

    pool.release(active.runtime);
    await sleep(30);
    const later = await pool.evictIdle(Date.now());
    assert.deepEqual(later, ["tenant-a"]);
    assert.equal(runtimes.get("tenant-a")!.closed, true);
    assert.equal(pool.stats().activeTenants, 0);
  } finally {
    await pool.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("R6: capacity pressure evicts the least-recently-used idle runtime", { timeout: 20_000 }, async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "ribhu-evict-lru-"));
  const { runtimes, factory } = fakeRuntimeFactory();
  const pool = createFakePool(baseDir, factory, {
    maxTenantRuntimes: 2,
    tenantRuntimeTtlMs: 10,
    tenantEvictIntervalMs: 0,
  });
  try {
    const a = expectResolved(await pool.acquire("token-tenant-a"));
    pool.release(a.runtime);
    await sleep(15);
    const b = expectResolved(await pool.acquire("token-tenant-b"));
    pool.release(b.runtime);
    await sleep(20);

    // tenant-a is the LRU idle runtime, so it is reclaimed for tenant-c.
    const c = expectResolved(await pool.resolve("token-tenant-c"));
    assert.equal(runtimes.get("tenant-a")!.closed, true);
    assert.equal(runtimes.get("tenant-b")!.closed, false);
    assert.equal(runtimes.get("tenant-c"), c.runtime);
    assert.deepEqual(pool.stats().tenants, ["tenant-b", "tenant-c"]);
  } finally {
    await pool.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("R6: no evictable runtime still returns the capacity error", { timeout: 20_000 }, async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "ribhu-evict-none-"));
  const { runtimes, factory } = fakeRuntimeFactory();
  const pool = createFakePool(baseDir, factory, {
    maxTenantRuntimes: 1,
    tenantRuntimeTtlMs: 600_000,
    tenantEvictIntervalMs: 0,
  });
  try {
    const a = expectResolved(await pool.acquire("token-tenant-a"));
    expectCapacity(await pool.resolve("token-tenant-b"));
    pool.release(a.runtime); // idle but nowhere near the TTL
    assert.equal(pool.stats().evictable, 0);
    const refused = expectCapacity(await pool.resolve("token-tenant-b"));
    assert.equal(refused.limit, 1);
    assert.equal(runtimes.get("tenant-b"), undefined, "no runtime was created");
  } finally {
    await pool.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("R6: the periodic sweep evicts expired idle runtimes and stops on close", { timeout: 20_000 }, async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "ribhu-evict-timer-"));
  const { runtimes, factory } = fakeRuntimeFactory();
  const pool = createFakePool(baseDir, factory, {
    tenantRuntimeTtlMs: 5,
    tenantEvictIntervalMs: 10,
    maxTenantRuntimes: 5,
  });
  try {
    const a = expectResolved(await pool.acquire("token-tenant-a"));
    pool.release(a.runtime);
    await waitFor(async () =>
      runtimes.get("tenant-a")?.closed === true ? true : undefined,
    );
    assert.equal(pool.stats().activeTenants, 0);
  } finally {
    await pool.close();
    // close() cleared the timer; a manual sweep afterwards is a safe no-op.
    assert.deepEqual(await pool.evictIdle(), []);
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("R6: gateway hooks fire once per connection and release failed upgrades", { timeout: 30_000 }, async () => {
  const runtime = {
    serverId: "fake-hooks",
    conversation: async () => undefined,
  } as unknown as GatewayRuntime;
  const connects: Array<{ runtime: GatewayRuntime; token?: string }> = [];
  const disconnects: GatewayRuntime[] = [];
  const { port, gateway, server } = await startGateway(
    async (token) => (token === "good" ? runtime : undefined),
    {
      onRuntimeConnect: (target, token) => {
        connects.push({ runtime: target, token });
      },
      onRuntimeDisconnect: (target) => {
        disconnects.push(target);
      },
    },
  );
  const client = new TestClient(port, "good");
  try {
    await client.open();
    await waitFor(async () => (connects.length === 1 ? true : undefined));
    assert.equal(connects[0]!.runtime, runtime);
    assert.equal(connects[0]!.token, "good");

    // Rejected token never invokes the lifecycle hooks.
    const bad = new TestClient(port, "bad");
    await assert.rejects(bad.open(), /401|Unexpected server response/);
    bad.close();
    assert.equal(connects.length, 1);
    assert.equal(disconnects.length, 0);

    // A handshake that never completes must release its reserved runtime.
    await rawUpgrade(port);
    await waitFor(async () => (disconnects.length === 1 ? true : undefined));
    assert.equal(disconnects[0], runtime);

    // Normal close releases exactly once (no double-release on close/error).
    client.close();
    await waitFor(async () => (disconnects.length === 2 ? true : undefined));
    await sleep(50);
    assert.equal(disconnects.length, 2);
  } finally {
    client.close();
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
