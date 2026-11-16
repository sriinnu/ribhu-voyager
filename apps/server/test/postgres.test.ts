import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PostgresStorage,
  closeApiTokenPools,
  issueApiToken,
  listApiTokens,
  migrateSqliteToPostgres,
  provisionAppRole,
  resolveApiToken,
  revokeApiToken,
  revokeApiTokenById,
} from "@ribhu-voyager/storage-postgres";
import { Db } from "@ribhu-voyager/storage-sqlite";

const IMAGE = "pgvector/pgvector:pg17";
const PORT = 55433;
const NAME = `ribhu-pg-${process.pid}`;
const URL = `postgres://postgres:ribhu@127.0.0.1:${PORT}/ribhu`;

let ready = false;
try {
  execFileSync("docker", ["image", "inspect", IMAGE], {
    stdio: "ignore",
    timeout: 10_000,
  });
  ready = true;
} catch {
  ready = false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "Postgres storage admits once, fences leases, and archives",
  { timeout: 120_000, skip: ready ? false : "docker/postgres image unavailable" },
  async () => {
    execFileSync("docker", [
      "run",
      "--rm",
      "-d",
      "--name",
      NAME,
      "-e",
      "POSTGRES_PASSWORD=ribhu",
      "-e",
      "POSTGRES_DB=ribhu",
      "-p",
      `${PORT}:5432`,
      IMAGE,
    ]);
    const storage = new PostgresStorage(URL);
    try {
      let connected = false;
      for (let attempt = 0; attempt < 240 && !connected; attempt += 1) {
        try {
          await storage.init();
          connected = true;
        } catch {
          await sleep(250);
        }
      }
      assert.equal(connected, true, "Postgres did not become ready");

      const sqliteDir = await mkdtemp(join(tmpdir(), "ribhu-pg-migrate-"));
      const sqlitePath = join(sqliteDir, "local.sqlite");
      const local = new Db(sqlitePath);
      const localRoot = local.ensureRoot();
      local.appendEntry({
        conversationId: localRoot,
        kind: "pi.user",
        model: [{ role: "user", content: "migrated message", timestamp: 1 }],
      });
      local.setSetting("auth_revision", "migrated");
      local.close();
      const counts = await migrateSqliteToPostgres(sqlitePath, URL);
      assert.equal(counts.conversations, 1);
      assert.equal(counts.entries, 1);
      assert.equal(await storage.getSetting("auth_revision"), "migrated");
      assert.equal((await storage.view(localRoot)).entries.length, 1);
      const migrations = await storage.pool.query(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      assert.deepEqual(
        migrations.rows.map((row) => Number(row.version)),
        [1, 2, 3, 4, 5, 6, 7],
      );
      const search = await storage.searchConversations("migrated message");
      assert.equal(search.length, 1);
      assert.match(search[0]?.snippet ?? "", /migrated/);
      await rm(sqliteDir, { recursive: true, force: true });

      const root = await storage.ensureRoot();
      const first = await storage.admitSubmission(root, "pg-1", "hello");
      const duplicate = await storage.admitSubmission(root, "pg-1", "hello");
      assert.equal(duplicate.id, first.id);
      assert.equal((await storage.queuedSubmissions(root)).length, 1);

      const job = await storage.claimRun("worker-a", 30_000);
      assert.ok(job);
      assert.equal(job?.kind, "run");
      assert.equal(job?.fence, 1);
      assert.equal(await storage.jobOwned(job!.id, "worker-a", job!.fence), true);

      await storage.renewRun(job!.id, "worker-a", 1, job!.fence);
      await sleep(20);
      const reclaimed = await storage.claimRun("worker-b", 30_000);
      assert.equal(reclaimed?.id, job!.id);
      assert.ok(reclaimed!.fence > job!.fence);
      assert.equal(await storage.jobOwned(job!.id, "worker-a", job!.fence), false);
      assert.equal(
        await storage.jobOwned(reclaimed!.id, "worker-b", reclaimed!.fence),
        true,
      );
      await storage.finishRun(reclaimed!.id, "worker-b");
      const queue = await storage.queueStats();
      assert.equal(queue.pending, 0);
      assert.equal(queue.running, 0);
      assert.equal(queue.oldestPendingAgeMs, null);

      await provisionAppRole(URL, "ribhu_app", "ribhu_app");
      const appUrl =
        "postgres://ribhu_app:ribhu_app@127.0.0.1:55433/ribhu";
      const tenantA = new PostgresStorage(appUrl, "tenant-a");
      const tenantB = new PostgresStorage(appUrl, "tenant-b");
      await tenantA.init();
      await tenantB.init();
      try {
        const rootA = await tenantA.ensureRoot();
        const rootB = await tenantB.ensureRoot();
        assert.notEqual(rootA, rootB);
        await tenantA.admitSubmission(rootA, "tenant-r1", "alpha only");
        const listA = await tenantA.listConversations();
        const listB = await tenantB.listConversations();
        assert.equal(listA.length, 1);
        assert.equal(listB.length, 1);
        assert.equal(listA[0]?.id, rootA);
        assert.equal(listB[0]?.id, rootB);
        assert.equal((await tenantB.view(rootA)).entries.length, 0);
        assert.equal((await tenantA.view(rootA)).entries.length, 1);
        assert.equal((await tenantB.claimRun("tenant-b-worker", 30_000)), undefined);
        const jobA = await tenantA.claimRun("tenant-a-worker", 30_000);
        assert.ok(jobA);
        assert.equal(jobA?.conversation_id, rootA);
        assert.equal((await tenantB.queueStats()).pending, 0);
        await tenantA.finishRun(jobA!.id, "tenant-a-worker");
        const sameRequest = await tenantB.admitSubmission(
          rootB,
          "tenant-r1",
          "beta only",
        );
        assert.notEqual(sameRequest.id, 0);

        await tenantA.setSetting("auth_mode", "api-key");
        assert.equal(await tenantA.getSetting("auth_mode"), "api-key");
        assert.equal(await tenantB.getSetting("auth_mode"), undefined);
        await tenantA.requestCancel(rootA);
        assert.equal(await tenantA.isCancelRequested(rootA), true);
        assert.equal(await tenantB.isCancelRequested(rootA), false);
        await tenantA.clearCancel(rootA);

        const token = await issueApiToken(URL, "tenant-a", "test");
        assert.equal(await resolveApiToken(URL, token), "tenant-a");
        const expired = await issueApiToken(URL, "tenant-a", "expired", {
          expiresInDays: 1,
          now: Date.now() - 2 * 86_400_000,
        });
        assert.equal(await resolveApiToken(URL, expired), undefined);
        const records = await listApiTokens(URL, "tenant-a");
        assert.ok(records.some((record) => record.label === "test"));
        assert.ok(records.some((record) => record.label === "expired"));
        const active = records.find((record) => record.label === "test");
        assert.ok(active);
        assert.equal(await revokeApiTokenById(URL, active!.id), true);
        assert.equal(await resolveApiToken(URL, token), undefined);
        await revokeApiToken(URL, expired);
        assert.equal(await resolveApiToken(URL, expired), undefined);
      } finally {
        await tenantA.close();
        await tenantB.close();
      }

      const second = await storage.createConversation("Second");
      const list = await storage.listConversations();
      // The superuser test connection bypasses RLS and sees the tenant rows too.
      assert.equal(list.length, 4);
      await storage.archiveConversation(second, true);
      assert.equal((await storage.listConversations()).length, 3);
      assert.equal((await storage.listConversations(true)).length, 4);
    } finally {
      await closeApiTokenPools();
      await storage.close().catch(() => undefined);
      try {
        execFileSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
      } catch {
        /* container already gone */
      }
    }
  },
);
