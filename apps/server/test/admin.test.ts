import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hashAdminToken } from "@ribhu-voyager/storage-postgres";

import { createAdminApi, type AdminRequest } from "../src/admin.js";
import { createApiRuntime } from "../src/api-runtime.js";
import type { Config } from "../src/config.js";

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

function adminRequest(overrides: Partial<AdminRequest> = {}): AdminRequest {
  return {
    method: "GET",
    pathname: "/api/admin/tenants",
    headers: {},
    query: new URLSearchParams(),
    ...overrides,
  };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

test("admin routes do not exist when RIBBHU_ADMIN_TOKEN is unset", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-admin-off-"));
  const admin = createAdminApi(configFor(dir));
  try {
    assert.equal(admin.enabled, false);
    const tenants = await admin.handle(adminRequest());
    assert.equal(tenants?.status, 404);
    const page = await admin.handle(adminRequest({ pathname: "/admin" }));
    assert.equal(page?.status, 404);
    const health = await admin.handle(adminRequest({ pathname: "/api/health" }));
    assert.equal(health, undefined, "non-admin routes are left to the server");
  } finally {
    await admin.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("admin API requires a valid bearer token and serves the dashboard", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-admin-auth-"));
  const admin = createAdminApi(configFor(dir, { adminToken: "s3cret-token" }));
  try {
    assert.equal(admin.enabled, true);
    assert.equal((await admin.handle(adminRequest()))?.status, 401);
    assert.equal(
      (await admin.handle(adminRequest({ headers: bearer("wrong") })))?.status,
      401,
    );
    assert.equal(
      (await admin.handle(adminRequest({ headers: { authorization: "Bearer " } })))
        ?.status,
      401,
    );

    const ok = await admin.handle(
      adminRequest({ headers: bearer("s3cret-token") }),
    );
    assert.equal(ok?.status, 200);
    assert.deepEqual(JSON.parse(ok!.body), { tenants: ["default"] });

    assert.equal(
      (await admin.handle(
        adminRequest({ method: "POST", headers: bearer("s3cret-token") }),
      ))?.status,
      405,
    );
    assert.equal(
      (
        await admin.handle(
          adminRequest({
            pathname: "/api/admin/nope",
            headers: bearer("s3cret-token"),
          }),
        )
      )?.status,
      404,
    );

    const page = await admin.handle(adminRequest({ pathname: "/admin" }));
    assert.equal(page?.status, 200);
    assert.match(page?.headers["content-type"] ?? "", /text\/html/);
    assert.match(page!.body, /id="token"/);
    assert.match(page!.body, /\/api\/admin\/usage/);
    assert.match(page!.body, /admin bearer token/);
  } finally {
    await admin.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("admin usage/audit JSON and quota writes use the default SQLite tenant", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-admin-data-"));
  const config = configFor(dir, { adminToken: "admin-token" });
  const api = await createApiRuntime(config);
  const admin = createAdminApi(config);
  try {
    await api.storage.recordUsage({
      conversationId: 1,
      submissionId: 7,
      provider: "demo",
      model: "ribhu-demo",
      inputTokens: 40,
      outputTokens: 10,
      costMicros: 120,
    });
    await api.storage.recordUsage({
      conversationId: 1,
      submissionId: 8,
      provider: "demo",
      model: "ribhu-demo",
      inputTokens: 5,
      outputTokens: 5,
      costMicros: 20,
    });
    await api.storage.recordAudit({
      actor: "engine",
      action: "approval.requested",
      target: "1:call_1",
      data: { tool: "bash" },
    });

    const usage = await admin.handle(
      adminRequest({
        pathname: "/api/admin/usage",
        headers: bearer("admin-token"),
      }),
    );
    assert.equal(usage?.status, 200);
    const usageBody = JSON.parse(usage!.body) as {
      tenant: string;
      day: { events: number; totalTokens: number; costMicros: number };
      month: { totalTokens: number };
      recent: Array<{ provider: string; conversationId: number }>;
    };
    assert.equal(usageBody.tenant, "default");
    assert.equal(usageBody.day.events, 2);
    assert.equal(usageBody.day.totalTokens, 60);
    assert.equal(usageBody.day.costMicros, 140);
    assert.equal(usageBody.month.totalTokens, 60);
    assert.equal(usageBody.recent.length, 2);
    assert.equal(usageBody.recent[0]?.provider, "demo");
    assert.equal(usageBody.recent[0]?.conversationId, 1);

    const audit = await admin.handle(
      adminRequest({
        pathname: "/api/admin/audit",
        headers: bearer("admin-token"),
        query: new URLSearchParams({ limit: "5" }),
      }),
    );
    assert.equal(audit?.status, 200);
    const auditBody = JSON.parse(audit!.body) as {
      tenant: string;
      events: Array<{ action: string; actor: string; data?: { tool?: string } }>;
    };
    assert.equal(auditBody.tenant, "default");
    assert.ok(auditBody.events.some((event) => event.action === "approval.requested"));
    assert.equal(
      auditBody.events.find((event) => event.action === "approval.requested")?.data
        ?.tool,
      "bash",
    );

    const quotaWrite = await admin.handle(
      adminRequest({
        method: "POST",
        pathname: "/api/admin/quota",
        headers: bearer("admin-token"),
        body: JSON.stringify({
          tenant: "default",
          dailyTokens: 5_000,
          monthlyCostMicros: 100_000,
        }),
      }),
    );
    assert.equal(quotaWrite?.status, 200);
    const quotaBody = JSON.parse(quotaWrite!.body) as {
      tenant: string;
      quota: { dailyTokens: number | null; monthlyCostMicros: number | null };
    };
    assert.equal(quotaBody.tenant, "default");
    assert.equal(quotaBody.quota.dailyTokens, 5_000);
    assert.equal(quotaBody.quota.monthlyCostMicros, 100_000);
    assert.deepEqual(await api.storage.quota(), {
      dailyTokens: 5_000,
      monthlyCostMicros: 100_000,
    });

    // Admin reads are audited with the env-token actor, and quota writes use it too.
    const tenantsRead = await admin.handle(
      adminRequest({ headers: bearer("admin-token") }),
    );
    assert.equal(tenantsRead?.status, 200);
    const adminAudit = await api.storage.listAudit(20);
    for (const action of [
      "admin.tenants_view",
      "admin.usage_view",
      "admin.audit_view",
      "quota.updated",
    ]) {
      const event = adminAudit.find((entry) => entry.action === action);
      assert.ok(event, `missing audit action ${action}`);
      assert.equal(event.actor, "admin");
    }

    // Validation and tenant scoping.
    assert.equal(
      (
        await admin.handle(
          adminRequest({
            method: "POST",
            pathname: "/api/admin/quota",
            headers: bearer("admin-token"),
            body: JSON.stringify({ tenant: "default", dailyTokens: -1 }),
          }),
        )
      )?.status,
      400,
    );
    assert.equal(
      (
        await admin.handle(
          adminRequest({
            pathname: "/api/admin/usage",
            headers: bearer("admin-token"),
            query: new URLSearchParams({ tenant: "other" }),
          }),
        )
      )?.status,
      404,
    );
    assert.equal(
      (
        await admin.handle(
          adminRequest({
            method: "POST",
            pathname: "/api/admin/quota",
            headers: bearer("admin-token"),
            body: "{not json",
          }),
        )
      )?.status,
      400,
    );
  } finally {
    await admin.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("admin token hashes are stable SHA-256 and never the plaintext", () => {
  const hash = hashAdminToken("ribhu_admin_secret-value");
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, "ribhu_admin_secret-value");
  assert.equal(hashAdminToken("ribhu_admin_secret-value"), hash);
  assert.notEqual(hashAdminToken("ribhu_admin_other"), hash);
});

test("retention deletes only old usage and audit rows", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-retention-"));
  const api = await createApiRuntime(configFor(dir));
  try {
    const now = Date.now();
    const old = now - 30 * 86_400_000;
    await api.storage.recordUsage({
      provider: "demo",
      model: "ribhu-demo",
      inputTokens: 10,
      outputTokens: 0,
      costMicros: 5,
      createdAt: old,
    });
    await api.storage.recordUsage({
      provider: "demo",
      model: "ribhu-demo",
      inputTokens: 20,
      outputTokens: 0,
      costMicros: 7,
      createdAt: now,
    });
    await api.storage.recordAudit({
      actor: "engine",
      action: "old.event",
      target: "x",
      createdAt: old,
    });
    await api.storage.recordAudit({
      actor: "engine",
      action: "new.event",
      target: "x",
      createdAt: now,
    });
    const conversation = await api.conversation();
    assert.ok(conversation);
    await api.storage.appendEntry({
      conversationId: conversation.id,
      kind: "test.keep",
      data: {},
    });

    // SQLite storage methods are sync behind the serialized async facade.
    const retention = api.storage as unknown as {
      deleteOldUsage(
        cutoff: number,
        options?: { dryRun?: boolean },
      ): Promise<number>;
      deleteOldAudit(
        cutoff: number,
        options?: { dryRun?: boolean },
      ): Promise<number>;
      schemaVersion(): Promise<number>;
    };
    const cutoff = now - 7 * 86_400_000;

    assert.equal(await retention.deleteOldUsage(cutoff, { dryRun: true }), 1);
    assert.equal(await retention.deleteOldAudit(cutoff, { dryRun: true }), 1);
    assert.equal((await api.storage.listUsage(10)).length, 2);
    assert.equal((await api.storage.listAudit(10)).length, 2);

    assert.equal(await retention.deleteOldUsage(cutoff), 1);
    assert.equal(await retention.deleteOldAudit(cutoff), 1);
    assert.equal((await api.storage.listUsage(10)).length, 1);
    assert.equal((await api.storage.listAudit(10)).length, 1);
    assert.equal((await api.storage.listUsage(10))[0]?.inputTokens, 20);

    // Journal entries and conversations are never touched by retention.
    const entries = (await api.storage.entries(conversation.id)).entries;
    assert.ok(entries.some((entry) => entry.kind === "test.keep"));
    assert.equal(await api.storage.conversationExists(conversation.id), true);
    assert.ok((await retention.schemaVersion()) >= 1);

    await assert.rejects(
      retention.deleteOldUsage(0),
      /positive epoch-ms timestamp/,
    );
    await assert.rejects(
      retention.deleteOldAudit(Number.NaN),
      /positive epoch-ms timestamp/,
    );
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
