import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  admitSubmission,
  seedConversation,
  type Awaitable,
  type ConversationSearchResult,
  type ConversationSummary,
  type ConversationView,
  type ModelRef,
  type Storage,
  type SubmissionDraft,
  type SubmissionInfo,
} from "@ribhu-voyager/engine";
import { Db, serializedStorage } from "@ribhu-voyager/storage-sqlite";
import { PostgresStorage } from "@ribhu-voyager/storage-postgres";

import type { AuthInfo, AuthMode } from "./auth.js";
import type { Config } from "./config.js";

const VIEW_POLL_MS = 120;

export type GatewayConversation = {
  id: number;
  view(): Promise<ConversationView>;
  watch(
    listener: (view: ConversationView, cursor: number) => void,
  ): (() => void) | Promise<() => void>;
  submit(draft: SubmissionDraft): Promise<SubmissionInfo>;
  abort(): Promise<void>;
  compact(): Promise<unknown>;
  /**
   * Answer a pending `pi.approval` request. Resolves `false` when there is no
   * pending request for this call (stale, already decided, or never asked).
   */
  decideApproval(callId: string, approved: boolean): Promise<boolean>;
};

export type GatewayAuth = {
  info(): Awaitable<AuthInfo>;
  setMode(mode: AuthMode): Promise<AuthInfo>;
};

export type GatewayRuntime = {
  conversation(id?: number): Promise<GatewayConversation | undefined>;
  auth?: GatewayAuth;
  storage?: { getSetting(key: string): Awaitable<string | undefined> };
  authInfo?(): Awaitable<AuthInfo | undefined>;
  listConversations?(
    includeArchived?: boolean,
  ): Awaitable<ConversationSummary[]>;
  searchConversations?(
    query: string,
    limit?: number,
  ): Awaitable<ConversationSearchResult[]>;
  archiveConversation?(id: number, archived: boolean): Awaitable<void>;
  createConversation?(title?: string): Promise<number>;
  forkConversation?(parentId: number, atEntryId?: number): Promise<number>;
  renameConversation?(id: number, title: string): Awaitable<void>;
};

export type ApiRuntime = GatewayRuntime & {
  serverId: string;
  startedAt: number;
  demo: boolean;
  model: ModelRef;
  storage: Storage;
  authInfo(): Promise<AuthInfo | undefined>;
  close(): Promise<void>;
};

