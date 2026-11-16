import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_RUN_TOKEN_BUDGET,
  admitSubmission,
  approvalArgsKey,
  reservationForRun,
  resolveModelPricing,
  seedConversation,
  type Awaitable,
  type ConversationSearchResult,
  type ConversationSummary,
  type ConversationView,
  type JsonObject,
  type ModelRef,
  type Storage,
  type SubmissionDraft,
  type SubmissionInfo,
} from "@ribhu-voyager/engine";
import type {
  ApprovalDecision,
  PushSubscription,
} from "@ribhu-voyager/protocol";
import { Db, serializedStorage } from "@ribhu-voyager/storage-sqlite";
import {
  PostgresStorage,
  createSharedPostgresStorage,
} from "@ribhu-voyager/storage-postgres";

import type { AuthInfo, AuthMode } from "./auth.js";
import type { Config } from "./config.js";
import { pushHostAllowlist, validatePushEndpoint } from "./push.js";

const VIEW_POLL_MS = 120;

function pushSettingKey(endpoint: string): string {
  return `push:${createHash("sha256").update(endpoint).digest("hex")}`;
}

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
   * Answer a pending `pi.approval` request. `always` also journals a
   * `pi.approval-rule` so the same call auto-approves next time. Resolves
   * `false` when there is no pending request for this call (stale, already
   * decided, or never asked).
   *
   * Legacy `boolean` callers are still normalized (true -> approve,
   * false -> deny), matching the engine's own compatibility window.
   */
  decideApproval(
    callId: string,
    decision: ApprovalDecision | boolean,
  ): Promise<boolean>;
};

export type GatewayAuth = {
  info(): Awaitable<AuthInfo>;
  setMode(mode: AuthMode): Promise<AuthInfo>;
};

export type GatewayRuntime = {
  /** Stable identity used by the gateway to scope per-runtime state. */
  readonly serverId?: string;
  conversation(id?: number): Promise<GatewayConversation | undefined>;
  auth?: GatewayAuth;
  storage?: {
    getSetting(key: string): Awaitable<string | undefined>;
    setSetting(key: string, value: string): Awaitable<void>;
  };
  /** Store or clear a Web Push subscription for this tenant/runtime. */
  setPushSubscription?(
    subscription: PushSubscription | null,
    endpoint?: string,
  ): Promise<void>;
  /**
   * Register an APNs/FCM device token for this tenant/runtime, or unregister a
   * platform's token(s) with `token: null`.
   */
  setPushDevice?(
    token: string | null,
    platform: "ios" | "android",
  ): Promise<void>;
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
  /** Tenant this runtime's storage is scoped to. */
  tenantId: string;
  model: ModelRef;
  storage: Storage;
  pushPublicKey?: string;
  authInfo(): Promise<AuthInfo | undefined>;
  close(): Promise<void>;
};

