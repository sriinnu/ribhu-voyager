import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import type { ConversationView } from "@ribhu-voyager/engine";
import { ConversationBusy, ConversationIdle } from "@ribhu-voyager/engine";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ConversationSummary,
  type ConversationSearchResult,
  type ServerInfo,
  type ServerMessage,
  type WireOp,
  type WireView,
} from "@ribhu-voyager/protocol";
import { WebSocket, WebSocketServer } from "ws";

import type { GatewayRuntime } from "./api-runtime.js";

const HEARTBEAT_MS = 30_000;
const MAX_CONTENT = 100_000;
const AUTH_POLL_MS = 500;

type Client = {
  socket: WebSocket;
  /** Runtime selected by the connection token; every handler uses this one. */
  runtime: GatewayRuntime;
  alive: boolean;
  conversationId?: number;
  /** Rate-limit key material captured at upgrade time. */
  ip?: string;
  token?: string;
  /** True once a runtime lifecycle hook owns this connection. */
  hooked?: boolean;
};

type Live = {
  /** `${runtimeId}:${conversationId}` — never shared across runtimes. */
  key: string;
  conversationId: number;
  cursor: number;
  view: ConversationView;
  unsubscribe: () => void;
  clients: Set<Client>;
};

export type Gateway = {
  close(): Promise<void>;
};

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function candidateToken(request: IncomingMessage, url: URL): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length);
  }
  return url.searchParams.get("token") ?? undefined;
}

export type GatewayWindow = { min: number; max: number };

export type RateLimitOptions = {
  /** Requests allowed per key inside the window; 0 disables the limiter. */
  limit: number;
  windowMs?: number;
};

export type RateLimitResult = {
  allowed: boolean;
  retryAfterMs: number;
};

/**
 * R8: small fixed-window limiter keyed by IP or token. Exported so the HTTP
 * (health) path in index.ts uses the same budget semantics as the gateway.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(options: RateLimitOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs ?? 60_000;
  }

  get disabled(): boolean {
    return this.limit <= 0;
  }

  take(key: string, now = Date.now()): RateLimitResult {
    if (this.disabled) return { allowed: true, retryAfterMs: 0 };
    if (this.hits.size > 10_000) this.prune(now);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (entry.count >= this.limit) {
      return { allowed: false, retryAfterMs: Math.max(1, entry.resetAt - now) };
    }
    entry.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  private prune(now: number): void {
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }
}

export function createRateLimiter(
  options: RateLimitOptions | false | undefined,
  fallback: RateLimitOptions = { limit: 120, windowMs: 60_000 },
): RateLimiter | undefined {
  if (options === false) return undefined;
  const resolved = options ?? fallback;
  return resolved.limit <= 0 ? undefined : new RateLimiter(resolved);
}

const LOOPBACK_ORIGIN_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * R1: a browser WebSocket always sends Origin. Accept same-origin upgrades
 * (Origin host === Host), plus explicit allowlist entries for native shells and
 * tunnels. Missing Origin is allowed but still requires a token.
 */
export function originAllowed(
  request: IncomingMessage,
  allowedOrigins: readonly string[] = [],
): boolean {
  const raw = request.headers.origin;
  if (typeof raw !== "string" || raw === "") return true; // non-browser client
  if (allowedOrigins.includes(raw)) return true;
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    return false;
  }
  if (allowedOrigins.includes(origin.origin)) return true;
  // Same-origin check: compare against the Host the client actually reached.
  // Reverse proxies commonly rewrite Host; also accept their X-Forwarded-Host
  // (a browser cannot forge it, and non-browser clients still need a token).
  const forwarded = request.headers["x-forwarded-host"];
  const forwardedHost =
    typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined;
  const hosts = [request.headers.host, forwardedHost].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate !== "",
  );
  if (
    LOOPBACK_ORIGIN_PROTOCOLS.has(origin.protocol) &&
    hosts.includes(origin.host)
  ) {
    return true;
  }
  const hostname = origin.hostname.toLowerCase();
  return allowedOrigins.some((entry) => {
    const normalized = entry.toLowerCase().replace(/\/+$/, "");
    return normalized === hostname || normalized === origin.host;
  });
}

