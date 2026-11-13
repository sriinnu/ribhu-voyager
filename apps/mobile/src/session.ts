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
const TOKEN_KEY = "ribhu.token";
const CLIENT_KEY = "ribhu.clientId";
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

function readToken(): string {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_KEY) ?? "";
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

  getSnapshot = (): State => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.clientId = newClientId();
    this.token = readToken();

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

    this.connect();

    this.heartbeat = setInterval(() => this.beat(), 20_000);
    this.sweep = setInterval(() => this.retryStuck(), 10_000);
  }

  stop(): void {
    this.started = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.sweep) clearInterval(this.sweep);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.flushPersist);
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
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const query = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
    return `${protocol}//${window.location.host}/ws${query}`;
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
      socket = new WebSocket(this.url());
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
