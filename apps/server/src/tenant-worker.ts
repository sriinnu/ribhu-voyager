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
import {
  createSharedPostgresStorage,
} from "@ribhu-voyager/storage-postgres";

import { AuthManager } from "./auth.js";
import { PiAuthStore, defaultAuthFile } from "./auth-store.js";
import { ClaudeCodeAuthStore } from "./claude-code-auth.js";
import type { Config } from "./config.js";
import { WORKER_STALE_MS } from "./health.js";
import { createPushNotifier } from "./push.js";
import { createToolRunner } from "./tools-runtime.js";

const LEASE_MS = 120_000;
const IDLE_MS = 120;
/** How often the shared supervisor re-checks the tenants table. */
export const SHARED_WORKER_DISCOVER_MS = 60_000;

const INSTRUCTIONS = [
  "You are Ribhu Voyager, a coding agent running on the user's machine.",
  "Your working directory is the root of the project you are working on.",
  "Use the read, write, edit, and bash tools to inspect and change files.",
  "Work in small, verified steps: read a file before editing it, prefer targeted edits,",
  "and run the relevant test or command after changing code.",
  "Never claim a result you have not observed in tool output.",
  "When you finish, summarize the files you changed and the commands you ran.",
].join(" ");

export type TenantWorkerOptions = {
  config: Config;
  tenantId: string;
  /** Already-created tenant-scoped storage (shared pool, schema verified). */
  storage: Storage;
  /** Per-tenant workspace root; created if missing. */
  workspaceDir: string;
  /** Test/embedding seam; a factory lets a shared worker vary per tenant. */
  provider?: Provider | ((tenantId: string) => Provider);
  log?: (line: string) => void;
};

/**
 * One worker per tenant: owns that tenant's storage/engine/auth/push notifier
 * and a claim loop that can only see that tenant's jobs (RLS). The shared
 * multi-tenant supervisor runs several of these concurrently, so a slow tenant
 * never blocks another.
 */
export class TenantWorker {
  readonly tenantId: string;
  readonly engine: Engine;
  readonly storage: Storage;
  readonly root: Conversation;
  readonly auth?: AuthManager;

  private readonly log: (line: string) => void;
  private readonly owner: string;
  private readonly heartbeatKey: string;
  private readonly jobKey: string;
  private stopped = false;
  private loopPromise: Promise<void> | null = null;

  private constructor(
    options: Required<Pick<TenantWorkerOptions, "tenantId" | "storage">> & {
      engine: Engine;
      root: Conversation;
      auth?: AuthManager;
      log: (line: string) => void;
    },
  ) {
    this.tenantId = options.tenantId;
    this.engine = options.engine;
    this.storage = options.storage;
    this.root = options.root;
    if (options.auth) this.auth = options.auth;
    this.log = options.log;
    this.owner = `${hostname()}:${process.pid}:${options.tenantId}:${randomUUID().slice(0, 8)}`;
    this.heartbeatKey = `worker_heartbeat:${this.owner}`;
    this.jobKey = `worker_job:${this.owner}`;
  }

