import { PROTOCOL_VERSION } from "@ribhu-voyager/protocol";

import type { ApiRuntime } from "./api-runtime.js";

const WORKER_STALE_MS = 15_000;

export type WorkerJob = {
  id: number;
  conversationId: number;
  owner: string;
  startedAt: number;
};

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
  const heartbeat = Number((await runtime.storage.getSetting("worker_heartbeat")) ?? 0);
  const heartbeatAgeMs = heartbeat > 0 ? Date.now() - heartbeat : null;
  const alive = heartbeatAgeMs !== null && heartbeatAgeMs < WORKER_STALE_MS;

  let job: WorkerJob | null = null;
  const rawJob = await runtime.storage.getSetting("worker_job");
  if (alive && rawJob) {
    try {
      job = JSON.parse(rawJob) as WorkerJob;
    } catch {
      job = null;
    }
  }

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
    },
    queue: await runtime.storage.queueStats(),
  };
}
