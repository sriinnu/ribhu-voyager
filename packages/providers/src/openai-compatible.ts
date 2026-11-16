import {
  ProviderError,
  classifyProviderError,
  providerHttpError,
  type JsonObject,
  type ModelMessage,
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
  type Usage,
} from "@ribhu-voyager/engine";

export type OpenAICompatOptions = {
  id: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  maxTokens?: number;
  headers?: Record<string, string>;
};

type OpenAIMessage = Record<string, unknown>;

function convertMessages(
  system: string,
  messages: ModelMessage[],
): OpenAIMessage[] {
  const output: OpenAIMessage[] = [];
  if (system.trim() !== "") output.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "user") {
      output.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "toolResult") {
      output.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      });
      continue;
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    const toolCalls = message.content
      .filter((block) => block.type === "toolCall")
      .map((block) =>
        block.type === "toolCall"
          ? {
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.arguments),
              },
            }
          : undefined,
      )
      .filter(Boolean);
    if (text === "" && toolCalls.length === 0) continue;
    output.push({
      role: "assistant",
      content: text === "" ? null : text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  return output;
}

async function* readSse(
  response: Response,
): AsyncGenerator<string> {
  if (!response.body) throw new Error("response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trimEnd();
        buffer = buffer.slice(index + 1);
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data !== "") yield data;
        }
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) yield tail.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

export class OpenAICompatProvider implements Provider {
  readonly id: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxTokens: number;
  private readonly headers: Record<string, string>;

  constructor(options: OpenAICompatOptions) {
    this.id = options.id;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.maxTokens = options.maxTokens ?? 8192;
    this.headers = options.headers ?? {};
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(this.apiKey !== "" ? { authorization: `Bearer ${this.apiKey}` } : {}),
        ...this.headers,
      },
      signal: request.signal,
      body: JSON.stringify({
        model: request.model,
        messages: convertMessages(request.system, request.messages),
        tools: request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
        stream: true,
        max_tokens: request.maxTokens || this.maxTokens,
        ...(request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw providerHttpError(
        this.id,
        response.status,
        body,
        response.headers.get("retry-after"),
      );
    }

    const toolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let finishReason: string | null = null;
    const usage: Usage = { input: 0, output: 0, totalTokens: 0 };

    for await (const data of readSse(response)) {
      if (data === "[DONE]") break;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (payload.error) {
        const error = payload.error as
          | { message?: string; type?: string; code?: string }
          | undefined;
        const message = error?.message ?? `${this.id} stream error`;
        const kind = `${error?.type ?? ""} ${error?.code ?? ""}`.toLowerCase();
        if (kind.includes("rate_limit") || kind.includes("rate-limit")) {
          throw new ProviderError(message, {
            kind: "rate_limited",
            retryable: true,
            status: 429,
          });
        }
        if (kind.includes("overload") || kind.includes("server_error")) {
          throw new ProviderError(message, {
            kind: "server",
            retryable: true,
            status: 503,
          });
        }
        // e.g. insufficient_quota is permanent (billing), not transient.
        throw classifyProviderError(new Error(message));
      }
      const choices = payload.choices as
        | Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>
        | undefined;
      const choice = choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (delta?.content) {
        yield { type: "text", text: delta.content };
      }
      for (const call of delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const current = toolCalls.get(index) ?? {
          id: call.id ?? `call_${index}`,
          name: "",
          arguments: "",
        };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) {
          current.arguments += call.function.arguments;
        }
        toolCalls.set(index, current);
      }
      const rawUsage = payload.usage as
        | {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          }
        | undefined;
      if (rawUsage) {
        usage.input = rawUsage.prompt_tokens ?? usage.input;
        usage.output = rawUsage.completion_tokens ?? usage.output;
        usage.totalTokens =
          rawUsage.total_tokens ?? usage.input + usage.output;
      }
    }

    for (const call of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      let parsed: JsonObject = {};
      if (call[1].arguments.trim() !== "") {
        try {
          const value = JSON.parse(call[1].arguments) as unknown;
          if (value && typeof value === "object" && !Array.isArray(value)) {
            parsed = value as JsonObject;
          }
        } catch {
          /* leave empty; tool will report invalid arguments */
        }
      }
      yield {
        type: "toolCall",
        id: call[1].id,
        name: call[1].name,
        arguments: parsed,
      };
    }

    yield {
      type: "done",
      stopReason:
        toolCalls.size > 0
          ? "toolUse"
          : finishReason === "length"
            ? "length"
            : "stop",
      usage: {
        ...usage,
        totalTokens: usage.totalTokens || usage.input + usage.output,
      },
    };
  }
}
