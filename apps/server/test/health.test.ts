import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApiRuntime } from "../src/api-runtime.js";
import type { Config } from "../src/config.js";
import { healthPayload } from "../src/health.js";

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
