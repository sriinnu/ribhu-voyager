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

type Client = {
  socket: WebSocket;
  alive: boolean;
  conversationId?: number;
};

type Live = {
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

async function authorized(
  request: IncomingMessage,
  url: URL,
  token: string,
  check?: (candidate: string) => Promise<boolean>,
): Promise<boolean> {
  const candidate = candidateToken(request, url);
  if (!check) {
    if (token === "") return true;
    return candidate !== undefined && safeEqual(candidate, token);
  }
  if (candidate === undefined) return false;
  return check(candidate);
}

export type GatewayOptions = {
  authorizeToken?: (candidate: string) => Promise<boolean>;
};

export function attachGateway(
  server: HttpServer,
  runtime: GatewayRuntime,
  info: ServerInfo,
  token: string,
  window: { min: number; max: number } = { min: 50, max: 100 },
  options: GatewayOptions = {},
): Gateway {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1_048_576,
  });
  const clients = new Set<Client>();
  const lives = new Map<number, Live>();
  let lastAuthRevision = "";
  const pending = new Map<number, Promise<Live>>();

  const broadcast = (live: Live, message: ServerMessage) => {
    const payload = JSON.stringify(message);
    for (const client of live.clients) {
      if (client.socket.readyState === WebSocket.OPEN) client.socket.send(payload);
    }
  };

  const ensureLive = (conversationId: number): Promise<Live> => {
    const existing = lives.get(conversationId);
    if (existing) return Promise.resolve(existing);

    const inflight = pending.get(conversationId);
    if (inflight) return inflight;

    const created = (async (): Promise<Live> => {
      const conversation = await runtime.conversation(conversationId);
      if (!conversation) throw new Error(`unknown conversation ${conversationId}`);

      const initial = await conversation.view();
      const live: Live = {
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

      lives.set(conversationId, live);
      return live;
    })();

    pending.set(conversationId, created);
    void created
      .catch(() => undefined)
      .finally(() => pending.delete(conversationId));
    return created;
  };

  const conversationList = async (
    includeArchived = false,
  ): Promise<ConversationSummary[]> =>
    (await runtime.listConversations?.(includeArchived)) ?? [];

  const sendConversations = async (socket: WebSocket): Promise<void> => {
    const all = await conversationList(true);
    send(socket, {
      t: "conversations",
      items: all.filter((item) => item.archivedAt === undefined),
      archived: all.filter((item) => item.archivedAt !== undefined),
    });
  };

  const broadcastConversations = async (): Promise<void> => {
    const all = await conversationList(true);
    const payload = JSON.stringify({
      t: "conversations",
      items: all.filter((item) => item.archivedAt === undefined),
      archived: all.filter((item) => item.archivedAt !== undefined),
    } satisfies ServerMessage);
    for (const client of clients) {
      if (client.socket.readyState === WebSocket.OPEN) client.socket.send(payload);
    }
  };

  const join = async (
    client: Client,
    conversationId?: number,
  ): Promise<boolean> => {
    const conversation = await runtime.conversation(conversationId);
    if (!conversation) return false;
    detach(client);
    const live = await ensureLive(conversation.id);
    live.view = await conversation.view();
    live.clients.add(client);
    client.conversationId = conversation.id;
    const auth = runtime.auth ? await runtime.auth.info() : undefined;
    send(client.socket, {
      t: "welcome",
      v: PROTOCOL_VERSION,
      info: {
        ...info,
        ...(auth ? { auth } : {}),
      },
      conversationId: conversation.id,
      cursor: live.cursor,
      view: live.view as unknown as WireView,
    });
    await sendConversations(client.socket);
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
    const live = lives.get(client.conversationId);
    if (live) {
      live.clients.delete(client);
      if (live.clients.size === 0) {
        live.unsubscribe();
        lives.delete(live.conversationId);
      }
    }
    client.conversationId = undefined;
  };

  const handle = async (client: Client, message: ClientMessage) => {
    const socket = client.socket;

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
        await broadcastConversations();
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
        await broadcastConversations();
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
        if (message.decision !== "approve" && message.decision !== "deny") {
          send(socket, {
            t: "error",
            code: "bad_request",
            message: "decision must be approve or deny.",
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
            message.decision === "approve",
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
        await runtime.renameConversation(message.conversationId, message.title);
        await broadcastConversations();
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
        const conversation = await runtime.conversation(message.conversationId);
        if (!conversation) {
          send(socket, {
            t: "error",
            code: "unknown_conversation",
            message: "That conversation does not exist.",
          });
          return;
        }
        const live = await ensureLive(conversation.id);
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
        await runtime.archiveConversation(
          message.conversationId,
          message.archived === true,
        );
        await broadcastConversations();
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

  wss.on("connection", (socket: WebSocket) => {
    const client: Client = { socket, alive: true };
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

    socket.on("close", () => {
      detach(client);
      clients.delete(client);
    });

    socket.on("error", () => {
      detach(client);
      clients.delete(client);
    });
  });

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
      try {
        if (!(await authorized(request, url, token, options.authorizeToken))) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      } catch (error) {
        console.error("auth check failed", error);
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    })();
  });

  const authTimer = setInterval(() => {
    void (async () => {
      try {
        const revision =
          (await runtime.storage?.getSetting("auth_revision")) ?? "";
      if (revision === "" || revision === lastAuthRevision) return;
      lastAuthRevision = revision;
      const auth = (await runtime.authInfo?.()) ?? (await runtime.auth?.info());
      if (!auth) return;
      const payload = JSON.stringify({ t: "auth", auth } satisfies ServerMessage);
        for (const client of clients) {
          if (client.socket.readyState === WebSocket.OPEN) client.socket.send(payload);
        }
      } catch (error) {
        console.error("auth broadcast failed", error);
      }
    })();
  }, 500);
  authTimer.unref?.();

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        clients.delete(client);
        detach(client);
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
      for (const client of clients) client.socket.close(1001, "server shutting down");
      clients.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
