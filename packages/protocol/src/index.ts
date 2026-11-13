/**
 * Wire protocol shared by the Ribhu Voyager gateway and the PWA.
 *
 * Everything the phone needs is a *view* (the journal's structural view) plus
 * a cursor. The gateway sends full snapshots, so a reconnecting client always
 * gets a consistent view.
 */

export const PROTOCOL_VERSION = 2;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A structural view entry, as it travels on the wire. */
export type WireEntry = {
  /** Durable row IDs. */
  id: number;
  conversationId: number;
  kind: string;
  model?: Json[];
  data?: Json;
  head?: number;
  byTaskId?: number;
};

/** The structural view for one conversation. */
export type WireView = {
  conversation: { id: number; parent?: Json; owner?: Json };
  entries: WireEntry[];
  before?: number;
  docs: Record<string, Json>;
};

/**
 * A decoded Chord operation. Shape: `["r", value]`, `["s", path, value]`,
 * `["d", path]`, `["a", path, text]`, `["t", path, n]`, `["p", path, i, n, items]`,
 * `["m", path, permutation]`.
 */
export type WireOp = readonly [string, ...Json[]];

export type ConversationSummary = {
  id: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  parentId?: number;
  forkEntryId?: number;
  archivedAt?: number;
};

export type ConversationSearchResult = ConversationSummary & {
  snippet?: string;
};

export type AuthMode = "subscription" | "api-key";
export type AuthSource = "pi" | "claude-code";

/** How Anthropic requests are currently authenticated. */
export type AuthInfo = {
  mode: AuthMode;
  source?: AuthSource;
  label: string;
  subscriptionAvailable: boolean;
  apiKeyAvailable: boolean;
  detail?: string;
};

/** Per-connection server config, sent once in `welcome`. */
export type ServerInfo = {
  serverId: string;
  demo: boolean;
  model: string;
  provider: string;
  startedAt: number;
  /** Present when the provider is Anthropic. */
  auth?: AuthInfo;
};

export type ClientMessage =
  | {
      t: "hello";
      v: number;
      clientId: string;
      conversationId?: number;
    }
  | {
      t: "submit";
      conversationId?: number;
      requestId: string;
      content: string;
      whenBusy?: "steer" | "followUp";
    }
  | { t: "abort"; conversationId?: number }
  | { t: "resync"; conversationId: number }
  | { t: "create"; title?: string }
  | { t: "fork"; conversationId: number; atEntryId?: number }
  | { t: "rename"; conversationId: number; title: string }
  | { t: "compact"; conversationId?: number }
  | {
      t: "approval";
      conversationId?: number;
      callId: string;
      decision: "approve" | "deny";
    }
  | { t: "search"; query: string }
  | { t: "archive"; conversationId: number; archived: boolean }
  | { t: "auth"; mode: AuthMode }
  | { t: "ping"; ts: number };

export type ServerMessage =
  | {
      t: "welcome";
      v: number;
      info: ServerInfo;
      conversationId: number;
      cursor: number;
      view: WireView;
    }
  | {
      t: "view";
      conversationId: number;
      cursor: number;
      view: WireView;
    }
  | {
      t: "snapshot";
      conversationId: number;
      cursor: number;
      view: WireView;
      reason: "gap" | "request" | "reconnect";
    }
  | { t: "ack"; requestId: string; submissionId: number }
  | {
      t: "conversations";
      items: ConversationSummary[];
      archived?: ConversationSummary[];
    }
  | {
      t: "search";
      query: string;
      items: ConversationSearchResult[];
    }
  | { t: "auth"; auth: AuthInfo }
  | { t: "pong"; ts: number }
  | {
      t: "error";
      requestId?: string;
      code: string;
      message: string;
      fatal?: boolean;
    };

export type ErrorCode =
  | "bad_request"
  | "bad_version"
  | "unknown_conversation"
  | "busy"
  | "idle"
  | "not_found"
  | "auth_unavailable"
  | "server_error";

export function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { t?: unknown }).t;
  return (
    t === "hello" ||
    t === "submit" ||
    t === "abort" ||
    t === "resync" ||
    t === "create" ||
    t === "fork" ||
    t === "rename" ||
    t === "compact" ||
    t === "approval" ||
    t === "search" ||
    t === "archive" ||
    t === "auth" ||
    t === "ping"
  );
}

export * from "./pkce.js";
