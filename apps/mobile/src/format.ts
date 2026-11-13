import type { WireEntry, WireView } from "@ribhu-voyager/protocol";

export type ToolResult = {
  entryId: number;
  text: string;
  isError: boolean;
};

export type ToolSlot = {
  callId: string;
  name: string;
  status: "pending" | "running" | "done";
  output?: string;
  droppedBytes?: number;
  droppedLines?: number;
};

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool";
      callId: string;
      name: string;
      args: Record<string, unknown>;
      result?: ToolResult;
      live?: ToolSlot;
    };

/** A durable `pi.approval` journal request/decision, folded per tool call. */
export type Approval = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  status: "pending" | "approved" | "denied";
  requestedAt?: number;
  decidedAt?: number;
  /** The decision also wrote an always-allow rule for this exact call. */
  always: boolean;
};

export type Item =
  | {
      kind: "approval";
      id: string;
      approval: Approval;
    }
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistant";
      id: string;
      blocks: Block[];
      streaming: boolean;
      interrupted: boolean;
      error?: string;
    }
  | { kind: "notice"; id: string; text: string; tone: "muted" | "error" }
  | {
      kind: "queued";
      id: string;
      requestId: string;
      text: string;
      state: "queued" | "sending" | "failed";
      error?: string;
    };

type AnyMessage = {
  role?: string;
  content?: unknown;
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
  isError?: boolean;
  toolCallId?: string;
  toolName?: string;
  thinking?: string;
  text?: string;
  type?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
};

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as { type?: string; text?: string; thinking?: string };
      if (block.type === "text") return block.text ?? "";
      if (block.type === "image") return "[image]";
      if (block.type === "thinking") return "";
      return "";
    })
    .join("");
}

function parseAssistant(message: AnyMessage): Block[] {
  const blocks: Block[] = [];
  const content = Array.isArray(message.content) ? message.content : [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as AnyMessage;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      blocks.push({ type: "thinking", text: block.thinking });
    } else if (block.type === "toolCall") {
      blocks.push({
        type: "tool",
        callId: String(block.id ?? ""),
        name: String(block.name ?? "tool"),
        args:
          block.arguments && typeof block.arguments === "object"
            ? (block.arguments as Record<string, unknown>)
            : {},
      });
    }
  }
  return blocks;
}

function firstModel(entry: WireEntry): AnyMessage | undefined {
  return Array.isArray(entry.model) && entry.model.length > 0
    ? (entry.model[0] as AnyMessage)
    : undefined;
}

export type LiveDoc = {
  run?: { turns?: number };
  generation?: {
    attempt?: number;
    message?: AnyMessage;
    retry?: { at: number; error: string };
  };
  tools?: ToolSlot[];
  compactions?: { taskId?: number; trigger?: string; blocking?: boolean }[];
  runFailure?: { reason: string; detail?: string; inputs?: unknown[] };
};
export function liveOf(view: WireView | null): LiveDoc | null {
  if (!view) return null;
  const doc = view.docs["pi.live"];
  return doc && typeof doc === "object" ? (doc as unknown as LiveDoc) : null;
}

export function busyOf(view: WireView | null): boolean {
  return Boolean(liveOf(view)?.run);
}