export async function createApiRuntime(
  config: Config,
  tenantId?: string,
): Promise<ApiRuntime> {
  await mkdir(config.dataDir, { recursive: true });
  const tenant = tenantId ?? config.tenantId ?? "default";
  // One shared pg.Pool per URL per process; tenant RLS is set per transaction.
  const storage: Storage =
    config.storage === "postgres" && config.postgresUrl
      ? createSharedPostgresStorage(config.postgresUrl, tenant, {
          max: config.postgresPoolMax,
        })
      : serializedStorage(new Db(join(config.dataDir, "ribhu.sqlite")));
  if (storage instanceof PostgresStorage) await storage.init();
  const rootId = await storage.ensureRoot();

  const model: ModelRef = config.demo
    ? { provider: "demo", modelId: "ribhu-demo" }
    : { provider: config.provider, modelId: config.model };

  // Per-run budget reserved atomically at admission (and enforced inside the
  // engine loop). Pricing is per-model with the flat env rate as fallback.
  const runPricing = resolveModelPricing(
    config.modelPricing,
    model.provider,
    model.modelId,
    config.costMicrosPer1kTokens,
  );
  const runReservation = reservationForRun(
    {
      tokenBudget: config.runTokenBudget ?? DEFAULT_RUN_TOKEN_BUDGET,
      costBudgetMicros: config.runCostMicros ?? 0,
    },
    runPricing,
  );

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
        return admitSubmission(storage, conversationId, draft, {
          reservation: runReservation,
        });
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
      async decideApproval(callId, decision) {
        // The API process has no Engine instance: the worker owns the run loop
        // and polls the journal. Append the same journal entries as
        // Engine.decideApproval, but only when the newest `pi.approval` entry
        // for this call is still pending. Like the engine, widen the scan window
        // so a long transcript cannot hide the pending request.
        const normalized: ApprovalDecision =
          decision === true ? "approve" : decision === false ? "deny" : decision;
        return storage.tx(async () => {
          let limit = 200;
          let pending:
            | { status: unknown; name: unknown; args: unknown }
            | undefined;
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
              const approval = data as {
                callId?: unknown;
                status?: unknown;
                name?: unknown;
                args?: unknown;
              };
              if (approval.callId !== callId) continue;
              pending = {
                status: approval.status,
                name: approval.name,
                args: approval.args,
              };
              break;
            }
            if (pending || entries.length < limit) break;
            limit *= 2;
          }
          if (pending?.status !== "pending") return false;

          const approved = normalized !== "deny";
          const always = normalized === "always";
          const ruleName = pending.name;
          const ruleArgs = pending.args;
          const canWriteRule =
            typeof ruleName === "string" &&
            ruleName !== "" &&
            typeof ruleArgs === "object" &&
            ruleArgs !== null &&
            !Array.isArray(ruleArgs);
          const decidedAt = Date.now();
          if (always && !canWriteRule) {
            // Defensive parity with Engine.decideApproval: if the pending
            // request lost its metadata, approve once instead of losing the
            // call (the rule cannot be keyed).
            await storage.appendEntry({
              conversationId,
              kind: "pi.approval",
              data: { callId, status: "approved", decidedAt },
            });
            await storage.recordAudit({
              actor: "user",
              action: "approval.approved",
              target: `${conversationId}:${callId}`,
              data: { conversationId, callId, always: true, fallback: true },
            });
            return true;
          }
          await storage.appendEntry({
            conversationId,
            kind: "pi.approval",
            data: {
              callId,
              status: approved ? "approved" : "denied",
              decidedAt,
              ...(always ? { always: true } : {}),
            },
          });
          await storage.recordAudit({
            actor: "user",
            action: always
              ? "approval.always"
              : approved
                ? "approval.approved"
                : "approval.denied",
            target: `${conversationId}:${callId}`,
            data: {
              conversationId,
              callId,
              ...(canWriteRule && typeof ruleName === "string"
                ? { tool: ruleName }
                : {}),
            },
          });
          if (always) {
            await storage.appendEntry({
              conversationId,
              kind: "pi.approval-rule",
              data: {
                name: ruleName as string,
                argsKey: approvalArgsKey(ruleArgs as JsonObject),
                args: ruleArgs as JsonObject,
                createdAt: decidedAt,
              },
            });
          }
          return true;
        });
      },
    };
  };

  return {
    serverId: randomUUID(),
    startedAt: Date.now(),
    demo: config.demo,
    tenantId: tenant,
    model,
    storage,
    ...(config.vapidPublicKey ? { pushPublicKey: config.vapidPublicKey } : {}),
    async setPushDevice(token, platform) {
      if (platform !== "ios" && platform !== "android") {
        throw new Error("invalid device platform");
      }
      if (token === null) {
        // Device-token unregister: clear every stored token for the platform.
        const entries = await storage.settingsMatching("device:");
        for (const entry of entries) {
          if (entry.value === "") continue;
          try {
            const parsed = JSON.parse(entry.value) as { platform?: unknown };
            if (parsed.platform === platform) {
              await storage.setSetting(entry.key, "");
            }
          } catch {
            /* unreadable entry; leave it */
          }
        }
        return;
      }
      if (typeof token !== "string" || token.length < 16) {
        throw new Error("invalid device token");
      }
      const key = `device:${createHash("sha256").update(token).digest("hex")}`;
      await storage.setSetting(
        key,
        JSON.stringify({ token, platform, createdAt: Date.now() }),
      );
    },
    async setPushSubscription(subscription, endpoint) {
      if (subscription === null) {
        if (endpoint) {
          await storage.setSetting(pushSettingKey(endpoint), "");
        }
        return;
      }
      if (
        typeof subscription.endpoint !== "string" ||
        typeof subscription.keys?.p256dh !== "string" ||
        subscription.keys.p256dh === "" ||
        typeof subscription.keys?.auth !== "string" ||
        subscription.keys.auth === ""
      ) {
        throw new Error("invalid push subscription");
      }
      const problem = validatePushEndpoint(
        subscription.endpoint,
        pushHostAllowlist(config),
      );
      if (problem !== null) throw new Error(problem);
      await storage.setSetting(
        pushSettingKey(subscription.endpoint),
        JSON.stringify({ ...subscription, createdAt: Date.now() }),
      );
    },
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
              await storage.recordAudit({
                actor: "user",
                action: "auth.mode_changed",
                target: "auth",
                data: { mode },
              });
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