export async function createApiRuntime(config: Config): Promise<ApiRuntime> {
  await mkdir(config.dataDir, { recursive: true });
  const storage: Storage =
    config.storage === "postgres" && config.postgresUrl
      ? new PostgresStorage(config.postgresUrl, config.tenantId ?? "default")
      : serializedStorage(new Db(join(config.dataDir, "ribhu.sqlite")));
  if (storage instanceof PostgresStorage) await storage.init();
  const rootId = await storage.ensureRoot();

  const model: ModelRef = config.demo
    ? { provider: "demo", modelId: "ribhu-demo" }
    : { provider: config.provider, modelId: config.model };

  const fallbackAuth = (): AuthInfo => ({
    mode: config.authMode === "api-key" ? "api-key" : "subscription",
    ...(config.authSource === "pi" ? { source: "pi" as const } : {}),
    label:
      config.authMode === "api-key"
        ? config.anthropicApiKey
          ? "API key (credits)"
          : "API key missing"
        : "Claude Code (subscription)",
    subscriptionAvailable: true,
    apiKeyAvailable: Boolean(config.anthropicApiKey),
    detail:
      config.authMode === "api-key"
        ? config.anthropicApiKey
          ? "Uses Anthropic API credits/promotional balance."
          : "Set ANTHROPIC_API_KEY or RIBBHU_ANTHROPIC_API_KEY."
        : "Uses your Claude plan through an OAuth login.",
  });

  const readAuth = async (): Promise<AuthInfo> => {
    const raw = await storage.getSetting("auth_info");
    let info = fallbackAuth();
    if (raw) {
      try {
        info = JSON.parse(raw) as AuthInfo;
      } catch {
        /* fall back to env */
      }
    }
    const requested = await storage.getSetting("auth_mode");
    return requested === "subscription" || requested === "api-key"
      ? { ...info, mode: requested }
      : info;
  };

  const conversation = async (
    id?: number,
  ): Promise<GatewayConversation | undefined> => {
    const conversationId = id ?? rootId;
    if (!(await storage.conversationExists(conversationId))) return undefined;
    return {
      id: conversationId,
      async view() {
        return storage.view(conversationId);
      },
      watch(listener) {
        let last = -1;
        const timer = setInterval(() => {
          void (async () => {
            try {
              const version = await storage.version(conversationId);
              if (version === last) return;
              last = version;
              listener(await storage.view(conversationId), version);
            } catch {
              /* storage closing */
            }
          })();
        }, VIEW_POLL_MS);
        timer.unref?.();
        void (async () => {
          try {
            last = await storage.version(conversationId);
          } catch {
            /* storage closing */
          }
        })();
        return () => clearInterval(timer);
      },
      async submit(draft) {
        return admitSubmission(storage, conversationId, draft);
      },
      async abort() {
        await storage.requestCancel(conversationId);
        const queued = (await storage.queuedSubmissions(conversationId)).filter(
          (row) => row.status === "queued",
        );
        await storage.settleSubmissionIds(
          queued.map((row) => row.id),
          "aborted",
        );
      },
      async compact() {
        await storage.enqueueCompact(conversationId);
      },
      async decideApproval(callId, approved) {
        // The API process has no Engine instance: the worker owns the run loop
        // and polls the journal. Append the decision entry exactly like
        // Engine.decideApproval does, but only when the newest `pi.approval`
        // entry for this call is still pending. Like the engine, widen the
        // scan window so a long transcript cannot hide the pending request.
        return storage.tx(async () => {
          let limit = 200;
          let status: unknown;
          let found = false;
          for (;;) {
            const { entries } = await storage.entries(conversationId, limit);
            for (let index = entries.length - 1; index >= 0; index -= 1) {
              const entry = entries[index]!;
              if (entry.kind !== "pi.approval") continue;
              const data = entry.data;
              if (
                typeof data !== "object" ||
                data === null ||
                Array.isArray(data)
              ) {
                continue;
              }
              const approval = data as { callId?: unknown; status?: unknown };
              if (approval.callId !== callId) continue;
              status = approval.status;
              found = true;
              break;
            }
            if (found || entries.length < limit) break;
            limit *= 2;
          }
          if (!found || status !== "pending") return false;
          await storage.appendEntry({
            conversationId,
            kind: "pi.approval",
            data: {
              callId,
              status: approved ? "approved" : "denied",
              decidedAt: Date.now(),
            },
          });
          return true;
        });
      },
    };
  };

  return {
    serverId: randomUUID(),
    startedAt: Date.now(),
    demo: config.demo,
    model,
    storage,
    conversation,
    async listConversations(includeArchived = false) {
      return storage.listConversations(includeArchived);
    },
    async searchConversations(query: string, limit?: number) {
      return storage.searchConversations(query, limit);
    },
    async archiveConversation(id: number, archived: boolean) {
      await storage.archiveConversation(id, archived);
    },
    async createConversation(title?: string) {
      const id = await storage.createConversation(title);
      await seedConversation(storage, id, model);
      return id;
    },
    async forkConversation(parentId: number, atEntryId?: number) {
      const id = await storage.forkConversation(parentId, atEntryId);
      await seedConversation(storage, id, model);
      return id;
    },
    async renameConversation(id: number, title: string) {
      await storage.renameConversation(id, title);
    },
    ...(config.provider === "anthropic"
      ? {
          auth: {
            info: readAuth,
            async setMode(mode: AuthMode) {
              await storage.setSetting("auth_mode", mode);
              await storage.setSetting("auth_error", "");
              return { ...(await readAuth()), mode };
            },
          } satisfies GatewayAuth,
        }
      : {}),
    async authInfo() {
      return config.provider === "anthropic" ? readAuth() : undefined;
    },
    async close() {
      await storage.close();
    },
  };
}