export function modelOf(view: WireView | null): string | null {
  if (!view) return null;
  const agent = view.docs["pi.agent"];
  if (!agent || typeof agent !== "object") return null;
  const model = (agent as { model?: { modelId?: string; provider?: string } }).model;
  if (!model?.modelId) return null;
  return model.modelId;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Fold every `pi.approval` journal entry into one current state per tool call.
 * A request entry carries the tool name/args; a later decision entry flips the
 * status. The first entry for a call is the anchor used for timeline placement,
 * so a request and its decision never render as two separate cards.
 */
function foldApprovals(view: WireView): {
  approvals: Map<string, Approval>;
  anchors: Map<string, number>;
} {
  const approvals = new Map<string, Approval>();
  const anchors = new Map<string, number>();
  for (const entry of view.entries) {
    if (entry.kind !== "pi.approval") continue;
    const data = record(entry.data);
    const callId = typeof data.callId === "string" ? data.callId : "";
    if (callId === "") continue;
    const previous = approvals.get(callId);
    const status =
      data.status === "approved" || data.status === "denied"
        ? data.status
        : "pending";
    const name =
      typeof data.name === "string" && data.name !== ""
        ? data.name
        : previous?.name ?? "tool";
    const args = record(data.args);
    approvals.set(callId, {
      callId,
      name,
      args: Object.keys(args).length > 0 ? args : previous?.args ?? {},
      status,
      requestedAt:
        typeof data.requestedAt === "number"
          ? data.requestedAt
          : previous?.requestedAt,
      decidedAt:
        typeof data.decidedAt === "number" ? data.decidedAt : previous?.decidedAt,
      // `always` rides on the decision entry; a later plain approve/deny entry
      // for the same call must not inherit it.
      always:
        data.always === true
          ? true
          : status === "pending"
            ? false
            : previous?.always ?? false,
    });
    if (!anchors.has(callId)) anchors.set(callId, entry.id);
  }
  return { approvals, anchors };
}

/** One-line, truncated preview of the arguments a tool call will receive. */
export function approvalPreview(approval: Approval, max = 160): string {
  const { args } = approval;
  const direct =
    typeof args.command === "string"
      ? args.command
      : typeof args.path === "string"
        ? args.path
        : "";
  let text = direct;
  if (text === "" && Object.keys(args).length > 0) {
    try {
      text = JSON.stringify(args);
    } catch {
      text = "";
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Every tool call currently waiting on a human decision. */
export function pendingApprovals(view: WireView | null): Approval[] {
  if (!view) return [];
  const { approvals } = foldApprovals(view);
  return [...approvals.values()].filter((approval) => approval.status === "pending");
}

export type Timeline = {
  items: Item[];
  busy: boolean;
  streaming: boolean;
  hasEarlier: boolean;
  failure: LiveDoc["runFailure"] | null;
};

export function buildTimeline(
  view: WireView | null,
  outbox: { requestId: string; content: string; state: string; error?: string }[] = [],
): Timeline {
  if (!view) {
    return { items: [], busy: false, streaming: false, hasEarlier: false, failure: null };
  }

  const live = liveOf(view);
  const results = new Map<string, ToolResult>();
  for (const entry of view.entries) {
    if (entry.kind !== "pi.tool-result") continue;
    const message = firstModel(entry);
    if (!message?.toolCallId) continue;
    results.set(String(message.toolCallId), {
      entryId: entry.id,
      text: contentText(message.content),
      isError: message.isError === true,
    });
  }

  const slots = new Map<string, ToolSlot>();
  for (const slot of live?.tools ?? []) {
    slots.set(slot.callId, slot);
  }

  const { approvals, anchors } = foldApprovals(view);

  const items: Item[] = [];

  for (const entry of view.entries) {
    switch (entry.kind) {
      case "pi.approval": {
        const data = record(entry.data);
        const callId = typeof data.callId === "string" ? data.callId : "";
        const approval = callId !== "" ? approvals.get(callId) : undefined;
        if (approval && anchors.get(callId) === entry.id) {
          items.push({ kind: "approval", id: String(entry.id), approval });
        }
        break;
      }
      // Always-allow rules are configuration, not conversation content: never
      // render them as chat messages (and they are not approval cards).
      case "pi.approval-rule": {
        break;
      }
      case "pi.user": {
        const message = firstModel(entry);
        const text = contentText(message?.content);
        if (text.trim() !== "") {
          items.push({ kind: "user", id: String(entry.id), text });
        }
        break;
      }
      case "pi.assistant": {
        const message = firstModel(entry);
        if (!message) break;
        const blocks = parseAssistant(message).map((block) =>
          block.type === "tool"
            ? {
                ...block,
                result: results.get(block.callId),
                live: slots.get(block.callId),
              }
            : block,
        );
        const interrupted =
          message.stopReason === "aborted" ||
          message.stopReason === "error" ||
          message.stopReason === "interrupted";
        items.push({
          kind: "assistant",
          id: String(entry.id),
          blocks,
          streaming: false,
          interrupted,
          error: message.errorMessage,
        });
        break;
      }
      case "pi.tool-result": {
        const message = firstModel(entry);
        const callId = String(message?.toolCallId ?? "");
        const attached = items.some(
          (item) =>
            item.kind === "assistant" &&
            item.blocks.some((block) => block.type === "tool" && block.callId === callId),
        );
        if (!attached && message) {
          items.push({
            kind: "assistant",
            id: String(entry.id),
            blocks: [
              {
                type: "tool",
                callId: callId || `orphan-${entry.id}`,
                name: String(message.toolName ?? "tool"),
                args: {},
                result: {
                  entryId: entry.id,
                  text: contentText(message.content),
                  isError: message.isError === true,
                },
              },
            ],
            streaming: false,
            interrupted: false,
          });
        }
        break;
      }
      case "pi.compaction": {
        const data = entry.data as { summary?: unknown } | undefined;
        const summary =
          typeof data?.summary === "string"
            ? data.summary.replace(/\s+/g, " ").trim()
            : "";
        items.push({
          kind: "notice",
          id: String(entry.id),
          text: summary
            ? `Context compacted — full transcript retained.\n\n${summary.slice(0, 240)}${summary.length > 240 ? "…" : ""}`
            : "Earlier context compacted — the full transcript is still stored.",
          tone: "muted",
        });
        break;
      }
      case "pi.reset": {
        items.push({
          kind: "notice",
          id: String(entry.id),
          text: "A new context started here.",
          tone: "muted",
        });
        break;
      }
      default:
        break;
    }
  }

  const generation = live?.generation;
  let streaming = false;
  if (generation?.message) {
    const partial = generation.message;
    const lastEntry = [...view.entries].reverse().find((entry) => entry.kind === "pi.assistant");
    const lastMessage = lastEntry ? firstModel(lastEntry) : undefined;

    const duplicate =
      lastEntry !== undefined &&
      lastMessage?.timestamp !== undefined &&
      partial.timestamp !== undefined &&
      lastMessage.timestamp === partial.timestamp;

    if (!duplicate) {
      const blocks = parseAssistant(partial).map((block) =>
        block.type === "tool"
          ? {
              ...block,
              result: results.get(block.callId),
              live: slots.get(block.callId),
            }
          : block,
      );
      items.push({
        kind: "assistant",
        id: `stream-${partial.timestamp ?? "now"}`,
        blocks,
        streaming: true,
        interrupted: false,
      });
      streaming = true;
    }
  }

  for (const item of outbox) {
    items.push({
      kind: "queued",
      id: `outbox-${item.requestId}`,
      requestId: item.requestId,
      text: item.content,
      state: item.state as "queued" | "sending" | "failed",
      error: item.error,
    });
  }

  return {
    items,
    busy: Boolean(live?.run),
    streaming,
    hasEarlier: view.before !== undefined,
    failure: live?.runFailure ?? null,
  };
}
