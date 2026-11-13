/**
 * Crash fixture: open the engine, admit a submission, start streaming, then
 * die without closing SQLite. The parent reopens the same journal.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { Engine } from "@ribhu-voyager/engine";
import type {
  Provider,
  ProviderEvent,
  ProviderRequest,
  Usage,
} from "@ribhu-voyager/engine";
import { Db } from "@ribhu-voyager/storage-sqlite";

import { createToolRunner } from "../../src/tools-runtime.js";

const dataDir = process.env.RIBBHU_TEST_DATA;
if (!dataDir) throw new Error("RIBBHU_TEST_DATA is required");

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
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

const usage: Usage = { input: 0, output: 2, totalTokens: 2 };

class SlowProvider implements Provider {
  readonly id = "slow";
  readonly model = "slow";
  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    for (let index = 0; index < 40; index += 1) {
      await sleep(80, request.signal);
      yield { type: "text", text: "partial " };
    }
    yield { type: "done", stopReason: "stop", usage };
  }
}

const workspace = join(dataDir, "workspace");
await mkdir(workspace, { recursive: true });

const db = new Db(join(dataDir, "ribhu.sqlite"));
const engine = await Engine.open({
  storage: db,
  provider: new SlowProvider(),
  runner: createToolRunner(),
  cwd: workspace,
  model: { provider: "slow", modelId: "slow" },
  instructions: "You are a test agent.",
});

const root = await engine.root();
await root.submit({
  type: "input",
  content: "What is durable?",
  requestId: "crash-1",
  whenBusy: "steer",
});

// Let the provider stream a little, then die hard.
setTimeout(() => process.exit(9), 500);
