import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_RUN_TOKEN_BUDGET,
  Engine,
  resolveModelPricing,
  type Conversation,
  type ModelRef,
  type Provider,
  type QueueJob,
  type Storage,
} from "@ribhu-voyager/engine";
import { createProvider } from "@ribhu-voyager/providers";
import { Db, serializedStorage } from "@ribhu-voyager/storage-sqlite";
import { PostgresStorage } from "@ribhu-voyager/storage-postgres";

import { AuthManager } from "./auth.js";
import { PiAuthStore, defaultAuthFile } from "./auth-store.js";
import { ClaudeCodeAuthStore } from "./claude-code-auth.js";
import type { Config } from "./config.js";
import { WORKER_STALE_MS } from "./health.js";
import { createPushNotifier } from "./push.js";
import { createToolRunner } from "./tools-runtime.js";

const INSTRUCTIONS = [
  "You are Ribhu Voyager, a coding agent running on the user's machine.",
  "Your working directory is the root of the project you are working on.",
  "Use the read, write, edit, and bash tools to inspect and change files.",
  "Work in small, verified steps: read a file before editing it, prefer targeted edits,",
  "and run the relevant test or command after changing code.",
  "Never claim a result you have not observed in tool output.",
  "When you finish, summarize the files you changed and the commands you ran.",
].join(" ");

const LEASE_MS = 120_000;
const IDLE_MS = 120;

export type WorkerHandle = {
  engine: Engine;
  storage: Storage;
  root: Conversation;
  auth?: AuthManager;
  close(): Promise<void>;
};

export type WorkerOptions = {
  log?: (line: string) => void;
  /** Test/embedding seam: use a specific provider instead of env config. */
  provider?: Provider;
};

