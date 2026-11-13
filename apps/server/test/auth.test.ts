import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiAuthStore } from "../src/auth-store.js";
import { AuthManager } from "../src/auth.js";
import { ClaudeCodeAuthStore } from "../src/claude-code-auth.js";

const oauth = (access: string, refresh: string, expires: number) => ({
  type: "oauth" as const,
  access,
  refresh,
  expires,
});

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ribhu-auth-"));
}

test("reads Claude Code credentials and caches refreshes locally", { timeout: 20_000 }, async () => {
  const dir = await tempDir();
  const file = join(dir, ".credentials.json");
  const cacheFile = join(dir, "cache.json");

  try {
    await writeFile(
      file,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "access-1",
          refreshToken: "refresh-1",
          expiresAt: Date.now() + 3_600_000,
          subscriptionType: "max",
          scopes: ["user:inference"],
        },
      }),
    );

    const store = new ClaudeCodeAuthStore({
      file,
      cacheFile,
      readKeychain: false,
    });

    assert.equal(await store.available(), true);
    const read = await store.read("anthropic");
    assert.equal(read?.type === "oauth" ? read.access : undefined, "access-1");

    const next = await store.modify("anthropic", async (current) => {
      if (current?.type !== "oauth") throw new Error("missing credential");
      return { ...current, access: "access-2", expires: current.expires + 3_600_000 };
    });
    assert.equal(next?.type === "oauth" ? next.access : undefined, "access-2");

    const cached = JSON.parse(await readFile(cacheFile, "utf8")) as {
      access: string;
    };
    assert.equal(cached.access, "access-2");

    const reread = await store.read("anthropic");
    assert.equal(reread?.type === "oauth" ? reread.access : undefined, "access-2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("selects the valid Claude Code login and switches to API credits", { timeout: 20_000 }, async () => {
  const dir = await tempDir();
  const piFile = join(dir, "pi-auth.json");
  const claudeFile = join(dir, ".credentials.json");

  try {
    await writeFile(
      piFile,
      JSON.stringify({
        anthropic: oauth("pi-access", "pi-refresh", Date.now() - 1_000_000),
      }),
    );
    await writeFile(
      claudeFile,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "cc-access",
          refreshToken: "cc-refresh",
          expiresAt: Date.now() + 3_600_000,
          subscriptionType: "max",
        },
      }),
    );

    const auth = new AuthManager({
      pi: new PiAuthStore(piFile),
      claudeCode: new ClaudeCodeAuthStore({
        file: claudeFile,
        cacheFile: join(dir, "claude-cache.json"),
        readKeychain: false,
      }),
      apiKey: "sk-test",
    });

    await auth.init();
    const initial = auth.info();
    assert.equal(initial.mode, "subscription");
    assert.equal(initial.source, "claude-code");
    assert.match(initial.label, /Claude Code/);

    const subscription = await auth.token();
    assert.equal(subscription.token, "cc-access");
    assert.equal(subscription.mode, "subscription");

    await auth.setMode("api-key");
    assert.equal(auth.info().mode, "api-key");
    const credits = await auth.token();
    assert.equal(credits.token, "sk-test");
    assert.equal(credits.mode, "api-key");

    await auth.setMode("subscription");
    const again = await auth.token();
    assert.equal(again.token, "cc-access");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses API-credit mode without a key", { timeout: 20_000 }, async () => {
  const dir = await tempDir();
  const claudeFile = join(dir, ".credentials.json");

  try {
    await writeFile(
      claudeFile,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "cc-access",
          refreshToken: "cc-refresh",
          expiresAt: Date.now() + 3_600_000,
          subscriptionType: "max",
        },
      }),
    );
    const auth = new AuthManager({
      pi: new PiAuthStore(join(dir, "missing-pi-auth.json")),
      claudeCode: new ClaudeCodeAuthStore({
        file: claudeFile,
        cacheFile: join(dir, "cache.json"),
        readKeychain: false,
      }),
    });
    await auth.init();
    assert.equal(auth.info().mode, "subscription");
    await assert.rejects(() => auth.setMode("api-key"), /No Anthropic API key/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