function remoteKey(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

function writeUpgradeError(
  socket: Duplex,
  status: string,
  headers: string,
): void {
  socket.write(`HTTP/1.1 ${status}\r\n${headers}Connection: close\r\n\r\n`);
  socket.destroy();
}

export type GatewayOptions = {
  /** Legacy per-token check used by the default single-runtime resolver. */
  authorizeToken?: (candidate: string) => Promise<boolean>;
  /**
   * Resolve the connecting token to its tenant runtime (multi-tenant pool).
   * Returning `undefined` rejects the upgrade with 401. When omitted, the
   * positional runtime is used after the legacy shared-token / authorizeToken
   * check (the default resolver).
   */
  resolveRuntime?: (
    token: string | undefined,
  ) => Promise<GatewayRuntime | undefined>;
  /** Wire identity for each runtime's `welcome`. Defaults to the positional info. */
  infoFor?: (runtime: GatewayRuntime) => ServerInfo;
  /**
   * R1: allow token-less upgrades when no token is configured. Defaults to
   * `token === ""` for backward compatibility; production passes config.allowAnon.
   */
  allowAnonymous?: boolean;
  /** R1: explicit allowed origins (native shells, tunnels) besides same-origin. */
  allowedOrigins?: string[];
  /** R8: per-IP upgrade + per-token submit rate limit; `false` disables. */
  rateLimit?: RateLimitOptions | false;
  /**
   * R6: called once per WebSocket connection when its tenant runtime is
   * reserved (the upgrade token resolved). If the handshake then fails, the
   * matching `onRuntimeDisconnect` runs immediately so pool counts never leak.
   * Index wires this to `RuntimePool.acquire`.
   */
  onRuntimeConnect?: (
    runtime: GatewayRuntime,
    token?: string,
  ) => void | Promise<void>;
  /**
   * R6: called exactly once when the connection ends (close, error,
   * terminate, failed upgrade, or server shutdown). Index wires this to
   * `RuntimePool.release`.
   */
  onRuntimeDisconnect?: (runtime: GatewayRuntime) => void | Promise<void>;
};

function logHookError(message: string, error: unknown): void {
  console.error(message, error);
}

export function attachGateway(
  server: HttpServer,
  runtime: GatewayRuntime | undefined,
  info: ServerInfo | undefined,
  token: string,
  window: GatewayWindow = { min: 50, max: 100 },
  options: GatewayOptions = {},
): Gateway {
  void window;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1_048_576,
  });
  const clients = new Set<Client>();
  const lives = new Map<string, Live>();
  const pending = new Map<string, Promise<Live>>();
  const runtimeKeys = new WeakMap<GatewayRuntime, string>();
  const authRevisions = new WeakMap<GatewayRuntime, string>();
  let runtimeSerial = 0;

  /** Stable per-runtime identity; `serverId` plus a process-local suffix. */
  const runtimeKey = (target: GatewayRuntime): string => {
    const known = runtimeKeys.get(target);
    if (known) return known;
    const key = `${target.serverId ?? "runtime"}#${++runtimeSerial}`;
    runtimeKeys.set(target, key);
    return key;
  };

  const liveKey = (target: GatewayRuntime, conversationId: number): string =>
    `${runtimeKey(target)}:${conversationId}`;

  const sameRuntime = (a: GatewayRuntime, b: GatewayRuntime): boolean =>
    a === b || (a.serverId !== undefined && a.serverId === b.serverId);

  const defaultInfo = info;
  const infoFor =
    options.infoFor ??
    ((target: GatewayRuntime): ServerInfo => {
      void target;
      if (!defaultInfo) {
        throw new Error(
          "attachGateway requires infoFor when no default ServerInfo is passed.",
        );
      }
      return defaultInfo;
    });

  const allowAnonymous = options.allowAnonymous ?? token === "";
  const rateLimiter = createRateLimiter(options.rateLimit);
  const allowedOrigins = options.allowedOrigins ?? [];

  const defaultRuntime = runtime;
  const resolveRuntime =
    options.resolveRuntime ??
    (async (
      candidate: string | undefined,
    ): Promise<GatewayRuntime | undefined> => {
      if (!defaultRuntime) return undefined;
      if (options.authorizeToken) {
        if (candidate === undefined) return undefined;
        return (await options.authorizeToken(candidate))
          ? defaultRuntime
          : undefined;
      }
      if (token === "") {
        // No configured token: only an explicit anonymous opt-out may proceed.
        return allowAnonymous ? defaultRuntime : undefined;
      }
      if (candidate === undefined) return undefined;
      return safeEqual(candidate, token) ? defaultRuntime : undefined;
    });

  if (!options.resolveRuntime && (!defaultRuntime || !defaultInfo)) {
    throw new Error(
      "attachGateway needs a runtime and ServerInfo (or a resolveRuntime/infoFor pair).",
    );
  }

  // R6: a lifecycle hook pair must be balanced, or active-client counts leak.
  if (
    (options.onRuntimeConnect === undefined) !==
    (options.onRuntimeDisconnect === undefined)
  ) {
    throw new Error(
      "attachGateway requires both onRuntimeConnect and onRuntimeDisconnect, or neither.",
    );
  }

  const broadcast = (live: Live, message: ServerMessage) => {
    const payload = JSON.stringify(message);
    for (const client of live.clients) {
      if (client.socket.readyState === WebSocket.OPEN) client.socket.send(payload);
    }
  };

  const ensureLive = (
    target: GatewayRuntime,
    conversationId: number,
  ): Promise<Live> => {
    const key = liveKey(target, conversationId);
    const existing = lives.get(key);
    if (existing) return Promise.resolve(existing);

    const inflight = pending.get(key);
    if (inflight) return inflight;

    const created = (async (): Promise<Live> => {
      const conversation = await target.conversation(conversationId);
      if (!conversation) throw new Error(`unknown conversation ${conversationId}`);

      const initial = await conversation.view();
      const live: Live = {
        key,
        conversationId,
        cursor: 0,
        view: initial,
        unsubscribe: () => undefined,
        clients: new Set(),
      };

      live.unsubscribe = await conversation.watch((view, cursor) => {
        live.view = view;
        live.cursor = cursor;
        broadcast(live, {
          t: "view",
          conversationId,
          cursor,
          view: view as unknown as WireView,
        });
      });

      lives.set(key, live);
      return live;
    })();

    pending.set(key, created);
    void created
      .catch(() => undefined)
      .finally(() => pending.delete(key));
    return created;
  };

  const conversationList = async (
    target: GatewayRuntime,
    includeArchived = false,
  ): Promise<ConversationSummary[]> =>
    (await target.listConversations?.(includeArchived)) ?? [];

  const sendConversations = async (
    target: GatewayRuntime,
    socket: WebSocket,
  ): Promise<void> => {
    const all = await conversationList(target, true);
    send(socket, {
      t: "conversations",
      items: all.filter((item) => item.archivedAt === undefined),
      archived: all.filter((item) => item.archivedAt !== undefined),
    });
  };

  const broadcastConversations = async (
    target: GatewayRuntime,
  ): Promise<void> => {
    const all = await conversationList(target, true);
    const payload = JSON.stringify({
      t: "conversations",
      items: all.filter((item) => item.archivedAt === undefined),
      archived: all.filter((item) => item.archivedAt !== undefined),
    } satisfies ServerMessage);
    for (const client of clients) {
      if (!sameRuntime(client.runtime, target)) continue;
      if (client.socket.readyState === WebSocket.OPEN) client.socket.send(payload);
    }
  };

  const join = async (
    client: Client,
    conversationId?: number,
  ): Promise<boolean> => {
    const target = client.runtime;
    const conversation = await target.conversation(conversationId);
    if (!conversation) return false;
    detach(client);
    const live = await ensureLive(target, conversation.id);
    live.view = await conversation.view();
    live.clients.add(client);
    client.conversationId = conversation.id;
    const auth = target.auth ? await target.auth.info() : undefined;
    send(client.socket, {
      t: "welcome",
      v: PROTOCOL_VERSION,
      info: {
        ...infoFor(target),
        ...(auth ? { auth } : {}),
      },
      conversationId: conversation.id,
      cursor: live.cursor,
      view: live.view as unknown as WireView,
    });
    await sendConversations(target, client.socket);
    return true;
  };

  const snapshot = (
    live: Live,
    reason: "gap" | "request" | "reconnect",
  ): ServerMessage => ({
    t: "snapshot",
    conversationId: live.conversationId,
    cursor: live.cursor,
    view: live.view as unknown as WireView,
    reason,
  });

  const detach = (client: Client) => {
    if (!client.conversationId) return;
    const key = liveKey(client.runtime, client.conversationId);
    const live = lives.get(key);
    if (live) {
      live.clients.delete(client);
      if (live.clients.size === 0) {
        live.unsubscribe();
        lives.delete(key);
      }
    }
    client.conversationId = undefined;
  };

  const handle = async (client: Client, message: ClientMessage) => {
    const socket = client.socket;
    const runtime = client.runtime;

    switch (message.t) {
      case "hello": {
        if (message.v !== PROTOCOL_VERSION) {
          send(socket, {
            t: "error",
            code: "bad_version",
            message: `Protocol ${message.v} is not supported; expected ${PROTOCOL_VERSION}.`,
            fatal: true,
          });
          socket.close(4400, "bad protocol version");
          return;
        }

        if (!(await join(client, message.conversationId))) {
          send(socket, {
            t: "error",
            code: "unknown_conversation",
            message: "That conversation does not exist.",
          });
        }
        return;
      }

      case "create": {
        if (!runtime.createConversation) {
          send(socket, {
            t: "error",
            code: "server_error",
            message: "Conversation creation is not available.",
          });
          return;
        }
        const id = await runtime.createConversation(
          typeof message.title === "string" ? message.title : undefined,
        );
        if (!(await join(client, id))) {
          send(socket, {
            t: "error",
            code: "server_error",
            message: "Could not open the new conversation.",
          });
          return;
        }
        await broadcastConversations(runtime);
        return;
      }

      case "fork": {
        if (!runtime.forkConversation) {
          send(socket, {
            t: "error",
            code: "server_error",
            message: "Forking is not available.",
          });
          return;
        }
        // The parent must belong to this client's runtime (tenant).
        const parent = await runtime.conversation(message.conversationId);
        if (!parent) {
          send(socket, {
            t: "error",
            code: "unknown_conversation",
            message: "That conversation does not exist.",
          });
          return;
        }
        const id = await runtime.forkConversation(
          message.conversationId,
          message.atEntryId,
        );
        if (!(await join(client, id))) {
          send(socket, {
            t: "error",
            code: "server_error",
            message: "Could not open the fork.",
          });
          return;
        }
        await broadcastConversations(runtime);
        return;
      }

      case "compact": {
        if (!client.conversationId) {
          send(socket, {
            t: "error",
            code: "bad_request",
            message: "Send hello first.",
          });
          return;
        }
        const conversation = await runtime.conversation(client.conversationId);
        if (!conversation) {
          send(socket, {
            t: "error",
            code: "unknown_conversation",
            message: "That conversation does not exist.",
          });
          return;
        }
        await conversation.compact();
        return;
      }

      case "push-device": {
        const runtime = client.runtime;
        if (!runtime.setPushDevice) {
          send(socket, {
            t: "error",
            code: "bad_request",
            message: "Native push is not enabled on this server.",
          });
          return;
        }
        if (
          typeof message.token !== "string" ||
          (message.token !== "" && message.token.length < 16) ||
          (message.platform !== "ios" && message.platform !== "android")
        ) {
          send(socket, {
            t: "error",
            code: "bad_request",
            message: "Invalid device token or platform.",
          });
          return;
        }
        try {
          // An empty token is the unregister signal for that platform.
          await runtime.setPushDevice(
            message.token === "" ? null : message.token,
            message.platform,
          );
        } catch (error) {
          send(socket, {
            t: "error",
            code: "bad_request",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      case "push": {
        const runtime = client.runtime;
        if (!runtime.setPushSubscription) {
          send(socket, {
            t: "error",
            code: "bad_request",
            message: "Push is not enabled on this server.",
          });
          return;
        }
        try {
          if (message.subscription === null) {
            if (typeof message.endpoint !== "string" || message.endpoint === "") {
              send(socket, {
                t: "error",
                code: "bad_request",
                message: "endpoint is required to unsubscribe.",
              });
              return;
            }
            await runtime.setPushSubscription(null, message.endpoint);
            return;
          }
          if (
            typeof message.subscription !== "object" ||
            typeof message.subscription.endpoint !== "string" ||
            typeof message.subscription.keys?.p256dh !== "string" ||
            typeof message.subscription.keys?.auth !== "string"
          ) {
            send(socket, {
              t: "error",
              code: "bad_request",
              message: "Invalid push subscription.",
            });
            return;
          }
          await runtime.setPushSubscription(message.subscription);
        } catch (error) {
          send(socket, {
            t: "error",
            code: "bad_request",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      case "approval": {
        if (!client.conversationId) {
          send(socket, {
            t: "error",
            code: "bad_request",
            message: "Send hello first.",
          });
          return;
        }
        if (
          message.conversationId !== undefined &&
          message.conversationId !== client.conversationId
        ) {
          send(socket, {
            t: "error",
            code: "bad_request",
            message: "conversationId does not match the attached conversation.",
          });
          return;
        }
        if (
          typeof message.callId !== "string" ||
          message.callId.trim() === ""
        ) {
          send(socket, {
            t: "error",
            code: "bad_request",
            message: "callId must be a non-empty string.",
          });
          return;
        }
        if (
          message.decision !== "approve" &&
          message.decision !== "deny" &&
          message.decision !== "always"
        ) {
          send(socket, {
            t: "error",
            code: "bad_request",
            message: "decision must be approve, deny, or always.",
          });
          return;
        }
        const conversation = await runtime.conversation(client.conversationId);
        if (!conversation) {
          send(socket, {
            t: "error",
            code: "unknown_conversation",
            message: "That conversation does not exist.",
          });
          return;
        }
        try {
          const decided = await conversation.decideApproval(
            message.callId,
            message.decision,
          );
          if (!decided) {
            send(socket, {
              t: "error",
              code: "not_found",
              message: "There is no pending approval for that call.",
            });
          }
        } catch (error) {
          send(socket, {
            t: "error",
            code: "server_error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      case "rename": {
        if (!runtime.renameConversation) {
          send(socket, {
            t: "error",
            code: "server_error",
            message: "Renaming is not available.",
          });
          return;
        }
        if (
          typeof message.title !== "string" ||
          message.title.trim() === "" ||
          message.title.length > 120
        ) {
          send(socket, {
            t: "error",
            code: "bad_request",
            message: "title must be 1–120 characters.",
          });
          return;
        }
        const conversation = await runtime.conversation(message.conversationId);
        if (!conversation) {
          send(socket, {
            t: "error",
            code: "unknown_conversation",
            message: "That conversation does not exist.",
          });
          return;
        }
        await runtime.renameConversation(message.conversationId, message.title);
        await broadcastConversations(runtime);
        return;
      }

      case "submit": {
        if (!client.conversationId) {
          send(socket, { t: "error", code: "bad_request", message: "Send hello first." });
          return;
        }
        if (
          typeof message.content !== "string" ||
          message.content.trim() === "" ||
          message.content.length > MAX_CONTENT
        ) {
          send(socket, {
            t: "error",
            requestId: message.requestId,
            code: "bad_request",
            message: "content must be a non-empty string under 100,000 characters.",
          });
          return;
        }
        if (typeof message.requestId !== "string" || message.requestId.length === 0) {
          send(socket, {
            t: "error",
            code: "bad_request",
            message: "requestId is required.",
          });
          return;
        }

        const submitLimit = rateLimiter?.take(
          `submit:${client.token ?? client.ip ?? "unknown"}`,
        );
        if (submitLimit && !submitLimit.allowed) {
          send(socket, {
            t: "error",
            requestId: message.requestId,
            code: "server_error",
            message: `Rate limit exceeded — retry in ${Math.ceil(submitLimit.retryAfterMs / 1000)}s.`,
          });
          return;
        }

        const conversation = await runtime.conversation(client.conversationId);
        if (!conversation) {
          send(socket, {
            t: "error",
            requestId: message.requestId,
            code: "unknown_conversation",
            message: "That conversation does not exist.",
          });
          return;
        }

        try {
          const submission = await conversation.submit({
            type: "input",
            content: message.content,
            requestId: message.requestId,
            whenBusy: message.whenBusy ?? "steer",
          });
          send(socket, {
            t: "ack",
            requestId: message.requestId,
            submissionId: submission.id,
          });
        } catch (error) {
          if (error instanceof ConversationBusy) {
            send(socket, {
              t: "error",
              requestId: message.requestId,
              code: "busy",
              message: "The conversation is busy.",
            });
            return;
          }
          if (error instanceof ConversationIdle) {
            send(socket, {
              t: "error",
              requestId: message.requestId,
              code: "idle",
              message: "The conversation is idle.",
            });
            return;
          }
          send(socket, {
            t: "error",
            requestId: message.requestId,
            code: "server_error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      case "abort": {
        if (!client.conversationId) return;
        const conversation = await runtime.conversation(client.conversationId);
        if (!conversation) return;
        try {
          await conversation.abort();
        } catch (error) {
          send(socket, {
            t: "error",
            code: "server_error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      case "resync": {
        // Resolved against the client's own runtime: a foreign tenant id is
        // simply an unknown conversation here.
        const conversation = await runtime.conversation(message.conversationId);
        if (!conversation) {
          send(socket, {
            t: "error",
            code: "unknown_conversation",
            message: "That conversation does not exist.",
          });
          return;
        }
        const live = await ensureLive(runtime, conversation.id);
        send(socket, snapshot(live, "request"));
        return;
      }

      case "search": {
        if (!runtime.searchConversations) {
          send(socket, {
            t: "error",
            code: "server_error",
            message: "Search is not available.",
          });
          return;
        }
        if (
          typeof message.query !== "string" ||
          message.query.trim() === "" ||
          message.query.length > 200
        ) {
          send(socket, {
            t: "error",
            code: "bad_request",
            message: "query must be 1–200 characters.",
          });
          return;
        }
        const items = (await runtime.searchConversations(
          message.query,
        )) as ConversationSearchResult[];
        send(socket, { t: "search", query: message.query, items });
        return;
      }

      case "archive": {
        if (!runtime.archiveConversation) {
          send(socket, {
            t: "error",
            code: "server_error",
            message: "Archiving is not available.",
          });
          return;
        }
        const conversation = await runtime.conversation(message.conversationId);
        if (!conversation) {
          send(socket, {
            t: "error",
            code: "unknown_conversation",
            message: "That conversation does not exist.",
          });
          return;
        }
        await runtime.archiveConversation(
          message.conversationId,
          message.archived === true,
        );
        await broadcastConversations(runtime);
        return;
      }

      case "auth": {
        if (!runtime.auth) {
          send(socket, {
            t: "error",
            code: "auth_unavailable",
            message: "Anthropic auth selection is only available with the anthropic provider.",
          });
          return;
        }
        if (message.mode !== "subscription" && message.mode !== "api-key") {
          send(socket, {
            t: "error",
            code: "bad_request",
            message: "mode must be subscription or api-key.",
          });
          return;
        }
        try {
          const auth = await runtime.auth.setMode(message.mode);
          const payload = JSON.stringify({ t: "auth", auth } satisfies ServerMessage);
          for (const peer of clients) {
            if (!sameRuntime(peer.runtime, runtime)) continue;
            if (peer.socket.readyState === WebSocket.OPEN) {
              peer.socket.send(payload);
            }
          }
        } catch (error) {
          send(socket, {
            t: "error",
            code: "auth_unavailable",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      case "ping": {
        send(socket, { t: "pong", ts: message.ts });
        return;
      }

      default:
        return;
    }
  };

  const startClient = (
    socket: WebSocket,
    clientRuntime: GatewayRuntime,
    meta: { ip?: string; token?: string } = {},
  ) => {
    const client: Client = {
      socket,
      alive: true,
      runtime: clientRuntime,
      hooked:
        options.onRuntimeConnect !== undefined ||
        options.onRuntimeDisconnect !== undefined,
      ...(meta.ip ? { ip: meta.ip } : {}),
      ...(meta.token ? { token: meta.token } : {}),
    };
    clients.add(client);

    socket.on("pong", () => {
      client.alive = true;
    });

    socket.on("message", (data) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        send(socket, { t: "error", code: "bad_request", message: "Invalid JSON." });
        return;
      }
      if (typeof message !== "object" || message === null || typeof message.t !== "string") {
        send(socket, { t: "error", code: "bad_request", message: "Missing message type." });
        return;
      }
      void handle(client, message).catch((error) => {
        send(socket, {
          t: "error",
          code: "server_error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });

    socket.on("close", () => finishClient(client));
    socket.on("error", () => finishClient(client));
  };

  /** Run the disconnect hook once, then detach the client. */
  const finishClient = (client: Client) => {
    if (client.hooked) {
      client.hooked = false;
      const runtime = client.runtime;
      try {
        void Promise.resolve(options.onRuntimeDisconnect?.(runtime)).catch(
          (error) => logHookError("runtime disconnect hook failed", error),
        );
      } catch (error) {
        logHookError("runtime disconnect hook failed", error);
      }
    }
    detach(client);
    clients.delete(client);
  };

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    void (async () => {
      let hookRuntime: GatewayRuntime | undefined;
      let handedOff = false;
      let released = false;
      const releaseFailedUpgrade = () => {
        if (handedOff || released || hookRuntime === undefined) return;
        released = true;
        const runtime = hookRuntime;
        hookRuntime = undefined;
        try {
          void Promise.resolve(options.onRuntimeDisconnect?.(runtime)).catch(
            (error) => logHookError("runtime disconnect hook failed", error),
          );
        } catch (error) {
          logHookError("runtime disconnect hook failed", error);
        }
      };
      try {
        // R1: no drive-by browser control — reject cross-site origins first.
        if (!originAllowed(request, allowedOrigins)) {
          writeUpgradeError(socket, "403 Forbidden", "");
          return;
        }
        // R8: per-IP upgrade budget (and per-token when one is presented).
        const ip = remoteKey(request);
        const ipLimit = rateLimiter?.take(`ip:${ip}`);
        if (ipLimit && !ipLimit.allowed) {
          writeUpgradeError(
            socket,
            "429 Too Many Requests",
            `Retry-After: ${Math.ceil(ipLimit.retryAfterMs / 1000)}\r\n`,
          );
          return;
        }
        const candidate = candidateToken(request, url);
        if (candidate) {
          const tokenLimit = rateLimiter?.take(`token:${candidate}`);
          if (tokenLimit && !tokenLimit.allowed) {
            writeUpgradeError(
              socket,
              "429 Too Many Requests",
              `Retry-After: ${Math.ceil(tokenLimit.retryAfterMs / 1000)}\r\n`,
            );
            return;
          }
        }
        const resolved = await resolveRuntime(candidate);
        if (!resolved) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        // R6: reserve/count the runtime before the handshake completes; the
        // close/error listeners and catch below release it if the connection
        // never becomes a client.
        hookRuntime = resolved;
        await options.onRuntimeConnect?.(resolved, candidate);
        socket.once("close", releaseFailedUpgrade);
        socket.once("error", releaseFailedUpgrade);
        wss.handleUpgrade(request, socket, head, (ws) => {
          handedOff = true;
          startClient(ws, resolved, {
            ip,
            ...(candidate ? { token: candidate } : {}),
          });
        });
      } catch (error) {
        releaseFailedUpgrade();
        console.error("auth check failed", error);
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    })();
  });

  const authTimer = setInterval(() => {
    void (async () => {
      const runtimes = new Set<GatewayRuntime>();
      for (const client of clients) runtimes.add(client.runtime);
      for (const target of runtimes) {
        try {
          const revision =
            (await target.storage?.getSetting("auth_revision")) ?? "";
          if (revision === "" || revision === authRevisions.get(target)) continue;
          authRevisions.set(target, revision);
          const auth =
            (await target.authInfo?.()) ?? (await target.auth?.info());
          if (!auth) continue;
          const payload = JSON.stringify({ t: "auth", auth } satisfies ServerMessage);
          for (const client of clients) {
            if (!sameRuntime(client.runtime, target)) continue;
            if (client.socket.readyState === WebSocket.OPEN) {
              client.socket.send(payload);
            }
          }
        } catch (error) {
          console.error("auth broadcast failed", error);
        }
      }
    })();
  }, AUTH_POLL_MS);
  authTimer.unref?.();

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        finishClient(client);
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    async close() {
      clearInterval(heartbeat);
      clearInterval(authTimer);
      for (const live of lives.values()) {
        live.unsubscribe();
      }
      lives.clear();
      pending.clear();
      for (const client of clients) client.socket.close(1001, "server shutting down");
      clients.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
