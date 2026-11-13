import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { AuthManager } from "./auth.js";
import { PiAuthStore, defaultAuthFile } from "./auth-store.js";
import { ClaudeCodeAuthStore } from "./claude-code-auth.js";
import type { Config } from "./config.js";
import { Engine, type Conversation, type ModelRef } from "@ribhu-voyager/engine";
import { createProvider } from "@ribhu-voyager/providers";
import { Db, serializedStorage } from "@ribhu-voyager/storage-sqlite";

import { createToolRunner } from "./tools-runtime.js";

export type { ModelRef } from "@ribhu-voyager/engine";

export type Runtime = {
  serverId: string;
  startedAt: number;
  demo: boolean;
  model: ModelRef;
  root: Conversation;
  engine: Engine;
  auth?: AuthManager;
  conversation(id?: number): Promise<Conversation | undefined>;
  close(): Promise<void>;
};

const INSTRUCTIONS = [
  "You are Ribhu Voyager, a coding agent running on the user's machine.",
  "Your working directory is the root of the project you are working on.",
  "Use the read, write, edit, and bash tools to inspect and change files.",
  "Work in small, verified steps: read a file before editing it, prefer targeted edits,",
  "and run the relevant test or command after changing code.",
  "Never claim a result you have not observed in tool output.",
  "When you finish, summarize the files you changed and the commands you ran.",
].join(" ");

/** Embedded runtime for tests/dev; production runs api-runtime + worker separately. */
export async function createRuntime(config: Config): Promise<Runtime> {
  await mkdir(config.dataDir, { recursive: true });
  await mkdir(config.workspaceDir, { recursive: true });

  const authFile = defaultAuthFile();
  const piStore = new PiAuthStore(
    authFile === "none" ? join(config.dataDir, ".no-pi-auth.json") : authFile,
  );
  const auth = new AuthManager({
    pi: piStore,
    claudeCode: new ClaudeCodeAuthStore(),
    apiKey: config.anthropicApiKey,
    requestedMode: config.authMode,
    requestedSource: config.authSource,
    log: (line) => console.log(`  auth      ${line}`),
  });
  if (!config.demo && config.provider === "anthropic") {
    await auth.init();
  }

  const provider = createProvider({
    provider: config.demo ? "demo" : config.provider,
    model: config.demo ? "ribhu-demo" : config.model,
    getAnthropicAuth: () => auth.token(),
    env: process.env,
  });

  const model: ModelRef = config.demo
    ? { provider: "demo", modelId: "ribhu-demo" }
    : { provider: config.provider, modelId: config.model };

  const db = new Db(join(config.dataDir, "ribhu.sqlite"));
  const engine = await Engine.open({
    storage: serializedStorage(db),
    provider,
    runner: createToolRunner({ approvals: config.approvals ?? "allow" }),
    cwd: config.workspaceDir,
    model,
    instructions: INSTRUCTIONS,
    maxWindowEntries: config.maxWindowEntries,
    approvals: config.approvals ?? "allow",
    log: (line) => console.log(`  engine    ${line}`),
  });

  const root = await engine.root();
  const runtime: Runtime = {
    serverId: randomUUID(),
    startedAt: Date.now(),
    demo: config.demo,
    model,
    root,
    engine,
    ...(config.provider === "anthropic" ? { auth } : {}),
    async conversation(id?: number) {
      if (!id || id === root.id) return root;
      return engine.conversation(id);
    },
    async close() {
      await engine.close();
    },
  };

  return runtime;
}
