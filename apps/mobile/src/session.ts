import type {
  ApprovalDecision,
  ClientMessage,
  ConversationSearchResult,
  ConversationSummary,
  ServerInfo,
  ServerMessage,
  WireView,
} from "@ribhu-voyager/protocol";
import { PROTOCOL_VERSION } from "@ribhu-voyager/protocol";

import { subscribeForPush, unsubscribeFromPush } from "./push";
import {
  isOAuthLink,
  listenForAppUrls,
  parseDeepLink,
  type AppUrlListener,
  type DeepLink,
  type OAuthCallback,
  type OAuthErrorLink,
} from "./deep-link";
import { tokenStore } from "./storage";

export type { ApprovalDecision };

export type OutboxState = "queued" | "sending" | "failed";

export type OutboxItem = {
  requestId: string;
  content: string;
  whenBusy: "steer" | "followUp";
  conversationId?: number;
  createdAt: number;
  sentAt?: number;
  state: OutboxState;
  error?: string;
};

export type Status =
  | "restoring"
  | "connecting"
  | "online"
  | "reconnecting"
  | "offline";

export type State = {
  ready: boolean;
  status: Status;
  view: WireView | null;
  cursor: number;
  outbox: OutboxItem[];
  info: ServerInfo | null;
  conversations: ConversationSummary[];
  archivedConversations: ConversationSummary[];
  searchResults: ConversationSearchResult[];
  conversationId: number | null;
  error: string | null;
  lastAckAt: number | null;
  connectedAt: number | null;
  /** Gateway base URL (http/https). Defaults to this page's origin. */
  gateway: string;
  /** Bearer token for the gateway; shown only in the Settings editor. */
  token: string;
  /** Last OAuth deep link received; the code exchange is not wired yet. */
  oauth: OAuthCallback | OAuthErrorLink | null;
};

type Persisted = {
  clientId: string;
  view: WireView | null;
  cursor: number;
  outbox: OutboxItem[];
  conversationId: number | null;
  conversations?: ConversationSummary[];
  archivedConversations?: ConversationSummary[];
  savedAt?: number;
};

type OutboxMirror = {
  outbox: OutboxItem[];
  savedAt: number;
};

const DB_NAME = "ribhu";
const DB_STORE = "session";
const DB_KEY = "state";
const CLIENT_KEY = "ribhu.clientId";
const GATEWAY_KEY = "ribhu.gateway";
const SESSION_KEY = "ribhu.session";
const OUTBOX_KEY = "ribhu.outbox";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB failed"));
  });
}

function readLocalSession(): Persisted | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}

function readOutboxMirror(): OutboxMirror | null {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    return raw ? (JSON.parse(raw) as OutboxMirror) : null;
  } catch {
    return null;
  }
}

async function loadPersisted(): Promise<Persisted | null> {
  let snapshot: Persisted | null = null;
  try {
    const db = await openDb();
    snapshot = await new Promise<Persisted | null>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const request = tx.objectStore(DB_STORE).get(DB_KEY);
      request.onsuccess = () => resolve((request.result as Persisted) ?? null);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
    });
  } catch {
    snapshot = readLocalSession();
  }
  if (!snapshot) snapshot = readLocalSession();

  // The outbox is mirrored synchronously on every change, so it can be newer
  // than the last IndexedDB snapshot (e.g. the app was killed right after send).
  const mirror = readOutboxMirror();
  if (mirror && (!snapshot || mirror.savedAt > (snapshot.savedAt ?? 0))) {
    snapshot = {
      clientId: snapshot?.clientId ?? "",
      view: snapshot?.view ?? null,
      cursor: snapshot?.cursor ?? 0,
      conversationId: snapshot?.conversationId ?? null,
      outbox: mirror.outbox,
      savedAt: mirror.savedAt,
    };
  }
  return snapshot;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistQueue: Persisted | null = null;

function persist(value: Persisted): void {
  persistQueue = { ...value, savedAt: Date.now() };
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const next = persistQueue;
    if (!next) return;
    persistQueue = null;
    void (async () => {
      try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(DB_STORE, "readwrite");
          tx.objectStore(DB_STORE).put(next, DB_KEY);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        });
      } catch {
        try {
          localStorage.setItem(SESSION_KEY, JSON.stringify(next));
        } catch {
          /* storage full or unavailable; the in-memory session still works */
        }
      }
    })();
  }, 300);
}

