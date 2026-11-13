export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export type ModelRef = { provider: string; modelId: string };

/**
 * Tool policy. `ask` exposes every tool and pauses before risky ones so the
 * user can approve each call; the engine journals the decision.
 */
export type ApprovalsMode = "allow" | "deny-bash" | "read-only" | "ask";

/**
 * What the user decided about one pending `ask`-mode tool call.
 * `always` approves it and journals a durable exact-match rule for the same
 * tool name + arguments, so identical calls no longer prompt.
 */
export type ApprovalDecision = "approve" | "deny" | "always";

export type SubmissionDraft = {
  type: "input";
  content: string;
  requestId: string;
  whenBusy?: "steer" | "followUp" | "reject";
  whenIdle?: "reject";
};

export type SubmissionInfo = { id: number; status: string };

export type Usage = {
  input: number;
  output: number;
  totalTokens: number;
};

export type TextBlock = { type: "text"; text: string };
export type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: JsonObject;
};
export type AssistantContent = TextBlock | ToolCallBlock;

export type UserMessage = {
  role: "user";
  content: string;
  timestamp: number;
};

export type AssistantMessage = {
  role: "assistant";
  content: AssistantContent[];
  stopReason: "pending" | "stop" | "toolUse" | "length" | "aborted" | "error";
  timestamp: number;
  usage: Usage;
  errorMessage?: string;
};

export type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
  timestamp: number;
};

export type ModelMessage = UserMessage | AssistantMessage | ToolResultMessage;

export type EntryRecord = {
  id: number;
  conversationId: number;
  kind: string;
  model?: ModelMessage[];
  data?: Json;
  byTaskId?: number;
};

export type ConversationView = {
  conversation: { id: number };
  entries: EntryRecord[];
  before?: number;
  docs: Record<string, JsonObject>;
};

export type ToolResult = {
  content: string;
  isError?: boolean;
  details?: Json;
};

export type ToolContext = {
  cwd: string;
  signal: AbortSignal;
  output: (chunk: string) => void;
  taskId: number;
};

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema object describing the arguments. */
  parameters: JsonObject;
  /** Safe to run again after a crash. Only read-only tools should set this. */
  replaySafe: boolean;
};

export type ProviderRequest = {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  temperature?: number;
  signal: AbortSignal;
};

export type ProviderEvent =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: JsonObject }
  | { type: "done"; stopReason: "stop" | "toolUse" | "length"; usage: Usage }
  | { type: "error"; message: string };

export interface Provider {
  readonly id: string;
  readonly model: string;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, totalTokens: 0 };
}

export function estimateUsage(text: string): Usage {
  const tokens = Math.ceil(text.length / 4);
  return { input: 0, output: tokens, totalTokens: tokens };
}

export function asJsonObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