  static async open(options: TenantWorkerOptions): Promise<TenantWorker> {
    const { config, tenantId, storage } = options;
    const log =
      options.log ??
      ((line: string) => console.log(`  [${tenantId}] ${line}`));
    await mkdir(options.workspaceDir, { recursive: true });
    await mkdir(config.dataDir, { recursive: true });

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

    const providerOption = options.provider;
    const provider =
      typeof providerOption === "function"
        ? providerOption(tenantId)
        : providerOption ??
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
      cwd: options.workspaceDir,
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
      ...(config.providerRetry ? { providerRetry: config.providerRetry } : {}),
      onApprovalRequest: (conversationId, request) =>
        push.notify({ conversationId, ...request }),
      autoRun: false,
      recoverOnOpen: false,
      log: (line) => log(`engine    ${line}`),
    });

    const root = await engine.root();
    const worker = new TenantWorker({
      tenantId,
      storage,
      engine,
      root,
      ...(config.demo || config.provider !== "anthropic" ? {} : { auth }),
      log,
    });

    await worker.start({
      config,
      publishAuth,
      auth,
    });
    return worker;
  }

  private async start(context: {
    config: Config;
    publishAuth: () => Promise<void>;
    auth: AuthManager;
  }): Promise<void> {
    const { config, publishAuth, auth } = context;
    await this.clearJobKeys();
    for (const id of await this.storage.conversationIdsWithOpenWork()) {
      await this.storage.enqueueRun(id);
    }

    let nextAuthAt = 0;
    const syncAuth = async () => {
      if (config.demo || config.provider !== "anthropic") return;
      if (Date.now() < nextAuthAt) return;
      const requested = await this.storage.getSetting("auth_mode");
      if (requested !== "subscription" && requested !== "api-key") return;
      if (auth.info().mode === requested) return;
      try {
        await auth.setMode(requested);
        await publishAuth();
        await this.storage.setSetting("auth_error", "");
        await this.storage.recordAudit({
          actor: "worker",
          action: "auth.mode_applied",
          target: "auth",
          data: { mode: requested },
        });
        nextAuthAt = 0;
      } catch (error) {
        nextAuthAt = Date.now() + 5_000;
        await this.storage.setSetting(
          "auth_error",
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    const loop = async () => {
      while (!this.stopped) {
        try {
          await syncAuth();
          await this.writeHeartbeat();
          const job = await this.storage.claimRun(this.owner, LEASE_MS);
          if (job) console.error('DBG claimed', job.id);
          if (!job) {
            await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
            continue;
          }
          this.log(
            `job ${job.id} conversation ${job.conversation_id} tenant=${this.tenantId}`,
          );
          await this.publishJob(job);
          const heartbeat = setInterval(() => {
            void this.writeHeartbeat();
          }, 10_000);
          heartbeat.unref?.();
          const renew = setInterval(async () => {
            try {
              if (
                !(await this.storage.renewRun(
                  job.id,
                  this.owner,
                  LEASE_MS,
                  job.fence,
                ))
              ) {
                this.log(`lease lost for job ${job.id}`);
                this.engine.loseLease(job.conversation_id);
              }
            } catch (error) {
              this.log(`lease renewal failed: ${String(error)}`);
              this.engine.loseLease(job.conversation_id);
            }
          }, Math.floor(LEASE_MS / 3));
          renew.unref?.();
          const guard = {
            jobId: job.id,
            owner: this.owner,
            fence: job.fence,
          };
          const leaseValid = () =>
            this.storage.jobOwned(job.id, this.owner, job.fence);
          try {
            if (job.kind === "compact") {
              await this.engine.compact(
                job.conversation_id,
                undefined,
                leaseValid,
                guard,
              );
            } else {
              await this.engine.recoverConversation(
                job.conversation_id,
                leaseValid,
                guard,
              );
              await this.engine.run(job.conversation_id, leaseValid, guard);
            }
          } catch (error) {
            this.log(
              `run failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          } finally {
            clearInterval(renew);
            clearInterval(heartbeat);
            try {
              await this.storage.tx(async () => {
                await this.storage.finishRun(job.id, this.owner);
                if (
                  (
                    await this.storage.conversationIdsWithOpenWork()
                  ).includes(job.conversation_id)
                ) {
                  await this.storage.enqueueRun(job.conversation_id);
                }
              });
            } catch (error) {
              this.log(`job cleanup failed: ${String(error)}`);
            }
            await this.clearJobKeys();
          }
        } catch (error) {
          try {
            await this.storage.setSetting(
              "worker_error",
              error instanceof Error ? error.message : String(error),
            );
          } catch {
            /* storage unavailable; keep the loop alive */
          }
          this.log(`worker iteration failed: ${String(error)}`);
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    };

    this.loopPromise = loop();
    void this.loopPromise.catch((error) =>
      this.log(`worker stopped: ${String(error)}`),
    );
  }

  private async writeHeartbeat(): Promise<void> {
    const now = String(Date.now());
    try {
      // Aggregate keys are tenant-scoped by RLS; the per-owner key lets health
      // list every worker of this tenant.
      await this.storage.setSetting("worker_heartbeat", now);
      await this.storage.setSetting(this.heartbeatKey, now);
    } catch {
      /* storage unavailable */
    }
  }

  private async publishJob(job: QueueJob): Promise<void> {
    const value = JSON.stringify({
      id: job.id,
      conversationId: job.conversation_id,
      owner: this.owner,
      startedAt: Date.now(),
    });
    await this.storage.setSetting("worker_job", value);
    await this.storage.setSetting(this.jobKey, value);
  }

  private async clearJobKeys(): Promise<void> {
    try {
      await this.storage.setSetting(this.jobKey, "");
    } catch {
      /* storage unavailable */
    }
    try {
      const raw = await this.storage.getSetting("worker_job");
      if (!raw) return;
      let currentOwner: unknown;
      try {
        currentOwner = (JSON.parse(raw) as { owner?: unknown }).owner;
      } catch {
        currentOwner = undefined;
      }
      if (currentOwner === this.owner) {
        await this.storage.setSetting("worker_job", "");
      }
    } catch {
      /* storage unavailable */
    }
  }

  private async clearHeartbeat(): Promise<void> {
    try {
      await this.storage.setSetting(this.heartbeatKey, "");
    } catch {
      /* storage unavailable */
    }
    try {
      const remaining = await this.storage.settingsMatching("worker_heartbeat:");
      const now = Date.now();
      const anyAlive = remaining.some((pair) => {
        const timestamp = Number(pair.value);
        return timestamp > 0 && now - timestamp < WORKER_STALE_MS;
      });
      if (!anyAlive) await this.storage.setSetting("worker_heartbeat", "");
    } catch {
      /* storage unavailable */
    }
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.engine.abortAll();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.loopPromise?.catch(() => undefined) ?? Promise.resolve(),
        new Promise((resolve) => {
          deadline = setTimeout(resolve, 30_000);
        }),
      ]);
    } finally {
      if (deadline) clearTimeout(deadline);
    }
    await this.clearJobKeys();
    await this.clearHeartbeat();
    await this.engine.close();
    // Releases this tenant's shared-pool reference; other tenants keep the pool.
    await Promise.resolve(this.storage.close()).catch(() => undefined);
  }
}

export type SharedWorkerOptions = {
  log?: (line: string) => void;
  /** Per-tenant provider factory (tests) or a single provider for all tenants. */
  provider?: Provider | ((tenantId: string) => Provider);
  /** Tenant re-discovery interval; defaults to 60s. `0` disables the timer. */
  discoverIntervalMs?: number;
};

export type SharedWorkerHandle = {
  /** Tenants discovered at startup (workers may be added later). */
  readonly tenants: string[];
  /** Live tenant workers by tenant id. */
  readonly workers: Map<string, TenantWorker>;
  close(): Promise<void>;
};

const TENANT_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Phase 14: one OS process serves every tenant on a Postgres deployment.
 *
 * Startup discovers tenants with a bootstrap (schema-verifying) storage, then
 * creates one `TenantWorker` per tenant. Each worker owns its tenant-scoped
 * storage from the process-wide shared pool, its engine/provider/auth/push
 * notifier, its workspace (`RIBBHU_WORKSPACE/<tenant>`), and a claim loop that
 * can only see that tenant's jobs. The loops run concurrently, so a slow
 * tenant never blocks another; at most one job per tenant is active.
 */
export async function startSharedWorker(
  config: Config,
  options: SharedWorkerOptions = {},
): Promise<SharedWorkerHandle> {
  if (config.storage !== "postgres" || !config.postgresUrl) {
    throw new Error(
      "RIBBHU_SHARED_WORKER=1 requires RIBBHU_STORAGE=postgres and RIBBHU_POSTGRES_URL.",
    );
  }
  const log = options.log ?? ((line: string) => console.log(`  ${line}`));
  await mkdir(config.dataDir, { recursive: true });
  await mkdir(config.workspaceDir, { recursive: true });

  const bootstrap = createSharedPostgresStorage(
    config.postgresUrl,
    config.tenantId ?? "default",
    { max: config.postgresPoolMax },
  );
  await bootstrap.init();

  const workers = new Map<string, TenantWorker>();
  let tenants: string[] = [];
  let stopped = false;

  const ensureWorker = async (tenantId: string): Promise<void> => {
    if (stopped || workers.has(tenantId)) return;
    if (!TENANT_PATTERN.test(tenantId)) {
      log(`skipping invalid tenant id ${JSON.stringify(tenantId)}`);
      return;
    }
    const workspaceDir = join(config.workspaceDir, tenantId);
    const storage = createSharedPostgresStorage(config.postgresUrl!, tenantId, {
      max: config.postgresPoolMax,
    });
    try {
      await storage.init();
      const worker = await TenantWorker.open({
        config,
        tenantId,
        storage,
        workspaceDir,
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        log: (line) => log(`[${tenantId}] ${line}`),
      });
      workers.set(tenantId, worker);
      log(`tenant ${tenantId} worker started · workspace ${workspaceDir}`);
    } catch (error) {
      // A broken tenant must not take down the shared worker for everyone.
      await storage.close().catch(() => undefined);
      log(
        `tenant ${tenantId} worker failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const discover = async (): Promise<string[]> => {
    const found = await bootstrap.listTenants();
    tenants = found;
    for (const tenantId of found) await ensureWorker(tenantId);
    return found;
  };

  const discovered = await discover();
  log(
    `discovery ${discovered.length} tenant(s) on Postgres: ${
      discovered.join(", ") || "(none)"
    }`,
  );

  const interval =
    (options.discoverIntervalMs ?? SHARED_WORKER_DISCOVER_MS) > 0
      ? setInterval(() => {
          void discover().catch((error) =>
            log(
              `tenant discovery failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        }, options.discoverIntervalMs ?? SHARED_WORKER_DISCOVER_MS)
      : undefined;
  interval?.unref?.();

  return {
    get tenants(): string[] {
      return [...tenants];
    },
    workers,
    async close(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (interval) clearInterval(interval);
      const active = [...workers.values()];
      workers.clear();
      await Promise.allSettled(active.map((worker) => worker.close()));
      // The bootstrap storage holds one shared-pool reference; the pool ends
      // when the last tenant storage and this reference are released.
      await bootstrap.close().catch(() => undefined);
      log(`shared worker closed (${active.length} tenant worker(s))`);
    },
  };
}
