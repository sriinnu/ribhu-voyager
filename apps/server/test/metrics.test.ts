import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAdminApi, type AdminRequest } from "../src/admin.js";
import { createApiRuntime } from "../src/api-runtime.js";
import type { Config } from "../src/config.js";
import type { PoolStats } from "../src/runtime-pool.js";

function configFor(dir: string, overrides: Partial<Config> = {}): Config {
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
    token: "",
    authMode: "auto",
    authSource: "auto",
    ...overrides,
  };
}

function request(overrides: Partial<AdminRequest> = {}): AdminRequest {
  return {
    method: "GET",
    pathname: "/api/metrics",
    headers: {},
    query: new URLSearchParams(),
    ...overrides,
  };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function metricValue(body: string, name: string): number {
  const match = new RegExp(`^ribhu_${name} (\\S+)$`, "m").exec(body);
  assert.ok(match, `missing metric ribhu_${name} in:\n${body}`);
  return Number(match![1]);
}

test("metrics are admin-protected Prometheus text with queue/worker/usage/pool gauges", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-metrics-"));
  const config = configFor(dir, { adminToken: "metrics-token" });
  const api = await createApiRuntime(config);
  const conversation = await api.conversation();
  assert.ok(conversation);
  const poolStats: PoolStats = {
    activeTenants: 1,
    pendingTenants: 0,
    activeClients: 2,
    idle: 0,
    evictable: 0,
    maxTenants: 20,
    unlimited: false,
    ttlMs: 600_000,
    tenants: ["default"],
  };
  const admin = createAdminApi(config, { poolStats: () => poolStats });
  try {
    await api.storage.recordUsage({
      provider: "demo",
      model: "ribhu-demo",
      inputTokens: 40,
      outputTokens: 10,
      costMicros: 120,
    });
    await api.storage.setSetting(
      "worker_heartbeat:alive-worker",
      String(Date.now()),
    );
    await api.storage.setSetting(
      "worker_heartbeat:stale-worker",
      String(Date.now() - 60_000),
    );
    await api.storage.enqueueRun(conversation.id);

    // Disabled admin surface (SQLite, no env token) still 404s.
    const off = createAdminApi(configFor(join(dir, "off")));
    assert.equal((await off.handle(request()))?.status, 404);
    await off.close();

    assert.equal((await admin.handle(request()))?.status, 401);
    assert.equal(
      (await admin.handle(request({ headers: bearer("wrong") })))?.status,
      401,
    );

    const response = await admin.handle(request({ headers: bearer("metrics-token") }));
    assert.equal(response?.status, 200);
    assert.match(
      response!.headers["content-type"] ?? "",
      /text\/plain; version=0\.0\.4/,
    );
    const body = response!.body;
    assert.match(body, /# HELP ribhu_queue_pending_jobs /);
    assert.match(body, /# TYPE ribhu_tenant_runtimes_active gauge/);

    assert.equal(metricValue(body, "queue_pending_jobs"), 1);
    assert.equal(metricValue(body, "queue_running_jobs"), 0);
    assert.ok(metricValue(body, "queue_oldest_pending_age_seconds") >= 0);
    assert.equal(metricValue(body, "workers_total"), 2);
    assert.equal(metricValue(body, "workers_alive"), 1);
    assert.equal(metricValue(body, "usage_day_tokens"), 50);
    assert.equal(metricValue(body, "usage_month_tokens"), 50);
    assert.equal(metricValue(body, "usage_month_cost_micros"), 120);
    assert.equal(metricValue(body, "tenant_runtimes_active"), 1);
    assert.equal(metricValue(body, "tenant_runtimes_capacity"), 20);
    assert.equal(metricValue(body, "tenant_runtimes_unlimited"), 0);
    assert.ok(metricValue(body, "schema_version") >= 1);

    assert.equal(
      (
        await admin.handle(
          request({ method: "POST", headers: bearer("metrics-token") }),
        )
      )?.status,
      405,
    );
    // /api/health is still handled elsewhere, unchanged.
    assert.equal(await admin.handle(request({ pathname: "/api/health" })), undefined);
  } finally {
    await admin.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
