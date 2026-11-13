import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApiRuntime } from "../src/api-runtime.js";
import type { Config } from "../src/config.js";
import { healthPayload } from "../src/health.js";
import { startWorker } from "../src/worker.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - start >= timeoutMs) {
      throw new Error("timed out waiting for the expected state");
    }
    await sleep(50);
  }
}

type WorkerHealth = {
  alive: boolean;
  heartbeatAgeMs: number | null;
  job: { id: number; owner: string } | null;
  workers: Array<{
    owner: string;
    alive: boolean;
    heartbeatAgeMs: number | null;
    job: { id: number; owner: string } | null;
  }>;
};

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
    token: "",
    authMode: "auto",
    authSource: "auto",
  };
}

test("health reports worker liveness, job and queue depth", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-health-"));
  const api = await createApiRuntime(configFor(dir));
  try {
    await api.storage.setSetting("worker_heartbeat", String(Date.now()));
    await api.storage.setSetting(
      "worker_job",
      JSON.stringify({
        id: 7,
        conversationId: 1,
        owner: "test:1",
        startedAt: Date.now(),
      }),
    );
    await api.storage.enqueueRun(1);

    const health = await healthPayload(api);
    const worker = health.worker as {
      alive: boolean;
      heartbeatAgeMs: number;
      job: { id: number } | null;
    };
    assert.equal(worker.alive, true);
    assert.ok(worker.heartbeatAgeMs >= 0);
    assert.equal(worker.job?.id, 7);
    const queue = health.queue as { pending: number; running: number };
    assert.equal(queue.pending, 1);
    assert.equal(queue.running, 0);

    const publicHealth = await healthPayload(api, false);
    assert.deepEqual(Object.keys(publicHealth).sort(), [
      "ok",
      "protocol",
      "uptimeMs",
    ]);
    assert.equal(publicHealth.worker, undefined);
    assert.equal(publicHealth.auth, undefined);

    await api.storage.setSetting("worker_heartbeat", String(Date.now() - 20_000));
    const stale = (await healthPayload(api)).worker as {
      alive: boolean;
      job: unknown;
    };
    assert.equal(stale.alive, false);
    assert.equal(stale.job, null);
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("health snapshots every worker and one finishing does not erase the other", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-health-workers-"));
  const api = await createApiRuntime(configFor(dir));
  const first = await startWorker(configFor(dir));
  const second = await startWorker(configFor(dir));
  try {
    const heartbeats = await waitFor(async () => {
      const pairs = await api.storage.settingsMatching("worker_heartbeat:");
      return pairs.length >= 2 ? pairs : undefined;
    });
    assert.equal(heartbeats.length, 2);
    const owners = heartbeats.map((pair) => pair.key.slice("worker_heartbeat:".length));
    assert.notEqual(owners[0], owners[1], "each worker has its own owner key");

    const initial = (await healthPayload(api)).worker as WorkerHealth;
    assert.equal(initial.alive, true);
    assert.equal(initial.workers.length, 2);
    assert.deepEqual(
      initial.workers.map((worker) => worker.alive),
      [true, true],
    );
    assert.deepEqual(
      initial.workers.map((worker) => worker.owner).sort(),
      [...owners].sort(),
    );
    for (const worker of initial.workers) {
      assert.ok(typeof worker.heartbeatAgeMs === "number");
      assert.ok(worker.heartbeatAgeMs! >= 0);
      assert.equal(worker.job, null, "both workers are idle");
    }

    // A per-worker job key is reported on that worker's own snapshot entry.
    const target = owners.sort()[0]!;
    await api.storage.setSetting(
      `worker_job:${target}`,
      JSON.stringify({
        id: 42,
        conversationId: 1,
        owner: target,
        startedAt: Date.now(),
      }),
    );
    const withJob = (await healthPayload(api)).worker as WorkerHealth;
    const targetWorker = withJob.workers.find((worker) => worker.owner === target);
    assert.equal(targetWorker?.job?.id, 42);
    assert.equal(targetWorker?.job?.owner, target);

    // Finishing one worker keeps the other one visible and alive.
    await first.close();
    const remaining = await waitFor(async () => {
      const worker = (await healthPayload(api)).worker as WorkerHealth;
      const alive = worker.workers.filter((entry) => entry.alive);
      return alive.length === 1 ? worker : undefined;
    });
    assert.equal(remaining.alive, true);
    assert.equal(remaining.workers.length, 1);
    assert.ok(
      owners.includes(remaining.workers[0]!.owner),
      "the surviving worker is one of the original owners",
    );
    assert.equal(remaining.workers[0]!.alive, true);
    const remainingHeartbeats = (
      await api.storage.settingsMatching("worker_heartbeat:")
    ).filter((pair) => Number(pair.value) > 0);
    assert.equal(
      remainingHeartbeats.length,
      1,
      "the finished worker cleared its own heartbeat key",
    );
  } finally {
    await second.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
