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

export type AnthropicAuth = {
  token: string;
  mode: "subscription" | "api-key";
  source?: string;
};

export type AnthropicProviderOptions = {
  model: string;
  getAuth: () => Promise<AnthropicAuth>;
  baseUrl?: string;
  maxTokens?: number;
};

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: JsonObject };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

function convertMessages(messages: ModelMessage[]): AnthropicMessage[] {
  const output: AnthropicMessage[] = [];
  let pendingToolResults: Array<Record<string, unknown>> = [];

  const flushTools = () => {
    if (pendingToolResults.length > 0) {
      output.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const message of messages) {
    if (message.role === "toolResult") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError ? { is_error: true } : {}),
      });
      continue;
    }

    flushTools();

    if (message.role === "user") {
      output.push({ role: "user", content: message.content });
      continue;
    }

    const content: AnthropicContent[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        if (block.text !== "") content.push({ type: "text", text: block.text });
      } else {
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.arguments,
        });
      }
    }
    if (content.length > 0) output.push({ role: "assistant", content });
  }

  flushTools();
  return output;
}

function convertTools(tools: ProviderRequest["tools"]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

async function* readSse(
  response: Response,
): AsyncGenerator<{ event: string; data: string }> {
  if (!response.body) throw new Error("Anthropic response has no body");
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
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        let event = "";
        const data: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trim());
        }
        if (data.length > 0) yield { event, data: data.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  readonly model: string;
  private readonly getAuth: () => Promise<AnthropicAuth>;
  private readonly baseUrl: string;
  private readonly maxTokens: number;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.getAuth = options.getAuth;
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com";
    this.maxTokens = options.maxTokens ?? 8192;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const auth = await this.getAuth();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
    if (auth.mode === "api-key") {
      headers["x-api-key"] = auth.token;
    } else {
      headers.authorization = `Bearer ${auth.token}`;
      headers["anthropic-beta"] =
        "claude-code-20250219,oauth-2025-04-20";
      headers["user-agent"] = "claude-cli/2.1.317";
      headers["x-app"] = "cli";
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      signal: request.signal,
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens || this.maxTokens,
        system:
          auth.mode === "subscription"
            ? [
                {
                  type: "text",
                  text: "You are Claude Code, Anthropic's official CLI for Claude.",
                },
                { type: "text", text: request.system },
              ]
            : request.system,
        messages: convertMessages(request.messages),
        tools: convertTools(request.tools),
        stream: true,
        ...(request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw providerHttpError(
        "Anthropic",
        response.status,
        body,
        response.headers.get("retry-after"),
      );
    }

    const toolCalls: Array<{
      index: number;
      id: string;
      name: string;
      json: string;
    }> = [];
    const usage: Usage = { input: 0, output: 0, totalTokens: 0 };

    for await (const event of readSse(response)) {
      if (event.data === "[DONE]") break;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = payload.type;

      if (type === "error") {
        const error = payload.error as
          | { type?: string; message?: string }
          | undefined;
        const message = error?.message ?? "Anthropic stream error";
        const kind = error?.type ?? "";
        if (kind.includes("rate_limit")) {
          throw new ProviderError(message, {
            kind: "rate_limited",
            retryable: true,
            status: 429,
          });
        }
        if (kind.includes("overloaded") || kind.includes("api_error")) {
          throw new ProviderError(message, {
            kind: "server",
            retryable: true,
            status: 529,
          });
        }
        throw classifyProviderError(new Error(message));
      }

      if (type === "message_start") {
        const message = payload.message as
          | { usage?: { input_tokens?: number; output_tokens?: number } }
          | undefined;
        usage.input = message?.usage?.input_tokens ?? 0;
        usage.output = message?.usage?.output_tokens ?? 0;
        continue;
      }

      if (type === "content_block_start") {
        const index = Number(payload.index ?? 0);
        const block = payload.content_block as
          | { type?: string; id?: string; name?: string }
          | undefined;
        if (block?.type === "tool_use" && block.id && block.name) {
          toolCalls.push({ index, id: block.id, name: block.name, json: "" });
        }
        continue;
      }

      if (type === "content_block_delta") {
        const index = Number(payload.index ?? 0);
        const delta = payload.delta as
          | { type?: string; text?: string; partial_json?: string }
          | undefined;
        if (delta?.type === "text_delta" && delta.text) {
          yield { type: "text", text: delta.text };
        } else if (delta?.type === "input_json_delta" && delta.partial_json) {
          const tool = toolCalls.find((entry) => entry.index === index);
          if (tool) tool.json += delta.partial_json;
        }
        continue;
      }

      if (type === "content_block_stop") {
        const index = Number(payload.index ?? 0);
        const tool = toolCalls.find((entry) => entry.index === index);
        if (tool) {
          let parsed: JsonObject = {};
          if (tool.json.trim() !== "") {
            try {
              const value = JSON.parse(tool.json) as unknown;
              if (value && typeof value === "object" && !Array.isArray(value)) {
                parsed = value as JsonObject;
              }
            } catch {
              /* leave empty; the tool will report invalid arguments */
            }
          }
          toolCalls.splice(toolCalls.indexOf(tool), 1);
          yield {
            type: "toolCall",
            id: tool.id,
            name: tool.name,
            arguments: parsed,
          };
        }
        continue;
      }

      if (type === "message_delta") {
        const delta = payload.delta as { stop_reason?: string } | undefined;
        const usageDelta = payload.usage as
          | { output_tokens?: number }
          | undefined;
        if (typeof usageDelta?.output_tokens === "number") {
          usage.output = usageDelta.output_tokens;
        }
        const toolUse = delta?.stop_reason === "tool_use";
        yield {
          type: "done",
          stopReason: toolUse
            ? "toolUse"
            : delta?.stop_reason === "max_tokens"
              ? "length"
              : "stop",
          usage: {
            ...usage,
            totalTokens: usage.input + usage.output,
          },
        };
        return;
      }
    }

    yield {
      type: "done",
      stopReason: "stop",
      usage: { ...usage, totalTokens: usage.input + usage.output },
    };
  }
}
