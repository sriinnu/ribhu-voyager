import { PROTOCOL_VERSION } from "@ribhu-voyager/protocol";

import type { ApiRuntime } from "./api-runtime.js";
import {
  isCapacityExceeded,
  type RuntimePool,
  type RuntimeResolveResult,
} from "./runtime-pool.js";

/** A worker heartbeat older than this is reported as not alive. */
export const WORKER_STALE_MS = 15_000;
const HEARTBEAT_PREFIX = "worker_heartbeat:";
const JOB_PREFIX = "worker_job:";

export type WorkerJob = {
  id: number;
  conversationId: number;
  owner: string;
  startedAt: number;
};

export type WorkerSnapshot = {
  owner: string;
  alive: boolean;
  heartbeatAgeMs: number | null;
  job: WorkerJob | null;
};

function parseJob(raw: string | undefined): WorkerJob | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WorkerJob;
  } catch {
    return null;
  }
}

export type HealthResponse = {
  status: number;
  payload: Record<string, unknown>;
};

/**
 * R6: resolve a health caller through the bounded tenant pool.
 *
 * - Exhausted pool capacity for a *new* tenant → 503 with a clear message.
 * - Unknown/missing token → 200 minimal payload (unchanged public behavior).
 * - Authenticated tenant → 200 detailed payload including pool stats.
 */
export async function healthResponse(
  pool: Pick<RuntimePool, "resolve" | "stats">,
  token: string | undefined,
  startedAt: number,
): Promise<HealthResponse> {
  const resolved: RuntimeResolveResult = await pool.resolve(token);
  if (isCapacityExceeded(resolved)) {
    return {
      status: 503,
      payload: {
        ok: false,
        error: "capacity_exceeded",
        message: resolved.message,
        pool: {
          activeTenants: resolved.activeTenants,
          maxTenants: resolved.limit,
        },
      },
    };
  }
  if (!resolved) {
    return {
      status: 200,
      payload: {
        ok: true,
        protocol: PROTOCOL_VERSION,
        uptimeMs: Date.now() - startedAt,
      },
    };
  }
  return {
    status: 200,
    payload: {
      ...(await healthPayload(resolved.runtime, true)),
      pool: pool.stats(),
    },
  };
}

export async function healthPayload(
  runtime: ApiRuntime,
  detailed = true,
): Promise<Record<string, unknown>> {
  if (!detailed) {
    return {
      ok: true,
      protocol: PROTOCOL_VERSION,
      uptimeMs: Date.now() - runtime.startedAt,
    };
  }
  const now = Date.now();

  // Every worker publishes a per-owner heartbeat plus its own job key, so the
  // snapshot lists all workers instead of whichever one wrote last.
  const [heartbeats, workerJobs] = await Promise.all([
    runtime.storage.settingsMatching(HEARTBEAT_PREFIX),
    runtime.storage.settingsMatching(JOB_PREFIX),
  ]);
  const jobsByOwner = new Map<string, string>();
  for (const pair of workerJobs) {
    jobsByOwner.set(pair.key.slice(JOB_PREFIX.length), pair.value);
  }

  const workers: WorkerSnapshot[] = [];
  for (const pair of heartbeats) {
    const heartbeat = Number(pair.value);
    // A cleared heartbeat belongs to a worker that already shut down.
    if (!Number.isFinite(heartbeat) || heartbeat <= 0) continue;
    const owner = pair.key.slice(HEARTBEAT_PREFIX.length);
    const heartbeatAgeMs = Math.max(0, now - heartbeat);
    const alive = heartbeatAgeMs < WORKER_STALE_MS;
    workers.push({
      owner,
      alive,
      heartbeatAgeMs,
      job: alive ? parseJob(jobsByOwner.get(owner)) : null,
    });
  }
  workers.sort((left, right) => left.owner.localeCompare(right.owner));

  // Aggregate keys stay for clients that predate the per-worker snapshot.
  const aggregateHeartbeat = Number(
    (await runtime.storage.getSetting("worker_heartbeat")) ?? 0,
  );
  const workerAlive = workers.some((worker) => worker.alive);
  let heartbeatAgeMs =
    aggregateHeartbeat > 0 ? Math.max(0, now - aggregateHeartbeat) : null;
  const alive =
    (heartbeatAgeMs !== null && heartbeatAgeMs < WORKER_STALE_MS) || workerAlive;
  if (heartbeatAgeMs === null && workers.length > 0) {
    const ages = workers
      .map((worker) => worker.heartbeatAgeMs)
      .filter((age): age is number => age !== null);
    heartbeatAgeMs = ages.length > 0 ? Math.min(...ages) : null;
  }

  let job: WorkerJob | null = null;
  const rawJob = await runtime.storage.getSetting("worker_job");
  if (alive && rawJob) job = parseJob(rawJob);

  const auth = await runtime.authInfo();
  const authError = await runtime.storage.getSetting("auth_error");
  return {
    ok: true,
    protocol: PROTOCOL_VERSION,
    demo: runtime.demo,
    model: runtime.model.modelId,
    provider: runtime.model.provider,
    ...(auth ? { auth } : {}),
    ...(authError ? { authError } : {}),
    uptimeMs: Date.now() - runtime.startedAt,
    worker: {
      alive,
      heartbeatAgeMs,
      job,
      workers,
    },
    queue: await runtime.storage.queueStats(),
  };
}
