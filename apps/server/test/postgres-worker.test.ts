import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { StaleFence, admitSubmission } from "@ribhu-voyager/engine";
import { PostgresStorage } from "@ribhu-voyager/storage-postgres";

import type { Config } from "../src/config.js";
import { startWorker } from "../src/worker.js";

const IMAGE = "pgvector/pgvector:pg17";
const PORT = 55437;
const NAME = `ribhu-pg-worker-${process.pid}`;
const URL = `postgres://postgres:ribhu@127.0.0.1:${PORT}/ribhu`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    storage: "postgres",
    postgresUrl: URL,
  };
}

test(
  "a hosted worker claims and answers from Postgres",
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
    const dir = await mkdtemp(join(tmpdir(), "ribhu-pg-worker-"));
    const api = new PostgresStorage(URL);
    try {
      let connected = false;
      for (let attempt = 0; attempt < 240 && !connected; attempt += 1) {
        try {
          await api.init();
          connected = true;
        } catch {
          await sleep(250);
        }
      }
      assert.equal(connected, true);
      const root = await api.ensureRoot();
      const worker = await startWorker(configFor(dir));
      const secondWorker = await startWorker(configFor(dir));
      try {
        await admitSubmission(api, root, {
          type: "input",
          content: "run: echo hosted-worker",
          requestId: "hosted-worker-1",
          whenBusy: "steer",
        });
        let view = await api.view(root);
        for (let attempt = 0; attempt < 120; attempt += 1) {
          view = await api.view(root);
          if (view.entries.some((entry) => entry.kind === "pi.tool-result")) {
            break;
          }
          await sleep(100);
        }
        const tool = view.entries.find((entry) => entry.kind === "pi.tool-result");
        assert.ok(tool);
        assert.match(JSON.stringify(tool.model), /hosted-worker/);
        await sleep(500);
        assert.equal(
          view.entries.filter((entry) => entry.kind === "pi.assistant").length,
          1,
          "two workers produced one answer",
        );
      } finally {
        await secondWorker.close();
        await worker.close();
      }
    } finally {
      await api.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
      try {
        execFileSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
      } catch {
        /* gone */
      }
    }
  },
);

const HARDENING_PORT = 55447;
const HARDENING_NAME = `ribhu-pg-hardening-${process.pid}`;
const HARDENING_URL = `postgres://postgres:ribhu@127.0.0.1:${HARDENING_PORT}/ribhu`;

test(
  "Postgres queue uniqueness and fences reject a stale worker",
  { timeout: 120_000, skip: ready ? false : "docker/postgres image unavailable" },
  async () => {
    execFileSync("docker", [
      "run",
      "--rm",
      "-d",
      "--name",
      HARDENING_NAME,
      "-e",
      "POSTGRES_PASSWORD=ribhu",
      "-e",
      "POSTGRES_DB=ribhu",
      "-p",
      `${HARDENING_PORT}:5432`,
      IMAGE,
    ]);
    const api = new PostgresStorage(HARDENING_URL);
    const other = new PostgresStorage(HARDENING_URL);
    try {
      let connected = false;
      for (let attempt = 0; attempt < 240 && !connected; attempt += 1) {
        try {
          await api.init();
          connected = true;
        } catch {
          await sleep(250);
        }
      }
      assert.equal(connected, true);
      await other.init();
      const root = await api.ensureRoot();

      // R2: partial unique indexes exist and concurrent enqueues collapse.
      const indexes = await api.pool.query(
        "SELECT indexname FROM pg_indexes WHERE indexname IN ('jobs_active_run','jobs_active_compact') ORDER BY indexname",
      );
      assert.deepEqual(
        indexes.rows.map((row) => String(row.indexname)),
        ["jobs_active_compact", "jobs_active_run"],
      );
      await Promise.all([api.enqueueRun(root), other.enqueueRun(root)]);
      const active = await api.pool.query(
        "SELECT COUNT(*)::int AS n FROM jobs WHERE conversation_id = $1 AND kind = 'run' AND status IN ('pending','running')",
        [root],
      );
      assert.equal(Number(active.rows[0]?.n), 1, "concurrent enqueues create one job");

      // R2: concurrent claims are serialized by the per-conversation lock.
      const [claimA, claimB] = await Promise.all([
        api.claimRun("worker-a", 30_000),
        other.claimRun("worker-b", 30_000),
      ]);
      const claimed = [claimA, claimB].filter((job) => job !== undefined);
      assert.equal(claimed.length, 1, "only one worker claims the conversation");
      const job = claimed[0]!;

      // R3: expire the lease, let worker B reclaim, and reject A's guarded writes.
      await api.renewRun(job.id, job.owner!, 1, job.fence);
      await sleep(40);
      const reclaimed = await other.claimRun("worker-b", 30_000);
      assert.ok(reclaimed);
      assert.equal(reclaimed.id, job.id);
      assert.ok(reclaimed.fence > job.fence);

      const guardA = { jobId: job.id, owner: job.owner!, fence: job.fence };
      const guardB = {
        jobId: reclaimed.id,
        owner: "worker-b",
        fence: reclaimed.fence,
      };
      await assert.rejects(
        api.appendEntry(
          {
            conversationId: root,
            kind: "pi.assistant",
            model: [
              {
                role: "assistant",
                content: [{ type: "text", text: "stale" }],
                stopReason: "stop",
                timestamp: Date.now(),
                usage: { input: 0, output: 0, totalTokens: 0 },
              },
            ],
          },
          guardA,
        ),
        (error: unknown) => error instanceof StaleFence,
      );
      await assert.rejects(
        api.createToolTask(root, "call_stale", "bash", {}, false, guardA),
        (error: unknown) => error instanceof StaleFence,
      );
      const accepted = await other.appendEntry(
        {
          conversationId: root,
          kind: "pi.assistant",
          model: [
            {
              role: "assistant",
              content: [{ type: "text", text: "fresh" }],
              stopReason: "stop",
              timestamp: Date.now(),
              usage: { input: 0, output: 0, totalTokens: 0 },
            },
          ],
        },
        guardB,
      );
      assert.ok(accepted > 0);
      const answers = await api.entries(root);
      assert.equal(
        answers.entries.filter((entry) => entry.kind === "pi.assistant").length,
        1,
        "exactly one answer is committed across the two workers",
      );
      const task = await other.createToolTask(root, "call_ok", "bash", {}, false, guardB);
      await other.finishToolTask(task.id, "ok", "done", guardB);
      await assert.rejects(
        api.finishToolTask(task.id, "stale", "done", guardA),
        (error: unknown) => error instanceof StaleFence,
      );
      await other.finishRun(reclaimed.id, "worker-b");
    } finally {
      await api.close().catch(() => undefined);
      await other.close().catch(() => undefined);
      try {
        execFileSync("docker", ["rm", "-f", HARDENING_NAME], { stdio: "ignore" });
      } catch {
        /* gone */
      }
    }
  },
);