/** Consume a `?token=` from the address bar once, then clean the URL. */
function readTokenFromUrl(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (!fromUrl) return null;
  url.searchParams.delete("token");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return fromUrl;
}

export type GatewayValidation =
  | { ok: true; gateway: string }
  | { ok: false; error: string };

/**
 * Validate and normalise a gateway base URL. Only http(s) is accepted; a bare
 * host is treated as https, matching how a native shell would reach a gateway.
 */
export function validateGatewayUrl(input: string): GatewayValidation {
  const raw = input.trim();
  if (raw === "") {
    return { ok: false, error: "Enter a gateway URL, for example https://gateway.example.com." };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: "That does not look like a valid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "The gateway must use http:// or https:// (not ws://)." };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, error: "Put credentials in the token field, not in the URL." };
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return { ok: true, gateway: `${parsed.origin}${path}` };
}

function readGateway(): string {
  try {
    const stored = localStorage.getItem(GATEWAY_KEY);
    if (stored) {
      const checked = validateGatewayUrl(stored);
      if (checked.ok) return checked.gateway;
    }
  } catch {
    /* storage disabled: fall back to this page's origin */
  }
  return window.location.origin;
}

function persistGateway(gateway: string): void {
  try {
    localStorage.setItem(GATEWAY_KEY, gateway);
  } catch {
    /* private mode: the setting still applies for this page session */
  }
}

function newClientId(): string {
  const existing = localStorage.getItem(CLIENT_KEY);
  if (existing) return existing;
  const created =
    globalThis.crypto?.randomUUID?.() ??
    `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(CLIENT_KEY, created);
  return created;
}

export class Session {
  private state: State = {
    ready: false,
    status: "restoring",
    view: null,
    cursor: 0,
    outbox: [],
    info: null,
    conversations: [],
    archivedConversations: [],
    searchResults: [],
    conversationId: null,
    error: null,
    lastAckAt: null,
    connectedAt: null,
    gateway: window.location.origin,
    token: "",
    oauth: null,
  };

  private listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private welcomed = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private sweep: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  private token = "";
  private clientId = "";
  private started = false;
  private nextReconnectAt = 0;
  private appUrlListener: AppUrlListener | null = null;

  getSnapshot = (): State => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.clientId = newClientId();
    const tokenFromUrl = readTokenFromUrl();
    this.token = tokenFromUrl ?? (await tokenStore.get());
    if (tokenFromUrl !== null) await tokenStore.set(tokenFromUrl);

    const gateway = readGateway();
    const initialLink = parseDeepLink(window.location.href);
    this.state = {
      ...this.state,
      gateway,
      token: this.token,
      ...(isOAuthLink(initialLink) ? { oauth: initialLink } : {}),
    };

    const persisted = await loadPersisted();
    if (persisted) {
      this.state = {
        ...this.state,
        view: persisted.view,
        cursor: persisted.cursor,
        conversationId: persisted.conversationId,
        conversations: persisted.conversations ?? [],
        archivedConversations: persisted.archivedConversations ?? [],
        outbox: persisted.outbox.map((item) => ({
          ...item,
          state: item.state === "sending" ? "queued" : item.state,
        })),
        ready: true,
        status: "connecting",
      };
    } else {
      this.state = { ...this.state, ready: true, status: "connecting" };
    }
    this.emit();

    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.flushPersist);

    this.appUrlListener = await listenForAppUrls((link) => this.handleDeepLink(link));

    this.connect();

    this.heartbeat = setInterval(() => this.beat(), 20_000);
    this.sweep = setInterval(() => this.retryStuck(), 10_000);
  }

  stop(): void {
    this.started = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.sweep) clearInterval(this.sweep);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.appUrlListener?.stop();
    this.appUrlListener = null;
    this.socket?.close();
    this.socket = null;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.flushPersist);
  }

  /**
   * Persist a new gateway URL and/or token, then reconnect. Returns a
   * validation error message, or null when the settings were applied.
   */
  saveGateway(input: string, token: string): string | null {
    const checked = validateGatewayUrl(input);
    if (!checked.ok) return checked.error;

    const gateway = checked.gateway;
    const nextToken = token.trim();
    const gatewayChanged = gateway !== this.state.gateway;

    this.token = nextToken;
    persistGateway(gateway);
    void tokenStore.set(nextToken).catch(() => undefined);

    this.state = gatewayChanged
      ? {
          // A different server means the cached replica belongs to someone
          // else: drop it and attach fresh.
          ...this.state,
          gateway,
          token: nextToken,
          view: null,
          cursor: 0,
          conversationId: null,
          conversations: [],
          archivedConversations: [],
          searchResults: [],
          status: "connecting",
          error: null,
        }
      : { ...this.state, gateway, token: nextToken, error: null };
    this.emit();
    this.persistSoon();
    this.restartConnection();
    return null;
  }

  /** Dismiss the "OAuth callback received" notice. */
  dismissOAuth(): void {
    if (this.state.oauth === null) return;
    this.state = { ...this.state, oauth: null };
    this.emit();
  }

  private handleDeepLink(link: DeepLink): void {
    if (!isOAuthLink(link)) return;
    this.state = { ...this.state, oauth: link };
    this.emit();
  }

  /** Drop the current socket and reconnect with the current gateway/token. */
  private restartConnection(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.welcomed = false;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
    this.attempts = 0;
    this.nextReconnectAt = 0;
    this.connect();
  }

  /** Reconnect immediately (used by the "Retry now" action). */
  reconnectNow(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.nextReconnectAt = 0;
    this.connect();
  }

  submit(content: string, whenBusy: "steer" | "followUp" = "steer"): void {
    const text = content.trim();
    if (text === "") return;

    const item: OutboxItem = {
      requestId:
        globalThis.crypto?.randomUUID?.() ??
        `req-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      content: text,
      whenBusy,
      conversationId: this.state.conversationId ?? undefined,
      createdAt: Date.now(),
      state: "queued",
    };

    this.state = { ...this.state, outbox: [...this.state.outbox, item] };
    this.emit();
    this.persistOutboxNow();
    this.persistSoon();
    this.flushOutbox();
  }

  retry(requestId: string): void {
    this.state = {
      ...this.state,
      outbox: this.state.outbox.map((item) =>
        item.requestId === requestId
          ? { ...item, state: "queued", error: undefined, sentAt: undefined }
          : item,
      ),
    };
    this.emit();
    this.persistOutboxNow();
    this.flushOutbox();
  }

  discard(requestId: string): void {
    this.state = {
      ...this.state,
      outbox: this.state.outbox.filter((item) => item.requestId !== requestId),
    };
    this.emit();
    this.persistOutboxNow();
    this.persistSoon();
  }

  abort(): void {
    this.send({ t: "abort" });
  }

  /**
   * Decide a pending `pi.approval` tool call. `always` also writes a durable
   * always-allow rule for this exact call on the gateway. The journaled
   * decision comes back through the normal view update, so there is no
   * optimistic UI state here. Returns false when the socket cannot carry the
   * decision yet (the caller should leave the buttons usable to retry).
   */
  decideApproval(callId: string, decision: ApprovalDecision): boolean {
    const conversationId = this.state.conversationId;
    if (conversationId === null || callId === "") return false;
    if (!this.welcomed || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.send({ t: "approval", conversationId, callId, decision });
    return true;
  }

  /**
   * Enable server Web Push for approvals. Requires the gateway to expose a
   * VAPID public key in `welcome` and a user gesture for permission.
   */
  async enablePushNotifications(): Promise<{ ok: boolean; error?: string }> {
    const publicKey = this.state.info?.pushPublicKey;
    if (!publicKey) {
      return { ok: false, error: "Server push is not configured on this gateway." };
    }
    if (!this.welcomed || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return { ok: false, error: "Reconnect before enabling push." };
    }
    try {
      const subscription = await subscribeForPush(publicKey);
      this.send({ t: "push", subscription });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async disablePushNotifications(): Promise<void> {
    try {
      const endpoint = await unsubscribeFromPush();
      if (endpoint) this.send({ t: "push", subscription: null, endpoint });
    } catch {
      /* best effort */
    }
  }

  resync(): void {
    if (this.state.conversationId === null) return;
    this.send({ t: "resync", conversationId: this.state.conversationId });
  }

  setAuth(mode: "subscription" | "api-key"): void {
    this.send({ t: "auth", mode });
  }

  newConversation(title?: string): void {
    this.send({ t: "create", ...(title ? { title } : {}) });
  }

  switchConversation(id: number): void {
    if (id === this.state.conversationId) return;
    this.state = {
      ...this.state,
      conversationId: id,
      view: null,
      cursor: 0,
      status: "connecting",
      error: null,
    };
    this.welcomed = false;
    this.emit();
    this.persistSoon();
    this.send({ t: "hello", v: PROTOCOL_VERSION, clientId: this.clientId, conversationId: id });
  }

  forkConversation(atEntryId?: number): void {
    if (this.state.conversationId === null) return;
    this.send({
      t: "fork",
      conversationId: this.state.conversationId,
      ...(atEntryId !== undefined ? { atEntryId } : {}),
    });
  }

  renameConversation(id: number, title: string): void {
    this.send({ t: "rename", conversationId: id, title });
  }

  compact(): void {
    this.send({ t: "compact" });
  }

  search(query: string): void {
    const text = query.trim();
    if (text === "") {
      this.update({ searchResults: [] });
      return;
    }
    this.send({ t: "search", query: text });
  }

  archiveConversation(id: number, archived = true): void {
    this.send({ t: "archive", conversationId: id, archived });
    if (id === this.state.conversationId) {
      const next = this.state.conversations.find((item) => item.id !== id);
      if (next) this.switchConversation(next.id);
    }
  }

  async clearLocal(): Promise<void> {
    try {
      const db = await openDb();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).delete(DB_KEY);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => resolve();
      });
    } catch {
      /* ignore */
    }
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(OUTBOX_KEY);
    this.state = {
      ...this.state,
      view: null,
      cursor: 0,
      outbox: [],
      conversationId: null,
      error: null,
    };
    this.emit();
    this.reconnectNow();
  }

  private onOnline = (): void => {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.welcomed) {
      this.state = { ...this.state, status: "online" };
      this.emit();
      this.flushOutbox();
      return;
    }
    this.reconnectNow();
  };

  private onOffline = (): void => {
    this.state = { ...this.state, status: "offline" };
    this.emit();
    // A socket that outlives the network going away cannot be trusted; close it
    // so reconnection goes through the normal backoff path.
    this.socket?.close();
  };

  private onVisibility = (): void => {
    if (document.visibilityState === "visible" && !this.socket) {
      this.reconnectNow();
    }
  };

  /** Synchronous outbox mirror: survives a kill with no unload event. */
  private persistOutboxNow(): void {
    try {
      localStorage.setItem(
        OUTBOX_KEY,
        JSON.stringify({ outbox: this.state.outbox, savedAt: Date.now() } satisfies OutboxMirror),
      );
    } catch {
      /* quota or private mode; IndexedDB remains the fallback */
    }
  }

  private flushPersist = (): void => {
    this.persistOutboxNow();
    persist({
      clientId: this.clientId,
      view: this.state.view,
      cursor: this.state.cursor,
      outbox: this.state.outbox,
      conversationId: this.state.conversationId,
    });
  };

  private persistSoon(): void {
    persist({
      clientId: this.clientId,
      view: this.state.view,
      cursor: this.state.cursor,
      outbox: this.state.outbox,
      conversationId: this.state.conversationId,
      conversations: this.state.conversations,
      archivedConversations: this.state.archivedConversations,
    });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private update(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
    this.persistSoon();
  }

  private url(): string {
    const base = new URL(this.state.gateway);
    const path = base.pathname.replace(/\/+$/, "");
    const protocol = base.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${base.host}${path}/ws`;
  }

  private connect(): void {
    if (!this.started) return;
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const status: Status =
      navigator.onLine === false ? "offline" : this.attempts === 0 ? "connecting" : "reconnecting";
    this.state = { ...this.state, status, error: null };
    this.emit();

    let socket: WebSocket;
    try {
      socket = new WebSocket(
        this.url(),
        this.token ? [`ribhu.token.${this.token}`] : undefined,
      );
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      this.lastPong = Date.now();
      this.welcomed = false;
      this.send({
        t: "hello",
        v: PROTOCOL_VERSION,
        clientId: this.clientId,
        conversationId: this.state.conversationId ?? undefined,
      });
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handle(message);
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.welcomed = false;
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  private scheduleReconnect(): void {
    if (!this.started) return;
    if (this.reconnectTimer) return;
    this.attempts += 1;
    const base = Math.min(15_000, 500 * 1.8 ** Math.min(this.attempts, 7));
    const delay = base + Math.random() * 400;
    this.nextReconnectAt = Date.now() + delay;
    this.state = {
      ...this.state,
      status: navigator.onLine === false ? "offline" : "reconnecting",
    };
    this.emit();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handle(message: ServerMessage): void {
    switch (message.t) {
      case "welcome": {
        this.welcomed = true;
        this.attempts = 0;
        this.state = {
          ...this.state,
          status: "online",
          view: message.view,
          cursor: message.cursor,
          info: message.info,
          conversationId: message.conversationId,
          error: null,
          connectedAt: Date.now(),
          outbox: this.state.outbox.map((item) =>
            item.state === "sending" ? { ...item, state: "queued" } : item,
          ),
        };
        this.emit();
        this.persistSoon();
        this.flushOutbox();
        return;
      }

      case "conversations": {
        this.update({
          conversations: message.items,
          archivedConversations: message.archived ?? [],
        });
        return;
      }

      case "search": {
        this.update({ searchResults: message.items });
        return;
      }

      case "view": {
        this.update({ view: message.view, cursor: message.cursor });
        return;
      }

      case "snapshot": {
        this.update({ view: message.view, cursor: message.cursor });
        return;
      }

      case "ack": {
        this.state = {
          ...this.state,
          outbox: this.state.outbox.filter(
            (item) => item.requestId !== message.requestId,
          ),
          lastAckAt: Date.now(),
        };
        this.emit();
        this.persistOutboxNow();
        this.persistSoon();
        return;
      }

      case "error": {
        if (message.requestId) {
          this.state = {
            ...this.state,
            outbox: this.state.outbox.map((item) =>
              item.requestId === message.requestId
                ? { ...item, state: "failed", error: message.message }
                : item,
            ),
            error: message.message,
          };
          this.emit();
          this.persistOutboxNow();
          this.persistSoon();
          return;
        }
        if (message.code === "unknown_conversation") {
          // The gateway's storage was reset (or this phone has a stale id):
          // forget the old replica and attach to the root conversation again.
          this.state = {
            ...this.state,
            conversationId: null,
            view: null,
            cursor: 0,
            error: null,
          };
          this.emit();
          this.persistSoon();
          this.send({ t: "hello", v: PROTOCOL_VERSION, clientId: this.clientId });
          return;
        }
        this.update({ error: message.message });
        return;
      }

      case "auth": {
        this.state = {
          ...this.state,
          info: this.state.info
            ? { ...this.state.info, auth: message.auth }
            : this.state.info,
          error: null,
        };
        this.emit();
        return;
      }

      case "pong": {
        this.lastPong = Date.now();
        return;
      }

      default:
        return;
    }
  }

  private send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private flushOutbox(): void {
    if (!this.welcomed) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const pending = this.state.outbox.filter((item) => item.state === "queued");
    if (pending.length === 0) return;

    const now = Date.now();
    const sending = new Set(pending.map((item) => item.requestId));
    this.state = {
      ...this.state,
      outbox: this.state.outbox.map((item) =>
        sending.has(item.requestId)
          ? { ...item, state: "sending", sentAt: now, error: undefined }
          : item,
      ),
    };
    this.emit();
    this.persistSoon();

    for (const item of pending) {
      this.send({
        t: "submit",
        requestId: item.requestId,
        content: item.content,
        whenBusy: item.whenBusy,
        conversationId: item.conversationId ?? this.state.conversationId ?? undefined,
      });
    }
  }

  private retryStuck(): void {
    const now = Date.now();
    let changed = false;
    const outbox = this.state.outbox.map((item) => {
      if (
        item.state === "sending" &&
        item.sentAt !== undefined &&
        now - item.sentAt > 15_000
      ) {
        changed = true;
        return { ...item, state: "queued" as const, sentAt: undefined };
      }
      return item;
    });
    if (changed) {
      this.state = { ...this.state, outbox };
      this.emit();
      this.flushOutbox();
    }
  }

  private beat(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.welcomed && Date.now() - this.lastPong > 45_000) {
      this.socket.close(4000, "heartbeat timeout");
      return;
    }
    this.send({ t: "ping", ts: Date.now() });
  }
}

export const session = new Session();
