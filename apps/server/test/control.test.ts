import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApiRuntime } from "../src/api-runtime.js";
import type { Config } from "../src/config.js";
import { healthPayload } from "../src/health.js";

function configFor(dir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    workspaceDir: join(dir, "workspace"),
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    demo: false,
    demoTokensPerSecond: 4000,
    maxWindowEntries: 100,
    token: "",
    authMode: "auto",
    authSource: "auto",
    anthropicApiKey: "sk-dummy",
  };
}

test("API auth control writes the setting the worker applies", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-control-"));
  const api = await createApiRuntime(configFor(dir));
  try {
    assert.ok(api.auth);
    assert.equal((await api.auth.info()).apiKeyAvailable, true);
    const switched = await api.auth.setMode("api-key");
    assert.equal(switched.mode, "api-key");
    assert.equal(await api.storage.getSetting("auth_mode"), "api-key");
    const health = (await healthPayload(api)) as { auth?: { mode: string } };
    assert.equal(health.auth?.mode, "api-key");

    await api.auth.setMode("subscription");
    assert.equal(await api.storage.getSetting("auth_mode"), "subscription");
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
