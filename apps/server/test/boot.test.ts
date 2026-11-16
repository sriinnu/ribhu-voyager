import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Db } from "@ribhu-voyager/storage-sqlite";

import { createRuntime } from "../src/harness.js";
import type { Config } from "../src/config.js";

function configFor(dir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    workspaceDir: join(dir, "workspace"),
    provider: "demo",
    model: "ribhu-demo",
    demo: true,
    demoTokensPerSecond: 4000,
    maxWindowEntries: 100,
    token: "",
    authMode: "auto",
    authSource: "auto",
  };
}

test("boot clears phantom live docs on every conversation", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-boot-"));
  try {
    const first = await createRuntime(configFor(dir));
    const stale = await first.engine.createConversation("stale live");
    const id = stale.id;
    await first.close();

    const raw = new Db(join(dir, "ribhu.sqlite"));
    raw.putDoc(id, "pi.live", {
      run: { inputs: [999], turns: 9 },
      generation: { attempt: 1 },
    });
    raw.close();

    const second = await createRuntime(configFor(dir));
    try {
      const view = await (await second.engine.conversation(id))?.view();
      assert.deepEqual(view?.docs["pi.live"], {});
    } finally {
      await second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