export async function startWorker(
  config: Config,
  options: WorkerOptions = {},
): Promise<WorkerHandle> {
  const log = options.log ?? (() => undefined);

  // R6: the tenancy contract is one worker per tenant, not a shared pool. Make
  // the tenant explicit at startup and validate it even for embedded callers
  // that construct a Config by hand (loadConfig already validates env input).
  const workerTenant = config.tenantId ?? "default";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(workerTenant)) {
    throw new Error(
      `RIBBHU_TENANT "${workerTenant}" is invalid; use 1-64 letters, digits, dash, or underscore.`,
    );
  }
  const poolCap = config.maxTenantRuntimes ?? 20;
  log(
    `tenant    ${workerTenant}` +
      (config.storage === "postgres"
        ? ` (one worker per tenant; API runtime cap ${poolCap === 0 ? "unlimited" : poolCap})`
        : " (local data dir; one worker owns it)"),
  );

  await mkdir(config.dataDir, { recursive: true });
  await mkdir(config.workspaceDir, { recursive: true });

  const storage: Storage =
    config.storage === "postgres" && config.postgresUrl
      ? new PostgresStorage(config.postgresUrl, config.tenantId ?? "default")
      : serializedStorage(new Db(join(config.dataDir, "ribhu.sqlite")));
  if (storage instanceof PostgresStorage) await storage.init();
  const authFile = defaultAuthFile();
  const piStore = new PiAuthStore(
    authFile === "none" ? join(config.dataDir, ".no-pi-auth.json") : authFile,
  );
  const auth = new AuthManager({
    pi: piStore,
    claudeCode: new ClaudeCodeAuthStore(),
    apiKey: config.anthropicApiKey,
    requestedMode: config.authMode,
    requestedSource: config.authSource,
    log: (line) => log(`auth      ${line}`),
  });
  if (!config.demo && config.provider === "anthropic") {
    await auth.init();
  }

  const publishAuth = async () => {
    if (!config.demo && config.provider === "anthropic") {
      await storage.setSetting("auth_info", JSON.stringify(auth.info()));
      await storage.setSetting("auth_revision", String(Date.now()));
    }
  };
  await publishAuth();

  const provider =
    options.provider ??
    createProvider({
      provider: config.demo ? "demo" : config.provider,
      model: config.demo ? "ribhu-demo" : config.model,
      getAnthropicAuth: () => auth.token(),
      env: process.env,
    });

  const model: ModelRef = config.demo
    ? { provider: "demo", modelId: "ribhu-demo" }
    : { provider: config.provider, modelId: config.model };

  const push = createPushNotifier(storage, config);
  const engine = await Engine.open({
    storage,
    provider,
    runner: createToolRunner({
      sandbox: config.sandbox ?? "local",
      image: config.sandboxImage ?? "node:24-bookworm",
      approvals: config.approvals ?? "allow",
    }),
    cwd: config.workspaceDir,
    model,
    instructions: INSTRUCTIONS,
    maxWindowEntries: config.maxWindowEntries,
    approvals: config.approvals ?? "allow",
    pricing: resolveModelPricing(
      config.modelPricing,
      model.provider,
      model.modelId,
      config.costMicrosPer1kTokens,
    ),
    tokenBudget: config.runTokenBudget ?? DEFAULT_RUN_TOKEN_BUDGET,
    costBudgetMicros: config.runCostMicros ?? 0,
    onApprovalRequest: (conversationId, request) =>
      push.notify({ conversationId, ...request }),
    autoRun: false,
    recoverOnOpen: false,
    log: (line) => log(`engine    ${line}`),
  });

  const root = await engine.root();
  // Unique per worker instance: two workers in one process must not share a
  // health key, while the owner string stays stable for the whole lifetime.
  const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const heartbeatKey = `worker_heartbeat:${owner}`;
  const jobKey = `worker_job:${owner}`;
  let stopped = false;
  let current: Promise<void> | null = null;

  const writeHeartbeat = async () => {
    const now = String(Date.now());
    try {
      // Aggregate key keeps older clients working; per-owner key lets health
      // report every worker instead of whichever one wrote last.
      await storage.setSetting("worker_heartbeat", now);
      await storage.setSetting(heartbeatKey, now);
    } catch {
      /* storage unavailable */
    }
  };

  const publishJob = async (job: QueueJob) => {
    const value = JSON.stringify({
      id: job.id,
      conversationId: job.conversation_id,
      owner,
      startedAt: Date.now(),
    });
    await storage.setSetting("worker_job", value);
    await storage.setSetting(jobKey, value);
  };

  const clearJobKeys = async () => {
    try {
      await storage.setSetting(jobKey, "");
    } catch {
      /* storage unavailable */
    }
    try {
      // Only clear the aggregate when it still names this worker, so one
      // worker finishing never erases another worker's job.
      const raw = await storage.getSetting("worker_job");
      if (!raw) return;
      let currentOwner: unknown;
      try {
        currentOwner = (JSON.parse(raw) as { owner?: unknown }).owner;
      } catch {
        currentOwner = undefined;
      }
      if (currentOwner === owner) await storage.setSetting("worker_job", "");
    } catch {
      /* storage unavailable */
    }
  };

  const clearHeartbeat = async () => {
    try {
      await storage.setSetting(heartbeatKey, "");
    } catch {
      /* storage unavailable */
    }
    try {
      // Drop the aggregate heartbeat too once no worker is alive, so a graceful
      // shutdown does not leave a fresh-but-dead aggregate for old clients.
      const remaining = await storage.settingsMatching("worker_heartbeat:");
      const now = Date.now();
      const anyAlive = remaining.some((pair) => {
        const timestamp = Number(pair.value);
        return timestamp > 0 && now - timestamp < WORKER_STALE_MS;
      });
      if (!anyAlive) await storage.setSetting("worker_heartbeat", "");
    } catch {
      /* storage unavailable */
    }
  };

  await clearJobKeys();

  for (const id of await storage.conversationIdsWithOpenWork()) {
    await storage.enqueueRun(id);
  }

  let nextAuthAt = 0;
  const syncAuth = async () => {
    if (config.demo || config.provider !== "anthropic") return;
    if (Date.now() < nextAuthAt) return;
    const requested = await storage.getSetting("auth_mode");
    if (requested !== "subscription" && requested !== "api-key") return;
    if (auth.info().mode === requested) return;
    try {
      await auth.setMode(requested);
      await publishAuth();
      await storage.setSetting("auth_error", "");
      await storage.recordAudit({
        actor: "worker",
        action: "auth.mode_applied",
        target: "auth",
        data: { mode: requested },
      });
      nextAuthAt = 0;
    } catch (error) {
      nextAuthAt = Date.now() + 5_000;
      await storage.setSetting(
        "auth_error",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const loop = async () => {
    while (!stopped) {
      try {
        await syncAuth();
        await writeHeartbeat();
        const job = await storage.claimRun(owner, LEASE_MS);
        if (!job) {
          await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
          continue;
        }
        log(`job ${job.id} conversation ${job.conversation_id}`);
        await publishJob(job);
        const heartbeat = setInterval(() => {
          void writeHeartbeat();
        }, 10_000);
        heartbeat.unref?.();
        const renew = setInterval(async () => {
          try {
            if (!(await storage.renewRun(job.id, owner, LEASE_MS, job.fence))) {
              log(`lease lost for job ${job.id}`);
              engine.loseLease(job.conversation_id);
            }
          } catch (error) {
            log(`lease renewal failed: ${String(error)}`);
            engine.loseLease(job.conversation_id);
          }
        }, Math.floor(LEASE_MS / 3));
        renew.unref?.();
        // Thread the claimed lease into engine writes: storage rejects any
        // commit made after this worker loses the job/fence.
        const guard = { jobId: job.id, owner, fence: job.fence };
        const leaseValid = () => storage.jobOwned(job.id, owner, job.fence);
        try {
          if (job.kind === "compact") {
            await engine.compact(job.conversation_id, undefined, leaseValid, guard);
          } else {
            await engine.recoverConversation(job.conversation_id, leaseValid, guard);
            await engine.run(job.conversation_id, leaseValid, guard);
          }
        } catch (error) {
          log(
            `run failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          clearInterval(renew);
          clearInterval(heartbeat);
          try {
            await storage.tx(async () => {
              await storage.finishRun(job.id, owner);
              if (
                (
                  await storage.conversationIdsWithOpenWork()
                ).includes(job.conversation_id)
              ) {
                await storage.enqueueRun(job.conversation_id);
              }
            });
          } catch (error) {
            log(`job cleanup failed: ${String(error)}`);
          }
          await clearJobKeys();
        }
      } catch (error) {
        try {
          await storage.setSetting(
            "worker_error",
            error instanceof Error ? error.message : String(error),
          );
        } catch {
          /* storage unavailable; keep the loop alive */
        }
        log(`worker iteration failed: ${String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  };

  current = loop();
  void current.catch((error) => log(`worker stopped: ${String(error)}`));

  return {
    engine,
    storage,
    root,
    ...(config.demo || config.provider !== "anthropic" ? {} : { auth }),
    async close() {
      stopped = true;
      engine.abortAll();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          current?.catch(() => undefined) ?? Promise.resolve(),
          new Promise((resolve) => {
            deadline = setTimeout(resolve, 30_000);
          }),
        ]);
      } finally {
        if (deadline) clearTimeout(deadline);
      }
      await clearJobKeys();
      await clearHeartbeat();
      await engine.close();
    },
  };
}
