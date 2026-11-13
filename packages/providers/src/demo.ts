import type {
  JsonObject,
  ModelMessage,
  Provider,
  ProviderEvent,
  ProviderRequest,
  Usage,
} from "@ribhu-voyager/engine";

const HAIKU = `Streaming in the dark —
every token finds its home,
after the crash, light.`;

const DURABLE = `## Durable by construction

Every step is journaled before it is shown:

- **Crash** → reopen the SQLite journal; unfinished runs resume.
- **Disconnect** → the phone reconnects and gets a fresh snapshot.
- **Retry** → each submission has a \`requestId\`, so it is exactly-once.
- **Tools** → an interrupted unsafe tool is reported, never blindly re-run.

This is Ribhu Voyager's own engine: SQLite WAL, checkpointed run/tool tasks, and a small model loop.`;

const INTRO = `### Hi — this is Ribhu Voyager

A phone-first durable agent on its own harness.

Everything you see is committed to SQLite before it is rendered. The phone keeps a replica and an outbox; the gateway owns the run, the tools, and the journal.

Try:

- **What is durable about this?**
- **run: uname -a** → a real bash tool task
- **Write a haiku about durable systems**

Or kill the gateway mid-answer and reopen this page. The run resumes.`;

function lastUser(messages: ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") return message.content.trim();
  }
  return "";
}

function lastToolResult(messages: ModelMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "toolResult") return message.content;
    if (message.role === "user") break;
  }
  return undefined;
}

function extractCommand(text: string): string | undefined {
  const run = text.match(/^(?:run|shell|exec)\s*:\s*([\s\S]+)$/i);
  if (run?.[1]) return run[1].trim();
  const fence = text.match(/```(?:sh|bash|shell)?\s*\n([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  return undefined;
}

function toolSummary(output: string): string {
  const bounded = output.trim().slice(0, 1400);
  return `**Done.** That ran as a durable tool task. Its intent was journaled before the command started, so a crash reports the interruption instead of blindly running it twice.

\`\`\`text
${bounded || "(no output)"}
\`\`\`

The phone received the streamed output through the same commit pipeline as the transcript.`;
}

function reply(request: ProviderRequest): { text: string } | { command: string } {
  const toolOutput = lastToolResult(request.messages);
  if (toolOutput !== undefined) return { text: toolSummary(toolOutput) };

  const text = lastUser(request.messages);
  const lower = text.toLowerCase();
  const command = extractCommand(text);
  if (command) return { command };
  if (lower.includes("haiku")) return { text: HAIKU };
  if (lower.includes("durab")) return { text: DURABLE };
  if (text === "" || /^(hi|hey|hello|yo|sup|start|help)\b/i.test(text) || lower.includes("what is this")) {
    return { text: INTRO };
  }
  return {
    text: `### Message received

The journal committed your message before this stream started, so it survives a reload, a lost connection, or a killed gateway.

- the transcript is append-only
- runs and tool calls checkpoint into SQLite
- retries reuse the \`requestId\`

Try **run: uname -a**, or kill the gateway mid-answer and reopen this page.

> You said: ${text.replace(/^#+\s*/gm, "").slice(0, 280)}`,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const usageFor = (text: string): Usage => {
  const output = Math.ceil(text.length / 4);
  return { input: 0, output, totalTokens: output };
};

export class DemoProvider implements Provider {
  readonly id = "demo";
  readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const result = reply(request);
    if ("command" in result) {
      await sleep(120, request.signal);
      const call: JsonObject = { command: result.command };
      yield {
        type: "toolCall",
        id: `call_${Date.now()}`,
        name: "bash",
        arguments: call,
      };
      yield { type: "done", stopReason: "toolUse", usage: usageFor("") };
      return;
    }

    const text = result.text;
    for (let index = 0; index < text.length; index += 24) {
      const chunk = text.slice(index, index + 24);
      yield { type: "text", text: chunk };
      await sleep(8, request.signal);
    }
    yield { type: "done", stopReason: "stop", usage: usageFor(text) };
  }
}
