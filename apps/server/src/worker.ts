import { hostname } from "node:os";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  Engine,
  type Conversation,
  type ModelRef,
  type Provider,
  type Storage,
} from "@ribhu-voyager/engine";
import { createProvider } from "@ribhu-voyager/providers";
import { Db, serializedStorage } from "@ribhu-voyager/storage-sqlite";
import { PostgresStorage } from "@ribhu-voyager/storage-postgres";

import { AuthManager } from "./auth.js";
import { PiAuthStore, defaultAuthFile } from "./auth-store.js";
import { ClaudeCodeAuthStore } from "./claude-code-auth.js";
import type { Config } from "./config.js";
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
    autoRun: false,
    recoverOnOpen: false,
    log: (line) => log(`engine    ${line}`),
  });

  const root = await engine.root();
  await storage.setSetting("worker_job", "");
  const owner = `${hostname()}:${process.pid}`;
  let stopped = false;
  let current: Promise<void> | null = null;

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
        await storage.setSetting("worker_heartbeat", String(Date.now()));
        const job = await storage.claimRun(owner, LEASE_MS);
        if (!job) {
          await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
          continue;
        }
        log(`job ${job.id} conversation ${job.conversation_id}`);
        await storage.setSetting(
          "worker_job",
          JSON.stringify({
            id: job.id,
            conversationId: job.conversation_id,
            owner,
            startedAt: Date.now(),
          }),
        );
        const heartbeat = setInterval(() => {
          void (async () => {
            try {
              await storage.setSetting("worker_heartbeat", String(Date.now()));
            } catch {
              /* storage unavailable */
            }
          })();
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
        try {
          if (job.kind === "compact") {
            await engine.compact(job.conversation_id, undefined, () =>
              storage.jobOwned(job.id, owner, job.fence),
            );
          } else {
            await engine.recoverConversation(job.conversation_id, () =>
              storage.jobOwned(job.id, owner, job.fence),
            );
            await engine.run(job.conversation_id, () =>
              storage.jobOwned(job.id, owner, job.fence),
            );
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
            await storage.setSetting("worker_job", "");
          } catch (error) {
            log(`job cleanup failed: ${String(error)}`);
          }
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
      try {
        await storage.setSetting("worker_job", "");
      } catch {
        /* storage unavailable during shutdown */
      }
      await engine.close();
    },
  };
}
