import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { QuotaExceeded } from "@ribhu-voyager/engine";
import {
  LATEST_SCHEMA_VERSION,
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
          await storage.init({ migrate: true });
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
        [1, 2, 3, 4, 5, 6, 7, 8],
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

const DISCIPLINE_PORT = 55448;
const DISCIPLINE_NAME = `ribhu-pg-discipline-${process.pid}`;
const DISCIPLINE_URL = `postgres://postgres:ribhu@127.0.0.1:${DISCIPLINE_PORT}/ribhu`;

test(
  "under-migrated Postgres refuses startup until schema-admin migrations run",
  { timeout: 120_000, skip: ready ? false : "docker/postgres image unavailable" },
  async () => {
    execFileSync("docker", [
      "run",
      "--rm",
      "-d",
      "--name",
      DISCIPLINE_NAME,
      "-e",
      "POSTGRES_PASSWORD=ribhu",
      "-e",
      "POSTGRES_DB=ribhu",
      "-p",
      `${DISCIPLINE_PORT}:5432`,
      IMAGE,
    ]);
    const storage = new PostgresStorage(DISCIPLINE_URL);
    try {
      let connected = false;
      for (let attempt = 0; attempt < 240 && !connected; attempt += 1) {
        try {
          await storage.schemaVersion();
          connected = true;
        } catch {
          await sleep(250);
        }
      }
      assert.equal(connected, true);

      // App startup never runs DDL: a fresh database must fail clearly.
      await assert.rejects(
        storage.init(),
        (error: unknown) =>
          error instanceof Error && /schema is behind/.test(error.message),
        "init() verifies the schema and does not migrate it",
      );
      assert.equal(await storage.schemaVersion(), 0);

      // The explicit schema-admin path applies pending DDL.
      const version = await storage.migrateSchema();
      assert.equal(version, LATEST_SCHEMA_VERSION);
      await storage.init();
      assert.equal(await storage.schemaVersion(), LATEST_SCHEMA_VERSION);

      // Simulate a database that is behind this build.
      await storage.pool.query(
        "DELETE FROM schema_migrations WHERE version = $1",
        [LATEST_SCHEMA_VERSION],
      );
      await assert.rejects(
        storage.init(),
        (error: unknown) =>
          error instanceof Error && /schema is behind/.test(error.message),
      );
      assert.equal(await storage.migrateSchema(), LATEST_SCHEMA_VERSION);
      await storage.init();
    } finally {
      await storage.close().catch(() => undefined);
      try {
        execFileSync("docker", ["rm", "-f", DISCIPLINE_NAME], { stdio: "ignore" });
      } catch {
        /* container already gone */
      }
    }
  },
);

const RESERVATION_PORT = 55449;
const RESERVATION_NAME = `ribhu-pg-reservations-${process.pid}`;
const RESERVATION_URL = `postgres://postgres:ribhu@127.0.0.1:${RESERVATION_PORT}/ribhu`;

test(
  "Postgres quota reservations are atomic at the boundary",
  { timeout: 120_000, skip: ready ? false : "docker/postgres image unavailable" },
  async () => {
    execFileSync("docker", [
      "run",
      "--rm",
      "-d",
      "--name",
      RESERVATION_NAME,
      "-e",
      "POSTGRES_PASSWORD=ribhu",
      "-e",
      "POSTGRES_DB=ribhu",
      "-p",
      `${RESERVATION_PORT}:5432`,
      IMAGE,
    ]);
    const first = new PostgresStorage(RESERVATION_URL);
    const second = new PostgresStorage(RESERVATION_URL);
    try {
      let connected = false;
      for (let attempt = 0; attempt < 240 && !connected; attempt += 1) {
        try {
          await first.init({ migrate: true });
          connected = true;
        } catch {
          await sleep(250);
        }
      }
      assert.equal(connected, true);
      await second.init();
      const root = await first.ensureRoot();
      await first.setQuota({ dailyTokens: 100 });

      // Two connections reserve 60 tokens each against a 100-token limit.
      const outcomes = await Promise.allSettled([
        first.reserveQuota({
          conversationId: root,
          submissionId: 101,
          tokens: 60,
          costMicros: 0,
        }),
        second.reserveQuota({
          conversationId: root,
          submissionId: 102,
          tokens: 60,
          costMicros: 0,
        }),
      ]);
      const fulfilled = outcomes.filter((entry) => entry.status === "fulfilled");
      const rejected = outcomes.filter((entry) => entry.status === "rejected");
      assert.equal(fulfilled.length, 1, "exactly one reservation wins the boundary");
      assert.equal(rejected.length, 1);
      assert.ok(
        (rejected[0] as PromiseRejectedResult).reason instanceof QuotaExceeded,
      );
      const reservationId = (fulfilled[0] as PromiseFulfilledResult<
        { id: number } | undefined
      >).value!.id;

      // Failed work releases the reservation back to the pool.
      await first.releaseQuota(reservationId);
      const releasedReservation = await first.quotaReservationFor(
        fulfilled[0].status === "fulfilled" &&
          (fulfilled[0] as PromiseFulfilledResult<{ submissionId: number | null }>)
            .value?.submissionId === 101
          ? 101
          : 102,
      );
      assert.equal(releasedReservation?.status, "released");
      const released = await first.reserveQuota({
        conversationId: root,
        submissionId: 103,
        tokens: 60,
        costMicros: 0,
      });
      assert.ok(released, "released headroom can be reserved again");

      // Actual usage is recorded; committing keeps it counted.
      await first.tx(async () => {
        await first.recordUsage({
          conversationId: root,
          provider: "demo",
          model: "ribhu-demo",
          inputTokens: 30,
          outputTokens: 10,
          costMicros: 5,
        });
      });
      await first.commitQuota(released!.id);
      const committed = (await first.quotaReservationFor(103))!;
      assert.equal(committed.status, "committed");
      await assert.rejects(
        first.reserveQuota({ conversationId: root, tokens: 70, costMicros: 0 }),
        (error: unknown) => error instanceof QuotaExceeded,
        "committed usage (40) + another 70 crosses the 100-token limit",
      );
    } finally {
      await first.close().catch(() => undefined);
      await second.close().catch(() => undefined);
      try {
        execFileSync("docker", ["rm", "-f", RESERVATION_NAME], { stdio: "ignore" });
      } catch {
        /* container already gone */
      }
    }
  },
);
